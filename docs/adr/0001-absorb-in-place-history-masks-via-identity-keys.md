# 0001: Absorb in-place history masks via identity-keyed diffing

Date: 2026-08-21
Status: accepted

## Context

Folding extensions (context-fold) rewrite absorbed history in place before
model calls: a stale tool_result's content or a thinking block's text becomes
a short digest. The Pi adapter diffed history by exact JSON, so any fold read
as a rewrite of lived context — a full context wipe between turns, and a fatal
error when the first fold landed while a tool call was in flight (2026-08-22
production crash). The claude CLI is stateful and cannot be reseeded with
assistant history, so a fold can never be applied to the model's context on
this transport; the codex transport survives folds by ignoring them mid-turn
and applying them on its stateless re-send, an option claude-go lacks.

## Decision

The adapter keys its history diff by message identity, not exact content:
tool_result blocks reduce to `{type, call_id, is_error}` and thinking blocks
to `{type}`. In-place masks then diff as already-absorbed history and the
wire keeps sending the mirror's originals; set changes (branch navigation,
compaction) still take the honest degraded restart.

## Consequences

Folding is a no-op on claude-go: no crash, no context wipe, and the model
keeps more context than Pi's transcript shows — honest, since it lived the
full content the digest stands for. The CLI's own compaction manages the real
window. Trade-off: a genuine in-place edit to an already-seen tool_result's
content or thinking text is invisible to the adapter; no known Pi source
produces one apart from folding.

## Considered options

Mid-flight deferral alone (send only pending completions, honor the rewrite
at next turn start) was rejected: it fixes the crash but every first fold
still wipes the model's context at the next user message.
