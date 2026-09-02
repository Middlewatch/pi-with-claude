#!/usr/bin/env python3
"""fake_claude.py — the gate's scripted claude.

The client on the other end of the wire is the native bridge
(src/bridge.ts). Dialect drift found while characterizing the real CLI
is fixed here against a fresh capture (fixtures/README.md).

Replays frames characterized from the real `claude` (2.1.226 base set,
2.1.258 additions) so the extension under test sees the real wire with
no token spent and no `claude` installed. The extension never
special-cases this script: the bridge's
claudePath option points straight at it and it is spawned with the
real argv.

Wire behaviour, matching the characterization:
  - nothing is emitted before input;
  - the initialize control request must arrive before any user frame and
    is validated against contracts/control-channel.md — a malformed frame
    is a library bug and kills the fake loudly (exit 2);
  - each user frame triggers a replay of the whole fixture segment
    (system/init first — the real CLI re-emits init per user message);
  - stdin EOF is a clean exit.

Init-frame fidelity: when the spawn argv carries --tools, replayed
system/init frames advertise what a faithful claude would — the builtin
csv, plus the fixture's mcp__ names when the session declared
sdkMcpServers — instead of the fixture's captured set. Without --tools
(harness profile) the fixture replays verbatim.

Mutation modes (assertion drills; a harness drives them through a
wrapper script since the library owns the real argv):
  --advertise-extra-tool   init frames advertise a phantom tool
  --apikey-source <v>      init frames report apiKeySource=<v>

Environment knobs (all optional, set by harnesses):
  FAKE_CLAUDE_FIXTURE  fixture file to replay; default fixtures/turn-deltas.jsonl
  FAKE_CLAUDE_LOG      log file: first line
                       {"fake_argv": [...], "fake_config_dir": <str|null>},
                       then every stdin line received, verbatim
  FAKE_CLAUDE_INJECT   frames file injected mid-stream after each segment's
                       first frame (the I4 tolerance drill)
  FAKE_CLAUDE_HOLD_AFTER=N
                       replay only N frames of each segment, then park the
                       turn until an interrupt control request arrives; the
                       interrupt is acked with the characterized receipt
                       and the turn ends with the captured interrupted tail
                       (fixtures/interrupt-turn.jsonl cli frames)
  FAKE_CLAUDE_CALL_DELAY_MS=N
                       sleep N ms before dispatching each tools/call, so
                       the frames replayed ahead of it reach the client
                       as their own chunk first. The real CLI has this
                       gap between a block's assistant frame and its
                       dispatch, and later blocks stream into it (claude
                       2.1.258, characterized 2026-09-02)
"""

import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_FIXTURE = os.path.join(HERE, os.pardir, "fixtures", "turn-deltas.jsonl")
DEFAULT_TOOL_FIXTURE = os.path.join(HERE, os.pardir, "fixtures", "tool-call-turn.jsonl")


def load_frames(path):
    with open(path, encoding="utf-8") as f:
        return [line.strip() for line in f if line.strip()]


def replay_frames(default):
    frames = load_frames(os.environ.get("FAKE_CLAUDE_FIXTURE", default))
    inject = os.environ.get("FAKE_CLAUDE_INJECT")
    if inject:
        frames = frames[:1] + load_frames(inject) + frames[1:]
    return frames


def die(msg):
    print(f"fake_claude: {msg}", file=sys.stderr)
    sys.exit(2)


def validate_initialize(req):
    """Contract shape (contracts/control-channel.md): optional systemPrompt
    string array, optional appendSystemPrompt string, optional
    sdkMcpServers string array. Refuse to proceed on a malformed frame."""
    sp = req.get("systemPrompt")
    if sp is not None and not (isinstance(sp, list) and all(isinstance(x, str) for x in sp)):
        die(f"initialize.systemPrompt must be a string array, got {sp!r}")
    asp = req.get("appendSystemPrompt")
    if asp is not None and not isinstance(asp, str):
        die(f"initialize.appendSystemPrompt must be a string, got {asp!r}")
    srv = req.get("sdkMcpServers")
    if srv is not None and not (isinstance(srv, list) and all(isinstance(x, str) for x in srv)):
        die(f"initialize.sdkMcpServers must be a string array, got {srv!r}")


