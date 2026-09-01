# Hosted-tool MCP dialect — frozen wire contract

**Pinned to:** `claude` 2.1.226 / Agent SDK 0.3.226.
**Provenance:** the observed wire, not a spec reading — the SDK-driven
characterization capture, 2026-08-09 (`fixtures/mcp-dialect-turn.jsonl`, byte-verbatim both
directions; raw in the untracked `.local/artifacts/characterization-2026-08-09/`). Only a
ratified re-pin moves this file.

## Protocol version (contract amendment 2026-08-09)

The CLI's `initialize` offers **`2025-11-25`**
(`clientInfo: {"name":"claude-code","version":"2.1.226",...}`) and the
SDK oracle answers `2025-11-25` — this host mirrors the oracle. The plan
originally pinned the legacy `2024-11-05` from the probe; the probe's
external server answered `2024-11-05` and was *also* accepted, so the CLI
tolerates both. Amendment recorded in the execution log, ruled by owner
review.

## Transport

Every message rides a `control_request` subtype `mcp_message`
(`server_name`, `message` = JSON-RPC object) and is answered with a
success `control_response` whose payload is
`{"mcp_response": <JSONRPCResponse>}` (contracts/control-channel.md).

## Exchanges (captured, in wire order)

1. `initialize` (id 0) → result
   `{"protocolVersion":"2025-11-25","capabilities":{"tools":{"listChanged":true}},"serverInfo":{"name":<server>,"version":"1.0.0"}}`.
2. `notifications/initialized` (no id) — a JSON-RPC *notification*;
   answered `{"mcp_response":{"jsonrpc":"2.0","result":{},"id":0}}`
   verbatim (oracle behaviour; this host answers **every** notification
   that way).
3. `tools/list` (id 1) → result `{"tools":[{name, description,
   inputSchema, execution:{"taskSupport":"forbidden"}}]}`.
   - `inputSchema` fidelity (schema bytes pass through raw), pinned
     precisely: the toolhost never
     re-marshals schema bytes through Go values, so JSON **values, key
     order, and number literals (including >2^53) survive to the wire
     verbatim**. The control envelope's serializer then applies
     whitespace compaction (as the oracle's own serializer does) and
     Go's HTML escaping (Go-specific; JSON.stringify does not escape) —
     both semantics-preserving normalizations, verified end to end
     (reviewer-verified). Witness at the toolhost layer:
     `TestToolsListByteFidelity` (a Marshal-based implementation fails
     it — caught live during the packet build).
   - `execution.taskSupport: "forbidden"` mirrors the oracle's captured
     answer for sdk tools.
4. `tools/call` (id 2; `params.name`, `params.arguments`, `_meta` with
   `claudecode/toolUseId` and `progressToken` — tolerated, unread) →
   result `{"content": <MCP content array>}`, plus `"isError": true` when
   the handler failed (a handler error is a result, never a session
   failure).

## Error behaviour

- Unknown tool name in `tools/call`: JSON-RPC error `-32602`.
- Unknown method with an id: JSON-RPC error `-32601` (never silence).
- Cancelled call (`control_cancel_request` → context cancellation): the
  exchange fails at the control layer (error `control_response`), not as
  a tool result.
