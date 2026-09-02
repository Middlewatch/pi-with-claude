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
- **I7: Usage is a first-class return value** (2026-08-09, as built
  2026-09-02). What the CLI reports comes back structurally on Pi's
  usage object: the CLI's own context occupancy (`get_context_usage`)
  in every field Pi reads for compaction, output tokens per turn, and
  cost as the per-turn delta of the CLI's cumulative `total_cost_usd`,
  which is the CLI's estimate and never a Pi-side rate.
- **I8: No resident footprint** (2026-08-09). Nothing beyond the host
  process and one `claude` child per open session: no daemon, no warm
  pool, no listening sockets, no helper processes. Tool hosting is
  in-process specifically to keep this true. The one other spawn is
  `claude auth status --json`, run synchronously once per process to
  label the account menu (I1: the vendor's command, never its files).

## Session doctrine

- **Honest restart, never replay.** When the projected history cannot be
  reconciled with the live session (shrunk history, prefix mismatch, stale
  tool result), the session restarts clean from the newest user input.
  Silently replaying an edited history would misrepresent it as lived
  context. Restart semantics follow the taxonomy in the frozen
  `docs/contracts/bridge-v1.md` §prefix-match, with one as-built
  difference: the Go bridge compared index by index, while this
  extension diffs by identity-key membership (`projection.ts`
  `diffNew`). Any absorbed message missing from Pi's history restarts;
  order is not checked, since Pi does not reorder, and a reordered
  history surfaces as "nothing new to run", never as a replay.
- **Identity-keyed history diffing** (ADR 0001, carried over). In-place
  masks of absorbed content (a tool_result's content or a thinking
  block's text folded to a digest) diff as already-absorbed history.
  Folding is a no-op on this transport.
- **The wire is pinned to a named CLI oracle.** The event schema moves
  ~25 CLI releases a month; `docs/contracts/` records the exact `claude`
  version each surface was characterized against. A re-pin is a
  deliberate, dated characterization against a real CLI with its own
  commit and evidence in `.local/`, rather than an ambient bump.
