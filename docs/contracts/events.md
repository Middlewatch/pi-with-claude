# Event stream — frozen wire contract

**Pinned to:** `claude` 2.1.226 / Agent SDK 0.3.226.
**Re-pinned 2026-08-31 to `claude` 2.1.252** via the native bridge
(paid capture, `.local/evidence/2026-08-31-s3/`): init re-emitted per
user frame, identical `capabilities` set, `apiKeySource: "none"` under
subscription auth, result subtypes and cumulative-cost semantics
unchanged (interrupted turn added nothing to `total_cost_usd`). No
drift in the depended-on families.
**Re-pinned 2026-09-01 to `claude` 2.1.258** via the native bridge
(paid capture, `.local/evidence/2026-09-01-repin-2.1.258/`): zero
drift — identical `capabilities`, init shape, result subtypes, and
cumulative-cost semantics. The `fable` alias now resolves to
`claude-fable-5-1` (was `claude-fable-5` at 2.1.252); context windows
unchanged for all four aliases.
**Provenance:** characterization captures, 2026-08-09 — raw records with timestamps in
`.local/artifacts/characterization-2026-08-09/` (the owner's untracked
evidence surround; `leg_a.raw.jsonl`,
`leg_b.stdout.raw`); committed excerpts in `fixtures/`. Only a ratified
re-pin moves this file.

## The tolerance rule (I4)

The event schema moves roughly 25 CLI releases a month. The decoder types
only the families below, retains every frame's raw bytes, and maps
anything else — unknown `type`, unknown `subtype`, unknown fields,
non-JSON — to `UnknownEvent`, never an error. `fixtures/unknown-event.jsonl`
is the standing falsification input (synthesized, marked as such; every
other fixture frame is captured verbatim).

## Timing facts (characterized)

- **No frame arrives before stdin input.** 10 s observed silence with no
  input (leg A phase 0). `system/init` is **not** emitted at spawn and is
  **not** elicited by the `initialize` control request (15 s observed).
- `system/init` arrives immediately after **every** user message frame
  (observed 3/3 turns, <50 ms after the user frame, before any assistant
  output). Consumers must tolerate repeated init frames per session.
- The `initialize` control request **is** answered before any user input
  (its `control_response` carries account/model/command info — see
  `contracts/control-channel.md` when it lands). The control channel works
  pre-input; the event stream starts with the first turn.

## Depended-on families

### `system` / `init`

Keys the library depends on: `session_id`, `model`, `tools` (final wire
names, e.g. `mcp__codemode__run_code`), `capabilities`, `apiKeySource`
(`"none"` under subscription auth), `mcp_servers` (`[{name, status}]`),
`permissionMode`. Full captured key set in `fixtures/init.jsonl`.
Observed `capabilities` at 2.1.226:

```
["interrupt_receipt_v1", "interrupt_cancel_queued_v1", "msg_lifecycle_v1"]
```

(The interrupt-receipt capability name is
`interrupt_receipt_v1`; the receipt payload observed is
`{"still_queued": []}`.)

### `assistant` / `user`

`message` is an API-shape message object (`role`, `content` block array);
`parent_tool_use_id` at top level. Tool use appears as a `tool_use` block
in an assistant message; the tool result comes back as a `tool_result`
block in a `user` frame the CLI emits on its own.

### `stream_event` (only with `--include-partial-messages`)

`event` field carries a `BetaRawMessageStreamEvent`
(`message_start`, `content_block_start`, `content_block_delta` with
`text_delta` / `thinking_delta`, `content_block_stop`, `message_stop`, …).

### `result`

One per turn. Depended-on keys, semantics per the SDK oracle and observed:

- `subtype`: `success` observed for completed turns;
  `error_during_execution` observed for an interrupted turn
  (`is_error: true`, `result: null`).
- `usage`: **per-turn, main agent loop only** (leg A turn 1: 879 input
  tokens on the initialize system-prompt path — same order as the probe's
  868).
- `modelUsage` (keyed by full model name, e.g.
  `claude-haiku-4-5-20251001`) and `total_cost_usd`: **cumulative running
  totals** — read the latest result, never sum across results (summing
  double-counts; the falsification witness is TestCumulativeIsLatestNotSum).
  Observed: leg A results' `total_cost_usd` = 0.001665 → 0.005159 →
  0.005159 (interrupted turn added nothing) across three turns.
- Interrupted turns: the CLI emits a `user` frame
  (`[Request interrupted by user]`) then the error result; the interrupt
  `control_response` (receipt `{"still_queued": []}`) precedes both.

### Families observed and deliberately untyped (UnknownEvent)

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
| `tool-call-turn.jsonl` | full in-process tool turn incl. control_request frames in stream position | leg B stdout |
| `tool-call-turn-empty-thinking.jsonl` | as above, with the assistant messages' `thinking` blanked: the reasoning-model shape where the final message reports the block but not its text, while the deltas carried it | derived from `tool-call-turn.jsonl` |
| `tool-call-turn-thinkless.jsonl` | as above with the thinking `stream_event`s also removed: an empty thinking block with nothing behind it to recover | derived from `tool-call-turn-empty-thinking.jsonl` |
| `denied-tool-turn.jsonl` | full dontAsk denial turn: tool_use, `system/permission_denied`, denial tool_result, result | leg A turn 2 |
| `result-usage.jsonl` | three verbatim result frames (per-turn + cumulative fields) | legs A+B |
| `interrupt-turn.jsonl` | directional `{"dir":"lib"\|"cli","frame":…}`: user frame, our interrupt request, ack, interrupted result | leg A turn 3 |
| `mcp-dialect-turn.jsonl` | directional: initialize request, MCP handshake / tools/list / tools/call / can_use_tool with our responses | leg B both dirs |
| `unknown-event.jsonl` | synthesized unheard-of type (I4 falsification) | synthesized |
