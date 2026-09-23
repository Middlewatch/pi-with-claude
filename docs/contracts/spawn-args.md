# Spawn arguments: frozen wire contract

**Pinned to:** `claude` 2.1.281, re-characterized 2026-09-23 through the
native bridge with zero drift: the argv below accepted verbatim and
`permissionMode` echoed in init. The floating `--model opus` alias
resolves to `claude-opus-5-5` and `--model fable` to `claude-fable-5-1`.
`--effort` was not re-exercised in any re-pin.

**Pin history.** First characterized 2026-08-09 against `claude` 2.1.226
driven by Agent SDK 0.3.226, from a direct read of the SDK's argv
construction and `CLAUDE_CODE_ENTRYPOINT` handling plus two paid
captures. Re-pinned 2026-08-31 to 2.1.252 through the native bridge: the
argv accepted verbatim, `--permission-mode bypassPermissions` running
hosted tools without a callback, and the pinned stdin user frame
accepted. Re-pinned 2026-09-01 to 2.1.258: zero drift, `fable` began
resolving to `claude-fable-5-1` (2.1.252 resolved it to
`claude-fable-5`). Re-pinned 2026-09-10 to 2.1.267 and 2026-09-13 to
2.1.270, both zero drift. Re-pinned 2026-09-23 to 2.1.281: zero drift,
`opus` began resolving to `claude-opus-5-5` (2.1.270 resolved it to
`claude-opus-5`). Only a ratified re-pin moves this file.

## Base argument set (always, in this order)

```
--output-format stream-json --verbose --input-format stream-json
```

## Conditional flags

The extension emits these in the order below; the CLI accepts any order.
`src/bridge.ts` `buildArgs` is the implementation.

| Flag | When | Semantics |
|---|---|---|
| `--model <m>` | a model is set | Model alias or full name; `haiku` accepted. |
| `--tools ""` | always | Two argv elements (the oracle form). Omitting the flag entirely gives the CLI's default builtin set; the empty string gives no builtins. The oracle also emits `--tools default` for a non-array value, a form this extension never sends. |
| `--setting-sources=` | always | One argv element in `=` form (oracle: `--setting-sources=${csv}`); empty means no setting sources. |
| `--strict-mcp-config` | always | Only the given servers, with no user or project MCP config. Emitted independently of `--mcp-config` presence (oracle behaviour). |
| `--permission-mode bypassPermissions` | always | See the permission-mode note below. |
| `--effort <level>` | an effort is set | Reasoning effort for the session: `low`, `medium`, `high`, `xhigh`, `max`. The pinned SDK never emits this flag; it was characterized from `claude --help` (2.1.226), where it is documented as scoped to "the current session", so a change requires a new session rather than a mid-session control request. Pi's thinking level maps to a level; an absent or unknown level omits the flag and leaves the CLI's own default. |
| `--include-partial-messages` | always | Emits `stream_event` frames. |

Flags the CLI accepts that this extension never emits: `--mcp-config
<json>` (external servers; in-process `sdk` servers never appear in argv,
since the oracle declares them through `initialize.sdkMcpServers`),
`--max-turns <n>`, and `--permission-prompt-tool stdio` (which makes the
CLI send `can_use_tool` control requests instead of deciding itself).

## Verbatim capture invocations (evidence)

Leg A (direct; `CLAUDE_CODE_ENTRYPOINT` unset), one paid Haiku session,
2026-08-09, this argv verbatim:

```
claude --output-format stream-json --verbose --input-format stream-json \
  --include-partial-messages --model haiku --tools "" --setting-sources "" \
  --mcp-config '{"mcpServers": {"codemode": {"command": "node", "args": [".../nulltool.js"]}}}' \
  --strict-mcp-config --permission-mode dontAsk
```

Leg B (SDK 0.3.226 driving the same binary through a tee shim): SDK
options `{model: "haiku", tools: [], settingSources: [], permissionMode:
"default", canUseTool, includePartialMessages: true, mcpServers: {calc:
<sdk>}}`, with raw stdio captured in both directions.

## Environment

The SDK sets `CLAUDE_CODE_ENTRYPOINT=sdk-ts` (and
`CLAUDE_AGENT_SDK_VERSION=0.3.226`) when unset. This extension leaves
both unset (I2: never misrepresent the client; honest absence was the
ruled choice). The characterized diff between the unset run and the
sdk-ts run: the `system/init` frames are structurally identical, with the
same key set, the same `capabilities`, and the same `apiKeySource`,
differing only in per-session values. The child environment is otherwise
the parent's plus `CLAUDE_CONFIG_DIR` when an account is selected.

## Permission-mode semantics (characterized, load-bearing)

`--permission-mode dontAsk` denies tool calls without asking: leg A's
tool-call turn produced `system/permission_denied` with
`decision_reason_type: "mode"` and a denial `tool_result`, and the model
never ran the tool. A session whose tools must actually execute needs
either `bypassPermissions` or a registered permission callback answering
`can_use_tool` (leg B used the callback, and the call succeeded). This
extension uses `bypassPermissions` because Pi owns all gating, so there
is nothing for the CLI's permission layer to do.

## Stdin user frame (pinned)

```json
{"type":"user","session_id":"","message":{"role":"user","content":[{"type":"text","text":"..."}]},"parent_tool_use_id":null}
```

Observed accepted verbatim in both legs.
