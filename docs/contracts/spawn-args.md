# Spawn arguments — frozen wire contract

**Pinned to:** `claude` 2.1.226 / Agent SDK 0.3.226 (the named oracle).
**Re-pinned 2026-08-31 to `claude` 2.1.252** via the native bridge
(paid capture, `.local/evidence/2026-08-31-s3/`): the Pipe argv below
accepted verbatim; `--permission-mode bypassPermissions` runs hosted
tools without a callback (permissionMode echoed in init); the pinned
stdin user frame accepted. `--effort` not re-exercised this pass.
**Provenance:** direct read of `.local/reference/agent-sdk-0.3.226/sdk.mjs` (the owner's
untracked evidence surround)
(argv construction; `CLAUDE_CODE_ENTRYPOINT` handling at offsets ~779900,
~1133443) plus the characterization captures, 2026-08-09 — raw records in
`.local/artifacts/characterization-2026-08-09/`. Only a ratified re-pin moves
this file.

## Base argument set (always, in this order)

```
--output-format stream-json --verbose --input-format stream-json
```

## Conditional flags (this library's pinned order; the CLI accepts any order)

| Flag | When | Semantics |
|---|---|---|
| `--model <m>` | `Options.Model != ""` | Model alias or full name; `haiku` accepted. |
| `--tools <csv>` | `BuiltinTools != nil` | Two argv elements (oracle form). Tri-state: nil → flag **omitted entirely** (CLI default set); empty slice → `--tools ""` (no builtins). The oracle also emits `--tools default` for a non-array value; this library never emits that form (pinned: the empty and omitted forms cover every caller intent). |
| `--mcp-config <json>` | **external** servers configured | Raw `{"mcpServers":{...}}` object as one argument. In-process `sdk` servers never appear here — the oracle strips instances out of argv and declares them via `initialize.sdkMcpServers` (sdk.mjs @1134155). |
| `--setting-sources=<csv>` | `SettingSources != nil` | **One argv element, `=` form** (oracle: `--setting-sources=${csv}`). Same tri-state; empty slice → `--setting-sources=`. |
| `--strict-mcp-config` | `StrictMCPConfig` | Only the given servers; no user/project MCP config. Emitted independently of `--mcp-config` presence (oracle behaviour). |
| `--permission-mode <mode>` | `PermissionMode != ""` | See permission-mode note below. |
| `--effort <level>` | `Effort != ""` | Reasoning effort for the session: `low`, `medium`, `high`, `xhigh`, `max`. **Not an oracle flag** — the pinned SDK never emits it; characterized from `claude --help` (2.1.226), where it is documented as scoped to "the current session", so a change requires a new session rather than a mid-session control request. Validated before spawn (`ErrUnknownEffort`); `""` omits the flag and leaves the CLI's own default. |
| `--include-partial-messages` | requested | Emits `stream_event` frames. |
| `--max-turns <n>` | `MaxTurns > 0` | |
| `--permission-prompt-tool stdio` | a permission callback is registered | CLI sends `can_use_tool` control requests instead of deciding itself. |

## Verbatim capture invocations (evidence)

Leg A (direct; `CLAUDE_CODE_ENTRYPOINT` unset), one paid Haiku session,
2026-08-09, this argv verbatim (recorded in `leg_a.raw.jsonl` line 1):

```
claude --output-format stream-json --verbose --input-format stream-json \
  --include-partial-messages --model haiku --tools "" --setting-sources "" \
  --mcp-config '{"mcpServers": {"codemode": {"command": "node", "args": [".../nulltool.js"]}}}' \
  --strict-mcp-config --permission-mode dontAsk
```

Leg B (SDK 0.3.226 driving the same binary through a tee shim;
`node leg_b.mjs` in `.local/spikes/capture-2026-08-09/`): SDK options
`{model: "haiku", tools: [], settingSources: [], permissionMode: "default",
canUseTool, includePartialMessages: true, mcpServers: {calc: <sdk>}}`.
Raw stdio both directions in `leg_b.stdin.raw` / `leg_b.stdout.raw`.

## Environment

- The SDK sets `CLAUDE_CODE_ENTRYPOINT=sdk-ts` (and
  `CLAUDE_AGENT_SDK_VERSION=0.3.226`) when unset. This library leaves both
  unset (I2: never misrepresent the client; honest absence was the ruled
  choice). Characterized diff: the `system/init` frames from
  the unset run and the sdk-ts run are structurally identical — same key
  set, same `capabilities`, same `apiKeySource` — differing only in
  per-session values. No material behaviour diff observed.
- `Options.CaptureDir` sets `ANTHROPIC_BASE_URL` to a loopback proxy
  (`internal/wiretap`) that records each request and forwards to the base
  URL the environment already carried (default `https://api.anthropic.com`).
  Characterized 2.1.241: subscription OAuth rides through unchanged, and
  the CLI sends a `HEAD /api/hello` probe before the first `POST
  /v1/messages`. Off by default; the child env is otherwise untouched.

## Permission-mode semantics (characterized, load-bearing)

`--permission-mode dontAsk` **denies** tool calls without asking:
leg A's tool-call turn produced `system/permission_denied` with
`decision_reason_type: "mode"` and a denial `tool_result`, and the model
never ran the tool. A session whose tools must actually execute needs
either `bypassPermissions` or a registered permission callback answering
`can_use_tool` (leg B used the callback; the call succeeded).

## Stdin user frame (pinned)

```json
{"type":"user","session_id":"","message":{"role":"user","content":[{"type":"text","text":"..."}]},"parent_tool_use_id":null}
```

Observed accepted verbatim in both legs.