def interrupted_tail():
    """The captured post-interrupt frames: the user interrupt notice and
    the error result, from the directional interrupt fixture (leg A)."""
    path = os.path.join(HERE, os.pardir, "fixtures", "interrupt-turn.jsonl")
    tail = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            entry = json.loads(line)
            if entry["dir"] == "cli" and entry["frame"].get("type") in ("user", "result"):
                tail.append(json.dumps(entry["frame"]))
    return tail


def control_success(request_id, payload):
    print(json.dumps({"type": "control_response", "response": {
        "subtype": "success", "request_id": request_id, "response": payload}}), flush=True)


def control_error(request_id, message):
    print(json.dumps({"type": "control_response", "response": {
        "subtype": "error", "request_id": request_id, "error": message}}), flush=True)


def parse_own_flags(argv):
    """Mutation flags and the --tools value, from the real spawn argv."""
    flags = {"extra_tool": False, "apikey_source": None, "builtins": None}
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg == "--advertise-extra-tool":
            flags["extra_tool"] = True
        elif arg == "--apikey-source" and i + 1 < len(argv):
            flags["apikey_source"] = argv[i + 1]
            i += 1
        elif arg == "--tools" and i + 1 < len(argv):
            flags["builtins"] = [t for t in argv[i + 1].split(",") if t]
            i += 1
        i += 1
    return flags


def rewrite_init(frame_line, flags, hosted_wire_names):
    """Apply fidelity + mutations to a replayed system/init frame: a
    faithful claude advertises the builtin csv plus the hosted tools it
    learned from tools/list."""
    frame = json.loads(frame_line)
    if frame.get("type") != "system" or frame.get("subtype") != "init":
        return frame_line
    if flags["builtins"] is not None:
        frame["tools"] = flags["builtins"] + hosted_wire_names
    elif hosted_wire_names:
        frame["tools"] = [t for t in frame.get("tools", []) if not t.startswith("mcp__")] + hosted_wire_names
    if flags["extra_tool"]:
        frame["tools"] = frame.get("tools", []) + ["mcp__phantom__not_requested"]
    if flags["apikey_source"] is not None:
        frame["apiKeySource"] = flags["apikey_source"]
    return json.dumps(frame)


