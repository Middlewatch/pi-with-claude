# Design doctrine

Invariants carried verbatim from claude-go (its DESIGN.md), which this
extension supersedes. Build only what the current spec or an approved plan
covers.

## Invariants

- **I1: Never touch credentials** (2026-08-09). The extension spawns
  `claude` and lets it authenticate. It does not
  read, parse, forward, or persist credential files, keychain entries, or
  OAuth tokens. Selecting *which* identity the child uses is done only
  through the child's environment (`CLAUDE_CONFIG_DIR`), never by handling
  a credential.
- **I2: Never misrepresent the client** (2026-08-09). No system-prompt
  scrubbing, no user-agent or header spoofing. Identity misrepresentation
  is the one line Anthropic has prohibited continuously and enforced
  technically.
- **I6: Assert the tool surface at startup** (2026-08-09). The
  `system/init` `tools` array is checked against the requested set and a
  mismatch is an error. Cheap gate; catches a scaffolding regression the
  moment a release reintroduces one.
- **I7: Usage is a first-class return value** (2026-08-09). Cache reads,
  cache creation, and per-model usage come back structurally rather
  than as log lines. `total_cost_usd` is a client-side estimate and is labelled as one.
- **I8: No resident footprint** (2026-08-09). Nothing beyond the host
  process and one `claude` child per open session: no daemon, no warm
  pool, no listening sockets, no helper processes. Tool hosting is
  in-process specifically to keep this true.

## Session doctrine

- **Honest restart, never replay.** When the projected history cannot be
  reconciled with the live session (shrunk history, prefix mismatch, stale
  tool result), the session restarts clean from the newest user input.
  Silently replaying an edited history would misrepresent it as lived
  context. Restart semantics are specified by the frozen
  `docs/contracts/bridge-v1.md` §prefix-match.
- **Identity-keyed history diffing** (ADR 0001, carried over). In-place
  masks of absorbed content (a tool_result's content or a thinking
  block's text folded to a digest) diff as already-absorbed history.
  Folding is a no-op on this transport.
- **The wire is pinned to a named CLI oracle.** The event schema moves
  ~25 CLI releases a month; `docs/contracts/` records the exact `claude`
  version each surface was characterized against. A re-pin is a
  deliberate, dated characterization against a real CLI with its own
  commit and evidence in `.local/`, rather than an ambient bump.
