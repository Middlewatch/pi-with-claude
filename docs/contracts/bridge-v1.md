# Bridge protocol v1 — our own frozen wire contract

**Owner:** this repository (not a vendor pin). Version: 1.
**Consumers:** `claude-go bridge` (server side), the Pi extension
(`adapters/pi/`), any host embedding a session without linking Go.

One bridge process serves **one** session, opened by the first `open`
frame (one session per process was the ruled design); ids are additive
in a future version, never retrofitted.
Transport is NDJSON on stdio, same framing rules as the claude wire
(one JSON object per line; blank lines carry nothing; CRLF tolerated).
Every frame is one JSON object whose `type` field names the frame; the
frame's other fields sit beside it at the top level. One frame is at
most 16 MiB; an over-cap frame is a fatal `error`. A `turn` or
`interrupt` frame before `open`, or a second `open`, is a fatal
`error`; `close` (explicit or as stdin EOF) is valid at any time.

## Design rule

The host sends its **full transcript projection** every turn; the bridge
prefix-matches against what it has itself produced and consumed. All
hard logic (matching, restarts, tool bookkeeping) lives on the Go side —
a host never tracks pending calls.

## Frames, host → bridge

| Frame | Fields | Semantics |
|---|---|---|
| `open` | `options?: {model?, system_prompt?, claude_path?, permission_mode?, effort?}`, `tools?: [ToolDescriptor]` | Spawn the session (Pipe profile). `effort` is the CLI's reasoning effort (`low`\|`medium`\|`high`\|`xhigh`\|`max`; omitted or empty leaves the CLI default) and is **session-scoped**, so a host changing it must close and reopen — the same obligation a changed tool set carries. `tools` are proxy descriptors: `{name, description, input_schema}` with the schema passed through raw. Answered by `opened` or fatal `error`. |
| `turn` | `messages: [Message]`, `tools?: [ToolDescriptor]` | The full projection. A `tools` set that no longer matches the registered set follows the same degraded path as a prefix mismatch — restart; and because a restart reopens from the original `open` frame, a host whose tool set has genuinely changed must close and reopen the bridge — retrying the drifted set can never converge. |
| `interrupt` | — | Control-channel interrupt of the in-flight turn (never a kill). With no turn in flight it is answered by the non-fatal `error` whose message is pinned verbatim as `interrupt with no turn in flight`, so a host can discard the stale answer of a lost interrupt race. |
| `close` | — | End the session and the process; also implied by stdin EOF. |

## Frames, bridge → host

| Frame | Fields | Semantics |
|---|---|---|
| `opened` | `init?: {model, tools, session_id}` | The session is live. Per the characterized init timing (`contracts/events.md`), `init` is null until the first turn ran; a host needing the surface reads it from the first `turn_end`. |
| `delta` | `kind: "text"\|"thinking"`, `text` | Streamed increments during a turn. |
| `turn_end` | `message: Message`, `reason: "end_turn"\|"tool_calls"\|"interrupted"\|"error"`, `usage?: {input, output, cache_read, cache_creation, total_cost_usd, turns, context_tokens?}`, `init?` | The assistant message produced this turn. `tool_calls`: the message ends in `tool_call` blocks the HOST must run; their results come back inside the next `turn` frame's projection. `usage` carries per-turn tokens plus the cumulative cost estimate (I7: estimate). The per-turn token fields aggregate every request inside a tool-loop turn, so their sum overstates context; `context_tokens`, when present, is the CLI's own current context occupancy (`get_context_usage`) and is the field a host gauges occupancy from. `init` snapshots the latest system/init. |
| `restarted` | `reason` | The degraded path ran: session closed and reopened clean, nothing replayed. The host's next `turn` still sends its full projection; history before the restart is the host's to keep or drop. |
| `error` | `message`, `fatal: bool` | Fatal errors end the process nonzero. |

## The neutral message schema

```json
{"role": "user" | "assistant",
 "blocks": [
   {"type": "text",     "text": "..."},
   {"type": "thinking", "text": "..."},
   {"type": "tool_call",   "id": "...", "name": "...", "input": {...}},
   {"type": "tool_result", "call_id": "...", "content": <raw>, "is_error": false},
   {"type": "image", "media_type": "image/png", "data": "<base64>"}
 ]}
```