class ControlIO:
    """Reads stdin with logging; runs mcp_message exchanges and validates
    the library's answers against contracts/mcp-dialect.md."""

    def __init__(self, log_path):
        self.log_path = log_path
        self.seq = 0

    def read_frame(self):
        line = sys.stdin.readline()
        if not line:
            return None
        line = line.strip()
        if not line:
            return self.read_frame()
        if self.log_path:
            with open(self.log_path, "a", encoding="utf-8") as log:
                log.write(line + "\n")
        return json.loads(line)

    def mcp_exchange(self, server, message):
        """Send one mcp_message control request; await + validate the
        {"mcp_response": ...} answer. Returns the mcp_response object."""
        self.seq += 1
        request_id = f"fake-mcp-{self.seq}"
        print(json.dumps({"type": "control_request", "request_id": request_id,
                          "request": {"subtype": "mcp_message", "server_name": server,
                                      "message": message}}), flush=True)
        while True:
            frame = self.read_frame()
            if frame is None:
                die(f"stream ended awaiting control_response for {request_id}")
            if frame.get("type") != "control_response":
                die(f"expected control_response for {request_id}, got {json.dumps(frame)[:150]}")
            resp = frame.get("response", {})
            if resp.get("request_id") != request_id:
                continue  # a response to something else; tolerate ordering
            if resp.get("subtype") != "success":
                die(f"mcp exchange failed: {json.dumps(resp)[:200]}")
            mcp = resp.get("response", {}).get("mcp_response")
            if not isinstance(mcp, dict) or mcp.get("jsonrpc") != "2.0":
                die(f"mcp_response missing or malformed: {json.dumps(resp)[:200]}")
            if message.get("id") is not None and mcp.get("id") != message.get("id"):
                die(f"mcp_response id {mcp.get('id')!r} != request id {message.get('id')!r}")
            if "result" not in mcp:
                die(f"mcp_response carries no result: {json.dumps(mcp)[:200]}")
            return mcp

    def can_use_tool_exchange(self, wire_name, arguments):
        """Send the captured-shape can_use_tool request; validate the
        decision answer. Returns (allowed, updated_arguments)."""
        self.seq += 1
        request_id = f"fake-perm-{self.seq}"
        print(json.dumps({"type": "control_request", "request_id": request_id,
                          "request": {"subtype": "can_use_tool",
                                      "tool_name": wire_name,
                                      "display_name": wire_name.split("__")[-1].title(),
                                      "input": arguments,
                                      "permission_suggestions": [],
                                      "tool_use_id": f"toolu_fake_{self.seq}"}}), flush=True)
        while True:
            frame = self.read_frame()
            if frame is None:
                die(f"stream ended awaiting can_use_tool answer {request_id}")
            if frame.get("type") != "control_response":
                die(f"expected control_response for {request_id}, got {json.dumps(frame)[:150]}")
            resp = frame.get("response", {})
            if resp.get("request_id") != request_id:
                continue
            if resp.get("subtype") != "success":
                die(f"can_use_tool answered with error: {json.dumps(resp)[:200]}")
            decision = resp.get("response", {})
            behavior = decision.get("behavior")
            if behavior == "allow":
                if "updatedInput" not in decision:
                    die(f"allow decision lacks updatedInput: {json.dumps(decision)[:200]}")
                return True, decision["updatedInput"]
            if behavior == "deny":
                if not isinstance(decision.get("message"), str):
                    die(f"deny decision lacks message: {json.dumps(decision)[:200]}")
                return False, None
            die(f"decision behavior {behavior!r} is neither allow nor deny")

    def handshake(self, server):
        """The characterized dialect (2025-11-25): initialize →
        notifications/initialized → tools/list. Returns plain tool names."""
        init = self.mcp_exchange(server, {
            "method": "initialize",
            "params": {"protocolVersion": "2025-11-25", "capabilities": {},
                       "clientInfo": {"name": "claude-code", "title": "Claude Code",
                                      "version": "2.1.226"}},
            "jsonrpc": "2.0", "id": 0})
        if "protocolVersion" not in init.get("result", {}):
            die(f"initialize result lacks protocolVersion: {json.dumps(init)[:200]}")
        ack = self.mcp_exchange(server, {"method": "notifications/initialized", "jsonrpc": "2.0"})
        if ack != {"jsonrpc": "2.0", "result": {}, "id": 0}:
            die(f"notification ack is not the pinned shape: {json.dumps(ack)[:200]}")
        listing = self.mcp_exchange(server, {"method": "tools/list", "jsonrpc": "2.0", "id": 1})
        names = [t.get("name") for t in listing.get("result", {}).get("tools", [])]
        if not names or not all(isinstance(n, str) and n for n in names):
            die(f"tools/list returned no usable tools: {json.dumps(listing)[:250]}")
        for tool in listing["result"]["tools"]:
            if "inputSchema" not in tool:
                die(f"tools/list entry lacks inputSchema: {json.dumps(tool)[:200]}")
        return names


def replay_segment(io, frames, flags, hosted, server, argv, hold_after):
    """Replay one turn segment. Returns True when the turn is parked
    awaiting an interrupt (FAKE_CLAUDE_HOLD_AFTER)."""
    printed = 0
    state = {}
    for out in frames:
        frame = json.loads(out)
        if not isinstance(frame, dict):
            # A scalar line (injected hostile input) replays verbatim.
            print(out, flush=True)
            printed += 1
            continue
        if frame.get("type") == "control_request":
            req = frame.get("request", {})
            subtype = req.get("subtype")
            message = req.get("message", {})
            if subtype == "can_use_tool" and server and "--permission-prompt-tool" in argv:
                allowed, updated = io.can_use_tool_exchange(
                    hosted["wire"][0], {"text": "tool drill"})
                state["permission"] = (allowed, updated)
                continue
            if subtype == "mcp_message" and message.get("method") == "tools/call" and server:
                allowed, updated = state.get("permission", (True, None))
                if not allowed:
                    continue  # a faithful claude never calls a denied tool
                call = {"method": "tools/call",
                        "params": {"name": hosted["plain"][0],
                                   "arguments": updated if updated is not None else {"text": "tool drill"},
                                   "_meta": message.get("params", {}).get("_meta", {})},
                        "jsonrpc": "2.0", "id": message.get("id", 2)}
                delay_ms = int(os.environ.get("FAKE_CLAUDE_CALL_DELAY_MS", "0"))
                if delay_ms:
                    time.sleep(delay_ms / 1000)
                io.mcp_exchange(server, call)
            continue
        line = rewrite_init(out, flags, hosted["wire"])
        print(line, flush=True)
        printed += 1
        if hold_after and printed == hold_after:
            return True
    return False


