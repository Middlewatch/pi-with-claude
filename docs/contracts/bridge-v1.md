# Bridge v1: the neutral message schema and restart taxonomy

**Owner:** this repository (a design contract, not a vendor pin).
Version: 1. `src/projection.ts` implements the schema and the diff,
`src/extension.ts` the turn loop, and `tests/projection.test.ts` uses
the taxonomy below as its case source.

## Design rule

Pi hands the extension its full transcript every turn. The extension
keeps a mirror of what the live `claude` session has absorbed and diffs
the transcript against it, so Pi never tracks pending calls and the
session never receives history the model has not lived.

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

Pi's history projects to this schema, and the mirror notes assistant
messages through the same projection, so the two forms are identical by
construction. `image` appears in user messages only and reaches the wire
as an Anthropic base64 image source block, forwarded unvalidated: the CLI
and the API own rejection of malformed or over-limit images, and their
refusal surfaces as an ordinary error turn. A `tool_result`'s `content`
is the raw MCP content array and passes through untouched, so MCP image
blocks (`{"type": "image", "data": "<base64>", "mimeType": "..."}`) inside
it reach the model with no extension involvement. Assistant content
blocks outside the schema are tolerated on the wire and never projected
(I4).

## Identity keys

The mirror diffs by message identity rather than exact content. A
`tool_result` reduces to `{type, call_id, is_error}` and a `thinking`
block to `{type}`; every other block keeps its full content. Keys
compare by JSON structural equality (values and order rather than
bytes), so `1` and `1.0` are one identity. Folding extensions rewrite absorbed history in place,
masking a stale tool result's content or a thinking block's text to a
short digest, and the stateful CLI can never be reseeded with the edited
version. Under identity keys a masked copy diffs as history already
absorbed, the wire keeps the originals, and the session continues. The
trade-off is that a genuine in-place edit to those two fields is
invisible; no known Pi source produces one apart from folding.

## Prefix-match semantics

The extension keeps `noted` (the messages the live session has absorbed)
and `dropped` (history cut away at a fresh start, so it is never
re-flagged as new). Each turn diffs Pi's projection against both by
identity-key membership, in projection order. Membership rather than
index order is a deliberate relaxation of the index-wise rule: Pi does
not reorder history, and a reordered history would surface as "nothing
new to run" rather than as a replay. The diff yields the fresh suffix and
whether any noted message went missing. Then:

1. A noted message missing from the projection means Pi rewrote absorbed
   history (branch navigation, compaction). The session reopens clean
   and takes a **fresh start**.
2. Fresh content with an assistant role is history no suffix can carry.
   On a session that has noted nothing (a resumed Pi session on a new
   process) it takes a fresh start in place; mid-session it reopens the
   session first.
3. While a model turn is paused on tool calls, only completions go down.
   User text or images in the suffix are withheld and, being absent from
   the mirror, resurface as fresh suffix on the next call. Each
   completion must answer a parked call by `call_id`; an unknown or
   already-completed id reopens the session with nothing applied.
4. Between turns, the suffix carries user content: `text` and `image`
   blocks forwarded as one user turn in suffix order, adjacent text
   blocks newline-merged into one, and an empty merged run dropped (the
   API rejects empty text blocks). The merge is invisible to Pi because
   the mirror notes the suffix's original structure. A `tool_result`
   between turns answers a call whose turn already ended, is stale, and
   reopens the session.
5. A turn that yields nothing to run (no completions and no user
   content) is an error to Pi, which names the cause: a fresh start that
   cannot answer an in-flight call, a paused turn holding steering text,
   or plain "nothing new to run".

A fresh start trims the projection to what a brand-new session can
honestly receive: the trailing run of user messages, minus any leading
`tool_result` blocks (their calls cannot exist in a fresh session).
Everything cut away goes to `dropped`. Nothing is replayed, and the
model's context restarts clean; silently replaying an edited history
would misrepresent it as lived context.

## Proxy-call correlation

The CLI stamps the model's `tool_use` id into each `tools/call`'s `_meta`
(`claudecode/toolUseId`, `contracts/mcp-dialect.md`), and the extension
parks the handler under that id. A handler dispatched without the stamp
is bound by **tool name** at the pause: the oldest unbound block whose
name matches the call's (directly, or as the wire form
`mcp__pi__<name>`), with input equality preferred when several share the
name. Two concurrent calls with the same name and the same input are
indistinguishable at this seam and interchangeable by construction.
Arrival order says nothing about which block a call belongs to, because
the CLI dispatches hosted calls one at a time while the model's later
blocks keep streaming (`contracts/events.md`, timing facts).

## Turn boundaries

Each turn Pi sends is answered by one assistant message. A model turn
that calls hosted tools pauses at the first dispatched call: the message
handed to Pi carries the blocks streamed so far whose calls the CLI has
dispatched. A `tool_use` block already streamed but not yet dispatched is
carried into the next stretch's message instead, since the CLI dispatches
it only after the earlier results, and a stretch that waited for it would
deadlock. The paused turn resumes when a later Pi turn completes the
calls, and the resumed stretch is answered by its own assistant message.
Where the CLI turn splits across such pauses, each stretch is one neutral
assistant message, and the mirror records them exactly as handed over.
