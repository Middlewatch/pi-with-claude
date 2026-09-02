// The native stream-json bridge: one spawned `claude` child driven over
// bidirectional stream-json, per docs/contracts/. The bridge owns the
// process and the wire: spawn argv (spawn-args.md), the control channel
// (control-channel.md), the in-process MCP dialect (mcp-dialect.md), and
// the tolerant read pump (events.md I4). Everything above it — the
// mirror, the restart taxonomy, tool parking — lives in extension.ts and
// reads decoded frames from `read()` exactly as it read SDK messages.
//
// No identity declaration of any kind is made (I2, honest absence):
// CLAUDE_CODE_ENTRYPOINT is never set, and the child env is the parent's
// plus only what the caller passes (account routing, I1: the variable,
// never a credential).

import { spawn, type ChildProcess } from "node:child_process";
import { MCP_SERVER } from "./projection.ts";

type Json = any;

// One hosted tool call parked on a promise the host resolves with the
// real result. The CLI stamps the model's tool_use id into _meta
// ("claudecode/toolUseId", characterized in
// fixtures/tool-call-turn.jsonl); null when a future release drops it
// and the caller falls back to name binding.
export type ToolCallRequest = {
  toolUseId: string | null;
  name: string;
  input: Json;
  resolve: (result: { content: Json[]; isError?: boolean }) => void;
  reject: (error: Error) => void;
};

// Neutral tool descriptor (projection.ts projectTools shape): the
// schema passes through to tools/list untouched.
export type BridgeTool = { name: string; description?: string; input_schema: Json };

export type BridgeOptions = {
  model: string;
  systemPrompt: string;
  effort: string; // "" leaves the CLI default (spawn-args.md)
  tools: BridgeTool[];
  onToolCall?: (req: ToolCallRequest) => void;
  env?: Record<string, string>; // extra vars over the parent env
  claudePath?: string; // default: $PI_WITH_CLAUDE_CLAUDE, else `claude` from PATH
};

// The child argv after the binary, per docs/contracts/spawn-args.md: the
// pinned base set, then conditional flags in the contract's pinned
// order. The posture is the characterized Pipe profile: no
// builtin tools, no setting sources, strict MCP config, and
// bypassPermissions — dontAsk denies without asking, and Pi owns all
// gating, so there is nothing for the CLI's permission layer to do.
// In-process tools never touch argv; they ride initialize.sdkMcpServers.
export function buildArgs(o: { model: string; effort: string }): string[] {
  const args = ["--output-format", "stream-json", "--verbose", "--input-format", "stream-json"];
  if (o.model) args.push("--model", o.model);
  args.push("--tools", "");
  args.push("--setting-sources=");
  args.push("--strict-mcp-config");
  args.push("--permission-mode", "bypassPermissions");
  if (o.effort) args.push("--effort", o.effort);
  args.push("--include-partial-messages");
  return args;
}

// What the SDK oracle answered the CLI's initialize offer at the pinned
// characterization (docs/contracts/mcp-dialect.md).
const MCP_PROTOCOL_VERSION = "2025-11-25";

