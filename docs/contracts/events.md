# Event stream: frozen wire contract

**Pinned to:** `claude` 2.1.258, re-characterized 2026-09-01 through the
native bridge with zero drift from the earlier pins: identical
`capabilities`, init shape, result subtypes, and cumulative-cost
semantics. The `fable` alias resolves to `claude-fable-5-1` at 2.1.258
(`claude-fable-5` at 2.1.252), and the context windows of all four
aliases are unchanged.

**Pin history.** First characterized 2026-08-09 against `claude` 2.1.226
driven by Agent SDK 0.3.226 (two captures, leg A direct and leg B
through the SDK; committed excerpts in `fixtures/`). Re-pinned
2026-08-31 to 2.1.252 through the native bridge: init re-emitted per user
frame, identical `capabilities` set, `apiKeySource: "none"` under
subscription auth, and an interrupted turn added nothing to
`total_cost_usd`. Only a ratified re-pin moves this file.

## The tolerance rule (I4)

The event schema moves roughly 25 CLI releases a month. The decoder types
only the families below, retains every frame's raw bytes, and maps
anything else (an unknown `type`, unknown `subtype`, unknown fields, or a
non-JSON line) to an unknown event rather than an error.
`fixtures/unknown-event.jsonl` is the standing falsification input
(synthesized and marked as such; every other fixture frame is captured
verbatim).

## Timing facts (characterized)

- No frame arrives before stdin input: 10 s of observed silence with no
  input (leg A phase 0). `system/init` is neither emitted at spawn nor
  elicited by the `initialize` control request (15 s observed).
- `system/init` arrives immediately after every user message frame
  (observed 3/3 turns, under 50 ms after the user frame, before any
  assistant output). Consumers must tolerate repeated init frames per
  session.
- The `initialize` control request is answered before any user input;
  its `control_response` carries account, model, and command info
  (`contracts/control-channel.md`). The control channel works
  pre-input, and the event stream starts with the first turn.
- Hosted tool calls dispatch one at a time while the model keeps
  streaming. At 2.1.258 the `tools/call` for a `tool_use` block follows
  that block's `assistant` frame, and `tools/call` k+1 goes out only
  after result k. Later blocks keep streaming meanwhile: their
  `content_block_*` and `assistant` frames arrive while call 1 is in
  flight. A consumer that waits for every streamed `tool_use` block to
  be dispatched before answering the current call deadlocks whenever a
  later block finishes streaming first, which a slow first tool
  guarantees (two frozen Pi sessions, 2026-09-02). Regression shape:
  `fixtures/tool-call-turn-serial.jsonl`.

## Depended-on families

### `system` / `init`

Keys the extension depends on: `session_id`, `model`, `tools` (final
wire names, e.g. `mcp__pi__read`), `capabilities`, `apiKeySource`
(`"none"` under subscription auth), `mcp_servers` (`[{name, status}]`),
and `permissionMode`. The full captured key set is in
`fixtures/init.jsonl`. Observed `capabilities` at 2.1.226:

```
["interrupt_receipt_v1", "interrupt_cancel_queued_v1", "msg_lifecycle_v1"]
```

The interrupt-receipt capability name is `interrupt_receipt_v1`, and the
receipt payload observed is `{"still_queued": []}`.

### `assistant` / `user`

`message` is an API-shape message object (`role`, `content` block array)
with `parent_tool_use_id` at the top level. Tool use appears as a
`tool_use` block in an assistant message, and the tool result comes back
as a `tool_result` block in a `user` frame the CLI emits on its own.

A `tool_use` whose name the CLI does not host (a model-invented name such
as `mcp__nothing`) still appears as an assistant frame, but no
`tools/call` follows: the CLI answers it itself with a `user` frame whose
`tool_result` carries `<tool_use_error>Error: No such tool available:
<name></tool_use_error>` and `is_error: true`, and the turn continues to
its normal result (2.1.258, `unknown-tool-turn.jsonl`). Such a block has
no host-side handler, so the extension drops it from what Pi is handed
rather than surfacing a toolCall Pi would execute and fail.

### `stream_event` (only with `--include-partial-messages`)

The `event` field carries a `BetaRawMessageStreamEvent`: `message_start`,
`content_block_start`, `content_block_delta` with `text_delta` or
`thinking_delta`, `content_block_stop`, `message_stop`, and so on.