`image` (added 2026-08-28, additive in v1) appears in user messages
only — the bridge never produces one — and reaches the wire as an
Anthropic base64 image source block. A pre-amendment bridge answers it
with the unknown-block restart below, which is the compatible
degradation. The bridge forwards `media_type` and `data` unvalidated:
the CLI and the API own rejection of malformed or over-limit images,
and their refusal surfaces as an ordinary error turn. Because the host
re-sends its full projection every turn, an absorbed image's bytes ride
every later `turn` frame — hosts budget against the 16 MiB frame cap
accordingly. A `tool_result`'s `content` is the raw MCP content array
and passes through untouched, so MCP image blocks
(`{"type": "image", "data": "<base64>", "mimeType": "..."}`) inside it
reach the model without any bridge involvement.

Unknown block types or roles in the projection are a prefix mismatch by
definition (the bridge could never have produced them) → restart.

## Prefix-match semantics (pinned)

The bridge keeps `sent`: a verbatim mirror of the host-visible
projection. Assistant messages are absorbed as produced; an accepted
`turn` suffix is absorbed with its message and block structure
preserved exactly as the host sent it — never any merged or rewritten
wire form — which is what keeps the host's next full projection
prefix-matching. On `turn`:

1. `len(messages) < len(sent)` → **restart** ("history shrank").
2. Any `messages[i] != sent[i]` (structural JSON equality — values and
   order, not bytes; hosts re-serialize. Numbers compare as
   full-precision literals: `1` equals `1.0`, and distinct integers
   beyond float64 precision never collapse into a match. Fields outside
   the pinned schema are dropped on decode — I4 — and take no part in
   equality) → **restart** ("prefix mismatch").
3. The suffix `messages[len(sent):]` may contain, in order:
   - user `tool_result` blocks — each must complete a pending proxy call
     by `call_id`; an unknown or already-completed id → **restart**
     (absorbing a result retires its id, so a stale re-send restarts);
   - user `text` and `image` blocks — forwarded as one user turn on the
     wire in suffix order, adjacent text blocks newline-merged into one
     (text-only suffixes therefore merge exactly as before), and any
     merged text run still empty after merging is dropped from the wire
     (the API rejects empty text blocks); the merge is invisible to the
     host because absorption preserves the suffix's original structure;
   - anything else (assistant/system messages the bridge never produced)
     → **restart**.
4. A turn that yields nothing to run — no completions and no user
   content (a lone empty merged text is no content) — is an `error`
   frame (`fatal: false`); its suffix, if any, is still absorbed so the
   projections stay aligned.
5. While a model turn is in flight (after a `tool_calls` pause), only a
   suffix of completions is valid — it resumes the turn. A suffix
   carrying user content (text or image) during flight is a non-fatal `error` with nothing
   applied (completions in the same frame included); the host recovers
   by re-sending the completions alone, then sending its text in a
   fresh `turn` after the resumed flight's `turn_end`. Between turns a
   suffix carries user content alone: a `tool_result` answering a call
   whose turn already ended (`interrupted`/`error`) is stale, and the
   degraded restart path answers it.

Restart mechanics: close the session (full teardown), reopen with the
`open` frame's options and tools, emit `restarted`. Nothing is replayed:
the model's context restarts clean, which is the honest degraded mode —
silently replaying an edited history would misrepresent it as lived
context.

## Proxy-call correlation

The MCP seam the CLI speaks carries no tool_use id, so the bridge binds
a dispatched proxy call to a `tool_call` block by **tool name**: the
oldest unclaimed block whose name matches the call's registered name
(directly, or as the wire form `mcp__<server>__<name>`), with input
equality preferred when several unclaimed blocks share the name. Two
concurrent calls with the same name *and* the same input are
indistinguishable at this seam and interchangeable by construction, so
the residual ambiguity is harmless. A rebuilder must not bind by bare
arrival order: the CLI's dispatch concurrency is uncharacterized,
and receivers dispatch requests on independent tasks.

## Turn boundaries

Each accepted `turn` frame that runs something is answered by exactly
one `turn_end` (or `restarted`/`error`). A model turn that calls proxy
tools pauses there: `turn_end` (`reason: "tool_calls"`) carries the
assistant blocks streamed so far, and the still-in-flight model turn
resumes when a later `turn` frame completes the calls — that resumed
stretch is answered by its own `turn_end`. Where the CLI turn splits
across such pauses, each `turn_end.message` is one neutral assistant
message, and the projection records them exactly as emitted.

While a model turn is in flight, a `turn` frame whose suffix carries
user content is a non-fatal `error` (nothing applied); a suffix of only
completions is the resume path. Assistant content blocks outside the
neutral schema (I4: the wire moves) are not projected — they are
tolerated on the claude wire and invisible to the host.
