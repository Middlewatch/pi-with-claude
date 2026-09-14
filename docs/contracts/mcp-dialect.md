# Hosted-tool MCP dialect: frozen wire contract

**Pinned to:** `claude` 2.1.270, re-characterized 2026-09-13 through the
native bridge with zero drift: the CLI still offers protocol version
`2025-11-25` (clientInfo version 2.1.270), the same handshake, and the
same `_meta` stamping (`claudecode/toolUseId` plus `progressToken`).

**Pin history.** The observed wire rather than a spec reading: first
characterized 2026-08-09 against `claude` 2.1.226 driven by Agent SDK
0.3.226 (`fixtures/mcp-dialect-turn.jsonl`, byte-verbatim in both
directions). Re-pinned 2026-08-31 to 2.1.252 through the native bridge:
the CLI still offered `2025-11-25` (clientInfo version 2.1.252), accepted
this extension's answers, and stamped `claudecode/toolUseId` into
`tools/call` `_meta`. Re-pinned 2026-09-01 to 2.1.258, 2026-09-10 to
2.1.267, and 2026-09-13 to 2.1.270, each with zero drift (clientInfo
version tracking the CLI). Only a ratified re-pin moves this file.

## Protocol version

The CLI's `initialize` offers `2025-11-25`
(`clientInfo: {"name":"claude-code","version":"2.1.226",...}` at the
first pin) and the SDK oracle answers `2025-11-25`, which this extension
mirrors. An earlier probe's external server answered the legacy
`2024-11-05` and was also accepted, so the CLI tolerates both.

## Transport

Every message rides a `control_request` of subtype `mcp_message`
(`server_name`, `message` = JSON-RPC object) and is answered with a
success `control_response` whose payload is
`{"mcp_response": <JSONRPCResponse>}` (`contracts/control-channel.md`).

## Exchanges (captured, in wire order)

1. `initialize` (id 0) is answered with
   `{"protocolVersion":"2025-11-25","capabilities":{"tools":{"listChanged":true}},"serverInfo":{"name":<server>,"version":"1.0.0"}}`.
2. `notifications/initialized` (no id) is a JSON-RPC notification,
   answered `{"mcp_response":{"jsonrpc":"2.0","result":{},"id":0}}`
   verbatim (oracle behaviour; this extension answers every notification
   that way).
3. `tools/list` (id 1) is answered with `{"tools":[{name, description,
   inputSchema, execution:{"taskSupport":"forbidden"}}]}`. `inputSchema`
   is Pi's tool schema object, serialized with the envelope and never
   rewritten. `execution.taskSupport: "forbidden"` mirrors the
   oracle's captured answer for sdk tools.
4. `tools/call` (id 2; `params.name`, `params.arguments`, and `_meta`
   with `claudecode/toolUseId` and `progressToken`) is answered with
   `{"content": <MCP content array>}`, plus `"isError": true` when the
   handler failed (a handler error is a result, never a session
   failure). The CLI sends one `tools/call` at a time: the next goes out
   only after the previous result, while the model's later `tool_use`
   blocks keep streaming (`contracts/events.md`, timing facts).

## Error behaviour

- Unknown tool name in `tools/call`: JSON-RPC error `-32602`.
- Unknown method with an id: JSON-RPC error `-32601`, never silence.
- Cancelled call (`control_cancel_request`): the exchange fails at the
  control layer with an error `control_response` rather than as a tool
  result.
