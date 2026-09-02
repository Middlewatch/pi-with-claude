# Control channel — frozen wire contract

**Pinned to:** `claude` 2.1.226 / Agent SDK 0.3.226.
**Re-pinned 2026-08-31 to `claude` 2.1.252** via the native bridge
(paid capture, `.local/evidence/2026-08-31-s3/`): initialize answered
pre-input, interrupt receipt `{"still_queued": []}` verbatim (2 ms),
mcp_message exchanges unchanged. `get_context_usage` now HAS capture
provenance: the 2.1.252 answer carries `totalTokens`, `maxTokens`,
`rawMaxTokens`, `percentage`, `categories`, `model` — the typings-derived
shape below held on the real wire.
**Re-pinned 2026-09-01 to `claude` 2.1.258** via the native bridge
(paid capture, `.local/evidence/2026-09-01-repin-2.1.258/`): zero
drift — initialize, interrupt receipt (2 ms), mcp_message, and
`get_context_usage` all byte-compatible with the 2.1.252 pin.
**Provenance:** characterization captures, 2026-08-09
(untracked `.local/artifacts/characterization-2026-08-09/`:
leg A initialize + interrupt exchanges, leg B mcp_message + can_use_tool
exchanges — committed excerpts in `fixtures/mcp-dialect-turn.jsonl` and
`fixtures/interrupt-turn.jsonl`) and direct read of the oracle
(`sdk.mjs` request construction @805530, frame routing @794638,
initialize body @800907). Only a ratified re-pin moves this file.

## Frames (ride the same stdio NDJSON as events)

Library → CLI:

```json
{"type":"control_request","request_id":"<id>","request":{"subtype":"<s>", ...}}
{"type":"control_response","response":{"subtype":"success","request_id":"<id>","response":{...}}}
{"type":"control_response","response":{"subtype":"error","request_id":"<id>","error":"<text>"}}
```

CLI → library: the same three shapes, plus
`{"type":"control_cancel_request","request_id":"<id>"}` (abort that
in-flight handler) and `{"type":"keep_alive"}` (ignored). Any other
`type` is not a control frame and flows to event decoding.

`request_id` is an opaque string; the sender generates it and the
response echoes it. Responses may arrive out of order relative to other
requests (correlation is by id, never by order).

## Subtypes this library sends

`initialize` (at spawn: `systemPrompt?: string[]`,
`appendSystemPrompt?: string`, `sdkMcpServers?: string[]` — observed
leg B: `{"subtype":"initialize","sdkMcpServers":["calc"],"systemPrompt":["..."]}`;
the response is answered **before any user input** and carries
`account`, `models`, `commands`, `current_permission_mode`, … — but NOT
the tool list, which only `system/init` reports after the first user
message — see `contracts/events.md`), `interrupt` (response is the receipt `{"still_queued":[]}`
under `interrupt_receipt_v1`), `set_permission_mode`,
`mcp_set_servers`, `get_context_usage`.

## Subtypes this library answers

- `mcp_message` (`server_name`, `message` = JSON-RPC): answered with a
  success response whose payload is `{"mcp_response": <JSONRPCResponse>}`;
  a JSON-RPC *notification* is answered
  `{"mcp_response":{"jsonrpc":"2.0","result":{},"id":0}}` (observed
  leg B verbatim).
- `can_use_tool` (`tool_name` in wire form `mcp__<server>__<name>`,
  `display_name`, `input`, `permission_suggestions`, `tool_use_id`):
  answered `{"behavior":"allow","updatedInput":{...}}` or
  `{"behavior":"deny","message":"..."}` (observed leg B: the SDK's allow
  answer also echoed `toolUseID`).
- **Any other incoming subtype** gets an error `control_response` naming
  the subtype — the oracle's own behaviour. This is load-bearing: the CLI
  may add subtypes (hooks, etc.) any release, and silence would hang it.

## get_context_usage response (typings-derived pin, no capture provenance)

The response payload's depended-on keys are `totalTokens` and
`maxTokens` (int); the full shape (categories, gridRows, model, …) is
per `SDKControlGetContextUsageResponse` in the oracle typings.
Capture provenance since the 2026-08-31 re-pin (frames in
`.local/evidence/2026-08-31-s3/stdout.raw`); the fake's scripted values
remain scripted because totals depend on the caller's own prompt.

## Cancellation and teardown

- `control_cancel_request` cancels the named in-flight handler's context;
  the handler's resulting error is reported as an error response.
- On connection close every pending outgoing request fails with the close
  cause; in-flight incoming handlers are cancelled.

## Timing facts

The control channel is live before any user input: leg A's `initialize`
was answered in <20 ms with no user message ever sent. Event-stream
startup (`system/init`) is a separate, later fact — see
`contracts/events.md`.
