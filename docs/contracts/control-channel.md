# Control channel: frozen wire contract

**Pinned to:** `claude` 2.1.270, re-characterized 2026-09-13 through the
native bridge with zero drift: initialize, the interrupt receipt (2 ms),
`mcp_message`, and `get_context_usage` are all byte-compatible with the
2.1.252, 2.1.258, and 2.1.267 pins.

**Pin history.** First characterized 2026-08-09 against `claude` 2.1.226
driven by Agent SDK 0.3.226: leg A's initialize and interrupt exchanges,
leg B's mcp_message and can_use_tool exchanges (committed excerpts in
`fixtures/mcp-dialect-turn.jsonl` and `fixtures/interrupt-turn.jsonl`),
plus a direct read of the SDK's request construction, frame routing, and
initialize body. Re-pinned 2026-08-31 to 2.1.252 through the native
bridge: initialize answered pre-input, the interrupt receipt
`{"still_queued": []}` verbatim (2 ms), mcp_message exchanges unchanged,
and `get_context_usage` gained capture provenance (the answer carries
`totalTokens`, `maxTokens`, `rawMaxTokens`, `percentage`, `categories`,
`model`, so the typings-derived shape held on the real wire). Re-pinned
2026-09-01 to 2.1.258 with zero drift (interrupt receipt 2 ms), 2026-09-10
to 2.1.267 (3 ms), and 2026-09-13 to 2.1.270 (2 ms). Only a ratified
re-pin moves this file.

## Frames (ride the same stdio NDJSON as events)

Extension to CLI:

```json
{"type":"control_request","request_id":"<id>","request":{"subtype":"<s>", ...}}
{"type":"control_response","response":{"subtype":"success","request_id":"<id>","response":{...}}}
{"type":"control_response","response":{"subtype":"error","request_id":"<id>","error":"<text>"}}
```

CLI to extension: the same three shapes, plus
`{"type":"control_cancel_request","request_id":"<id>"}` (abort that
in-flight handler) and `{"type":"keep_alive"}` (ignored). Any other
`type` is not a control frame and flows to event decoding.

`request_id` is an opaque string; the sender generates it and the
response echoes it. Responses may arrive out of order relative to other
requests, so correlation is by id rather than by order.

## Subtypes the extension sends

- `initialize` at spawn, with `systemPrompt?: string[]`,
  `appendSystemPrompt?: string`, and `sdkMcpServers?: string[]`
  (observed leg B:
  `{"subtype":"initialize","sdkMcpServers":["calc"],"systemPrompt":["..."]}`).
  The response is answered before any user input and carries `account`,
  `models`, `commands`, `current_permission_mode`, and more, but not the
  tool list, which only `system/init` reports after the first user
  message (`contracts/events.md`).
- `interrupt`, whose response is the receipt `{"still_queued":[]}` under
  `interrupt_receipt_v1`.
- `get_context_usage`.

The CLI also accepts `set_permission_mode` and `mcp_set_servers`, which
this extension never sends.

## Subtypes the extension answers

- `mcp_message` (`server_name`, `message` = JSON-RPC): answered with a
  success response whose payload is `{"mcp_response": <JSONRPCResponse>}`.
  A JSON-RPC notification is answered
  `{"mcp_response":{"jsonrpc":"2.0","result":{},"id":0}}` (observed leg B
  verbatim).
- `can_use_tool` (`tool_name` in wire form `mcp__<server>__<name>`,
  `display_name`, `input`, `permission_suggestions`, `tool_use_id`):
  answered `{"behavior":"allow","updatedInput":{...}}` or
  `{"behavior":"deny","message":"..."}` (observed leg B: the SDK's allow
  answer also echoed `toolUseID`). Under `bypassPermissions`
  (`contracts/spawn-args.md`) the CLI never asks.
- Any other incoming subtype gets an error `control_response` naming the
  subtype, which is the oracle's own behaviour. This is load-bearing:
  the CLI may add subtypes (hooks and so on) in any release, and silence
  would hang it.

## get_context_usage response

The depended-on keys are `totalTokens` and `maxTokens` (integers). The
full shape (categories, gridRows, model, and so on) is per
`SDKControlGetContextUsageResponse` in the SDK typings and held on the
real wire at the 2026-08-31 re-pin. The fake's scripted values remain
scripted because totals depend on the caller's own prompt.

## Cancellation and teardown

- `control_cancel_request` cancels the named in-flight handler, and the
  handler's resulting error is reported as an error response.
- On connection close every pending outgoing request fails with the
  close cause, and in-flight incoming handlers are cancelled.

## Timing facts

The control channel is live before any user input: leg A's `initialize`
was answered in under 20 ms with no user message ever sent. Event-stream
startup (`system/init`) is a separate, later fact (`contracts/events.md`).