def auth_status():
    """`claude auth status --json` for account discovery: signed in as
    <dirname>@fake unless the config dir holds a `logged-out` marker.
    FAKE_CLAUDE_AUTH_DELAY_MS sleeps first, so a test can show that
    probes over several dirs run concurrently."""
    delay_ms = int(os.environ.get("FAKE_CLAUDE_AUTH_DELAY_MS", "0"))
    if delay_ms:
        time.sleep(delay_ms / 1000)
    config_dir = os.environ.get("CLAUDE_CONFIG_DIR", "")
    if os.path.exists(os.path.join(config_dir, "logged-out")):
        print(json.dumps({"loggedIn": False}))
    else:
        name = os.path.basename(config_dir.rstrip("/"))
        print(json.dumps({"loggedIn": True, "email": f"{name}@fake", "subscriptionType": "max"}))
    return 0


def main():
    if sys.argv[1:] == ["auth", "status", "--json"]:
        return auth_status()
    flags = parse_own_flags(sys.argv[1:])
    log_path = os.environ.get("FAKE_CLAUDE_LOG")
    if log_path:
        with open(log_path, "a", encoding="utf-8") as log:
            log.write(json.dumps({
                "fake_argv": sys.argv[1:],
                # Account routing is environmental, not argv: the harness
                # asserts which config dir reached this child.
                "fake_config_dir": os.environ.get("CLAUDE_CONFIG_DIR"),
                "fake_base_url": os.environ.get("ANTHROPIC_BASE_URL"),
            }) + "\n")

    io = ControlIO(log_path)
    hold_after = int(os.environ.get("FAKE_CLAUDE_HOLD_AFTER", "0"))
    initialized = False
    holding = False  # a turn is parked awaiting interrupt
    sdk_servers = []
    hosted = {"plain": [], "wire": []}  # learned from tools/list
    handshook = False
    frames = None

    while True:
        frame = io.read_frame()
        if frame is None:
            return 0
        ftype = frame.get("type")

        if ftype == "control_request":
            req = frame.get("request", {})
            if req.get("subtype") == "initialize":
                validate_initialize(req)
                initialized = True
                sdk_servers = req.get("sdkMcpServers") or []
                control_success(frame["request_id"], {"commands": [], "models": [],
                                                      "current_permission_mode": "default"})
            elif req.get("subtype") == "get_context_usage":
                # Shape per the oracle typings (SDKControlGetContextUsage-
                # Response). The maxTokens/rawMaxTokens pair below is the
                # real CLI's answer for the `haiku` alias, confirmed against
                # claude 2.1.226 on 2026-08-10 (untracked evidence record
                # .local/artifacts/context-window-2026-08-10.md).
                # totalTokens, percentage and categories stay
                # scripted: they depend on the caller's own prompt and
                # settings, so no fixed capture would be truthful.
                control_success(frame["request_id"], {
                    "totalTokens": 869, "maxTokens": 200000, "rawMaxTokens": 200000,
                    "percentage": 0.4,
                    "categories": [{"name": "system", "tokens": 869, "color": "gray"}],
                    "model": "claude-haiku-4-5-20251001"})
            elif req.get("subtype") == "interrupt" and holding:
                # Characterized shape: receipt ack, then the captured
                # interrupt notice and error result end the parked turn.
                control_success(frame["request_id"], {"still_queued": []})
                for out in interrupted_tail():
                    print(out, flush=True)
                holding = False
            else:
                control_error(frame["request_id"], f"fake_claude has no script for subtype {req.get('subtype')!r}")
            continue
        if ftype == "control_response":
            continue  # stray answers; exchanges consume theirs inline
        if ftype != "user":
            continue

        if not initialized:
            die("user frame before initialize — the library must initialize at spawn")
        if holding:
            die("user frame while a held turn awaits interrupt")

        if sdk_servers and not handshook:
            # Characterized order: the CLI handshakes sdk servers after the
            # first user frame, before emitting init (fixtures/
            # mcp-dialect-turn.jsonl + tool-call-turn.jsonl).
            server = sdk_servers[0]
            names = io.handshake(server)
            hosted = {"plain": names, "wire": [f"mcp__{server}__{n}" for n in names]}
            handshook = True

        if frames is None:
            default = DEFAULT_TOOL_FIXTURE if sdk_servers else DEFAULT_FIXTURE
            frames = replay_frames(default)

        holding = replay_segment(io, frames, flags, hosted,
                                 sdk_servers[0] if sdk_servers else None,
                                 sys.argv[1:], hold_after)
    return 0


if __name__ == "__main__":
    sys.exit(main())