// makeMcpHandler answers one mcp_message JSON-RPC message for the hosted
// server (the toolhost port). The return value is the complete
// JSONRPCResponse for the control channel's {"mcp_response": ...}
// payload. A notification gets the pinned {"jsonrpc":"2.0","result":{},
// "id":0} acknowledgement. Handler failures are NOT errors — they flow
// back as error-flagged results; only a rejected park (cancellation,
// teardown) escapes as a control-layer error.
export function makeMcpHandler(tools: BridgeTool[], onCall: (req: ToolCallRequest) => void) {
  const byName = new Map(tools.map((t) => [t.name, t]));
  return async (msg: Json): Promise<Json> => {
    const id = msg?.id;
    if (id === undefined || id === null) return { jsonrpc: "2.0", result: {}, id: 0 };
    switch (msg.method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: true } },
            serverInfo: { name: MCP_SERVER, version: "1.0.0" },
          },
        };
      case "tools/list":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            tools: tools.map((t) => ({
              name: t.name,
              description: t.description ?? "",
              inputSchema: t.input_schema,
              // The oracle marks every sdk tool task-forbidden
              // (captured tools/list answer); mirrored verbatim.
              execution: { taskSupport: "forbidden" },
            })),
          },
        };
      case "tools/call": {
        const params = msg.params ?? {};
        if (!byName.has(params.name)) {
          return { jsonrpc: "2.0", id, error: { code: -32602, message: `unknown tool: ${params.name}` } };
        }
        const result = await new Promise<{ content: Json[]; isError?: boolean }>((resolve, reject) =>
          onCall({
            toolUseId: params._meta?.["claudecode/toolUseId"] ?? null,
            name: params.name,
            input: params.arguments ?? {},
            resolve,
            reject,
          }),
        );
        return {
          jsonrpc: "2.0",
          id,
          result: { content: result.content, ...(result.isError ? { isError: true } : {}) },
        };
      }
    }
    return { jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${msg.method}` } };
  };
}

// The oracle's graduated teardown timings (sdk.mjs v0.3.226): end
// stdin, wait for a clean exit, SIGTERM, wait, SIGKILL.
const CLOSE_STDIN_GRACE_MS = 2000;
const CLOSE_KILL_GRACE_MS = 5000;
const INITIALIZE_TIMEOUT_MS = 30000; // the real CLI answers in <20 ms

// The --effort levels the pinned CLI accepts (spawn-args.md); "" leaves
// the CLI default. Validated before spawn: an unknown level is a caller
// bug worth catching here, not a child exiting with a usage error.
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];

export class Bridge {
  // Resolves when the initialize control exchange completed; a failure
  // is fatal to the session and also surfaces as __closed on read().
  readonly initialized: Promise<void>;

  private child: ChildProcess;
  private closed = false;
  private lineBuf = "";
  private stderrTail = "";

  // Decoded event frames in wire order, one FIFO the turn loop reads
  // from; the stream ending answers every present and future read with
  // __closed so no turn can hang on a spent stream.
  private msgs: Json[] = [];
  private waiters: ((m: Json) => void)[] = [];
  private streamEnd: Json | null = null;

  // Control requests we sent, awaiting their responses (correlation is
  // by id, never order).
  private seq = 0;
  private readonly idBase = `pi-${Math.random().toString(16).slice(2, 10)}`;
  private pending = new Map<string, { resolve: (r: Json) => void; reject: (e: Error) => void }>();

  // Incoming control requests being handled; control_cancel_request
  // settles one early with an error response and drops its late answer.
  private inflight = new Map<string, () => void>();

  private mcp: ((msg: Json) => Promise<Json>) | null;

  constructor(opts: BridgeOptions) {
    if (opts.effort && !EFFORT_LEVELS.includes(opts.effort)) {
      throw new Error(
        `pi-with-claude bridge: unknown effort ${JSON.stringify(opts.effort)} (want one of ${EFFORT_LEVELS.join(", ")}, or "")`,
      );
    }
    this.mcp =
      opts.tools.length > 0 && opts.onToolCall ? makeMcpHandler(opts.tools, opts.onToolCall) : null;

    const path = opts.claudePath ?? process.env.PI_WITH_CLAUDE_CLAUDE ?? "claude";
    this.child = spawn(path, buildArgs(opts), {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...(opts.env ?? {}) },
    });
    // The child never holds the host's event loop open between turns
    // (Pi's -p mode ends when the loop drains; stdin EOF is the CLI's
    // own close signal). ref()/unref() re-arm stdout only while a turn
    // is in flight. Stdio pipes are Socket at runtime (ref/unref
    // exist); the Writable/Readable typings just don't carry them.
    this.child.unref();
    (this.child.stdin as Json)?.unref?.();
    (this.child.stdout as Json)?.unref?.();
    (this.child.stderr as Json)?.unref?.();
    this.child.stdin!.on("error", () => {}); // EPIPE surfaces via the close event, not a throw

    this.child.stdout!.setEncoding("utf8");
    this.child.stdout!.on("data", (chunk: string) => this.pump(chunk));
    this.child.stderr!.setEncoding("utf8");
    this.child.stderr!.on("data", (chunk: string) => {
      if (this.stderrTail.length < 4096) this.stderrTail += chunk.slice(0, 4096 - this.stderrTail.length);
    });
    this.child.on("error", (e: Error) => this.fatal(`spawning ${path}: ${e.message}`));
    this.child.on("close", (code, signal) => {
      this.pump("\n"); // flush an unterminated final line before the stream ends
      // A signal exit during our own teardown is a successful close.
      const failed = !this.closed && code !== 0;
      const detail = signal ? `signal ${signal}` : `exit ${code}`;
      this.settle(
        failed ? `claude exited (${detail})${this.stderrTail ? `; stderr: ${this.stderrTail.trim()}` : ""}` : undefined,
      );
    });

    // The initialize exchange (control-channel.md): systemPrompt and
    // sdkMcpServers at spawn — the SDK-oracle path. Frames are ordered
    // on the pipe, so pushUser needs no await; the response is awaited
    // only to surface a refusal or a wedged child as a fatal.
    const params: Json = {};
    if (opts.systemPrompt) params.systemPrompt = [opts.systemPrompt];
    if (this.mcp) params.sdkMcpServers = [MCP_SERVER];
    this.initialized = this.request("initialize", params).then(() => {});
    const deadline = setTimeout(
      () => this.fatal(`initialize unanswered after ${INITIALIZE_TIMEOUT_MS} ms`),
      INITIALIZE_TIMEOUT_MS,
    );
    deadline.unref?.();
    this.initialized.then(
      () => clearTimeout(deadline),
      (e) => {
        clearTimeout(deadline);
        if (!this.closed) this.fatal(`initialize: ${e.message}`);
      },
    );
  }

  // ------------------------------------------------------------------
  // The read pump: NDJSON lines off stdout, control frames routed to
  // the channel, everything else — including unknown types and non-JSON
  // — delivered or dropped without ever erroring (events.md I4).

  private pump(chunk: string) {
    this.lineBuf += chunk;
    const lines = this.lineBuf.split("\n");
    this.lineBuf = lines.pop()!;
    for (let line of lines) {
      line = line.trim();
      if (!line) continue;
      let frame: Json;
      try {
        frame = JSON.parse(line);
      } catch {
        continue; // non-JSON output is tolerated, never an error
      }
      // A bare JSON scalar or null is not a frame; routing it would
      // throw inside the stdout listener and take the host down.
      if (frame === null || typeof frame !== "object") continue;
      if (!this.handleControl(frame)) this.deliver(frame);
    }
  }

  // deliver queues one frame for read(); public so the host can inject
  // its own wake frames into the same FIFO (extension.ts __tool_parked).
  deliver(frame: Json) {
    const w = this.waiters.shift();
    if (w) w(frame);
    else this.msgs.push(frame);
  }

  read(): Promise<Json> {
    const m = this.msgs.shift();
    if (m !== undefined) return Promise.resolve(m);
    if (this.streamEnd) return Promise.resolve(this.streamEnd);
    return new Promise((r) => this.waiters.push(r));
  }

  // ------------------------------------------------------------------
  // Control channel (control-channel.md).

  private handleControl(frame: Json): boolean {
    switch (frame.type) {
      case "control_response": {
        const resp = frame.response ?? {};
        const p = this.pending.get(resp.request_id);
        if (p) {
          this.pending.delete(resp.request_id);
          if (resp.subtype === "success") p.resolve(resp.response ?? {});
          else p.reject(new Error(resp.error || `control request failed (subtype ${JSON.stringify(resp.subtype)})`));
        }
        return true;
      }
      case "control_request":
        this.dispatch(frame.request_id, frame.request ?? {});
        return true;
      case "control_cancel_request":
        this.inflight.get(frame.request_id)?.();
        return true;
      case "keep_alive":
        return true;
    }
    return false;
  }

  private request(subtype: string, params: Json): Promise<Json> {
    if (this.streamEnd || this.closed) {
      return Promise.reject(new Error(this.streamEnd?.error ?? "bridge closed"));
    }
    const id = `${this.idBase}-${++this.seq}`;
    const frame = { type: "control_request", request_id: id, request: { ...params, subtype } };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      if (!this.writeLine(frame)) {
        this.pending.delete(id);
        reject(new Error(`writing ${subtype} request failed`));
      }
    });
  }

  // dispatch answers one incoming control request. Every subtype gets an
  // answer: an unregistered one gets an error response naming it — the
  // oracle's own behaviour, and load-bearing, because the CLI may add
  // subtypes any release and silence would hang it.
  private dispatch(requestId: string, request: Json) {
    let settled = false;
    const respond = (resp: Json) => {
      if (settled) return;
      settled = true;
      this.inflight.delete(requestId);
      this.writeLine({ type: "control_response", response: { request_id: requestId, ...resp } });
    };
    // Cancellation settles the exchange at the control layer, which is
    // all the wire sees; a tools/call left parked in the host is stale
    // state the restart taxonomy already answers (bridge-v1 §prefix-match).
    this.inflight.set(requestId, () => respond({ subtype: "error", error: "cancelled" }));

    if (request.subtype === "mcp_message" && this.mcp) {
      if (request.server_name !== MCP_SERVER) {
        respond({ subtype: "error", error: `mcp_message for unknown server ${JSON.stringify(request.server_name)}` });
        return;
      }
      this.mcp(request.message).then(
        (mcp_response) => respond({ subtype: "success", response: { mcp_response } }),
        (e: Error) => respond({ subtype: "error", error: e.message }),
      );
      return;
    }
    respond({ subtype: "error", error: `unsupported control request subtype: ${request.subtype}` });
  }

  // Control-channel interrupt of the in-flight turn — never a kill. The
  // ack is a receipt; the interrupted turn still ends with its own error
  // result on the event stream.
  interrupt(): Promise<void> {
    return this.request("interrupt", {}).then(() => {});
  }

  // The CLI's own context occupancy (get_context_usage); null shape
  // risks ride with the caller, which reads totalTokens.
  getContextUsage(): Promise<Json> {
    return this.request("get_context_usage", {});
  }

  // ------------------------------------------------------------------
  // Writes. User frames and control responses share stdin; node stream
  // writes are ordered, so no further serialization is needed.

  private writeLine(frame: Json): boolean {
    if (this.closed || !this.child.stdin?.writable) return false;
    return (this.child.stdin.write(JSON.stringify(frame) + "\n"), true);
  }

  // The pinned stdin user frame (spawn-args.md §Stdin user frame),
  // queued behind the initialize response (the contract's ordering: the
  // exchange completes before any user input). Chaining on one settled
  // promise keeps multiple turns in send order; a failed write on a
  // live child is fatal — a session that cannot be written to must end
  // as __closed, never hang a turn.
  pushUser(content: Json[]) {
    this.initialized.then(
      () => {
        const ok = this.writeLine({
          type: "user",
          session_id: "",
          message: { role: "user", content },
          parent_tool_use_id: null,
        });
        if (!ok && !this.closed) this.fatal("writing user frame failed");
      },
      () => {}, // an initialize failure already went fatal
    );
  }

  // ------------------------------------------------------------------
  // Lifecycle.

  ref() {
    (this.child.stdout as Json)?.ref?.();
  }

  unref() {
    (this.child.stdout as Json)?.unref?.();
  }

  dead(): boolean {
    return this.closed || this.streamEnd !== null || this.child.exitCode !== null;
  }

  // settle ends the stream: every pending and future read answers
  // __closed, pending control requests fail with the evidence.
  private settle(error?: string) {
    if (this.streamEnd) return;
    this.streamEnd = { type: "__closed", ...(error ? { error } : {}) };
    for (const w of this.waiters.splice(0)) w(this.streamEnd);
    const cause = new Error(error ?? "bridge closed");
    for (const p of this.pending.values()) p.reject(cause);
    this.pending.clear();
    // In-flight incoming handlers are settled with their error response
    // (a no-op write on a dead pipe) so nothing lingers past the end.
    for (const cancel of this.inflight.values()) cancel();
    this.inflight.clear();
  }

  private fatal(message: string) {
    this.settle(`pi-with-claude bridge: ${message}`);
    this.close();
  }

  // Graduated teardown per the oracle: stdin EOF → grace → SIGTERM →
  // grace → SIGKILL. Timers are unref'd so a closing bridge never holds
  // the host's event loop; the close event clears them.
  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.child.stdin?.end();
    } catch {}
    const term = setTimeout(() => this.child.kill("SIGTERM"), CLOSE_STDIN_GRACE_MS);
    const kill = setTimeout(() => {
      this.child.kill("SIGKILL");
      // stdout EOF gates the close event and a grandchild can hold the
      // pipe open; destroying our read end unblocks it unconditionally.
      this.child.stdout?.destroy();
    }, CLOSE_STDIN_GRACE_MS + CLOSE_KILL_GRACE_MS);
    term.unref?.();
    kill.unref?.();
    this.child.once("close", () => {
      clearTimeout(term);
      clearTimeout(kill);
      this.settle();
    });
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      clearTimeout(term);
      clearTimeout(kill);
      this.settle();
    }
  }
}