### `result`

One per turn. The depended-on keys, per the SDK oracle and as observed:

- `subtype`: `success` observed for completed turns, and
  `error_during_execution` observed for an interrupted turn
  (`is_error: true`, `result: null`).
- `usage`: per-turn, main agent loop only (leg A turn 1: 879 input
  tokens on the initialize system-prompt path, the same order as the
  probe's 868).
- `modelUsage` (keyed by full model name, e.g.
  `claude-haiku-4-5-20251001`) and `total_cost_usd` are cumulative
  running totals. Read the latest result rather than summing across
  results, since summing double-counts. Observed: leg A results'
  `total_cost_usd` went 0.001665, 0.005159, 0.005159 across three turns
  (the interrupted turn added nothing).
- Interrupted turns: the CLI emits a `user` frame
  (`[Request interrupted by user]`) and then the error result; the
  interrupt `control_response` (receipt `{"still_queued": []}`) precedes
  both.

### Families observed and deliberately untyped

`rate_limit_event`, `system/status`, `system/thinking_tokens`,
`system/permission_denied` (carries `tool_name`, `tool_use_id`,
`decision_reason_type`; captured in `denied-tool-turn.jsonl`), and
anything future. Each family is present in the committed fixtures so
decode tests exercise them.

## Fixture map

| File | Content | Source |
|---|---|---|
| `init.jsonl` | first observed `system/init`, verbatim | leg A |
| `turn-deltas.jsonl` | one full text turn: init, rate_limit_event, stream_events, assistant (thinking+text), result | leg A turn 1 |
| `tool-call-turn.jsonl` | full in-process tool turn including control_request frames in stream position | leg B stdout |
| `tool-call-turn-empty-thinking.jsonl` | as above, with the assistant messages' `thinking` blanked: the reasoning-model shape where the final message reports the block but not its text, while the deltas carried it | derived from `tool-call-turn.jsonl` |
| `tool-call-turn-thinkless.jsonl` | as above with the thinking `stream_event`s also removed: an empty thinking block with nothing behind it to recover | derived from `tool-call-turn-empty-thinking.jsonl` |
| `tool-call-turn-serial.jsonl` | one message, three `tool_use` blocks (indices 1..3) in the 2.1.258 wire order: each block's `assistant` frame, then its `tools/call`, with blocks 2 and 3 fully streamed before call 2 exists. `tests/fake_claude.py` blocks at each `tools/call` until answered, so the losing race is deterministic; `FAKE_CLAUDE_CALL_DELAY_MS` keeps the frames ahead of each call in their own chunk | derived from `tool-call-turn.jsonl` |
| `tool-call-turn-double-thinking.jsonl` | two thinking blocks in one message: index 0 an empty signed block (one empty `thinking_delta`, signature, empty assistant frame), index 1 the summary carrying the text, tool_use at index 2. The shape fable 5.1 emits at high effort (CLI 2.1.258 transcript, 2026-09-02: `apiBlockIndex` 0/1/2 with distinct signatures, in all 615 messages where a thinking block carried text at `thinking_tokens` > 0; the ~40 single text-bearing blocks all sat at `thinking_tokens` 0). Haiku and fable on trivial prompts never produced it under the bridge | derived from `tool-call-turn-empty-thinking.jsonl` |
| `denied-tool-turn.jsonl` | full dontAsk denial turn: tool_use, `system/permission_denied`, denial tool_result, result | leg A turn 2 |
| `result-usage.jsonl` | three verbatim result frames (per-turn and cumulative fields) | legs A and B |
| `interrupt-turn.jsonl` | directional `{"dir":"lib"\|"cli","frame":…}`: user frame, our interrupt request, ack, interrupted result | leg A turn 3 |
| `mcp-dialect-turn.jsonl` | directional: initialize request, MCP handshake / tools/list / tools/call / can_use_tool with our responses | leg B both directions |
| `unknown-tool-turn.jsonl` | one turn where the model calls `mcp__nothing`: its `tool_use` assistant frame, the CLI's own `tool_use_error` user frame (no `tools/call`), then a second model message and `end_turn` result | 2.1.258 stdout, 2026-09-05 |
| `unknown-event.jsonl` | synthesized unheard-of type (I4 falsification) | synthesized |
