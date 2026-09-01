# pi-with-claude

Date: 2026-08-31   Status: building

Successor to the claude-go bridge + Pi adapter, per ADR 0002. This spec
lives here in the predecessor repo until S1 scaffolds the new one, then
travels with it.

## Problem

Evoker's retirement left the language-neutral bridge serving exactly one
consumer, with a contract re-characterization treadmill (~25 CLI releases
a month) carried by one maintainer. The community's Pi adapters run
Claude Code as a full harness behind Pi, which this estate cannot use: a
settings-bearing child double-injects scaffolding and double-captures
through autojournal's hooks. claude-go was never published, so nothing
outside this machine depends on the current shape.

## Outcome

A scripted side-by-side Pi session exercising the parity checklist —
multi-turn with Pi-owned tools only (init surface asserted), streamed
deltas, occupancy tracking `getContextUsage`, account/model/effort
switches via reopen, image passthrough, folding as a no-op, honest
restart on history rewrites — behaves equivalently on the old claude-go
provider and on pi-with-claude, and the new repo's token-free gate is
green. Any parity row that differs unexplained, or any paid call inside
the gate, falsifies the claim.

## Non-goals

- **Compaction reseeding.** V1 keeps the honest reset; a post-v1 slice
  designs deliberate summary reseeding (owner-ruled 2026-08-31).
- **SDK affordances in v1** (`setModel`, `resume`/`forkSession`,
  `reinitialize`). Faithful port of the proven reopen-on-switch
  semantics first; each affordance is a later slice with its own probe.
- **Wire capture** (`CLAUDE_GO_CAPTURE_DIR` equivalent). The Go binary
  owned that seam; revisit only if debugging demands it.
- **Credential handling of any kind** (I1, unchanged).
- **Serving non-Pi hosts.** That was the bridge's reason to exist; it
  died with Evoker.
- **Maintaining the Go library.** claude-go freezes with a README
  pointer to the successor; no further characterization work.

## Decisions

- **Home:** new standalone repo `pi-with-claude` (name free on npm as of
  2026-08-31), MIT, public from first scaffold; npm/pi.dev publish waits
  for parity plus a public-release sweep. Both publish moments are
  owner-gated. GitHub repo creation is outward-facing — owner gate at
  first push.
- **Runtime shape:** in-process TypeScript Pi extension on
  `@anthropic-ai/claude-agent-sdk`, exact-pinned; SDK bumps are
  deliberate commits with their own verification (the go.mod
  discipline). The adoption commit carries a vet-dependency record.
- **Porting base:** start from `adapters/pi/` (~1,020 lines of proven
  TS: mirror bookkeeping, identity-keyed diff per ADR 0001, fresh-start
  projection, accounts, occupancy publishing, effort map). The bridge
  client is replaced by SDK calls; the Go-side prefix-match validation
  and restart taxonomy move into the extension, specified by
  `contracts/bridge-v1.md` §prefix-match.
- **Pipe profile on the SDK** (spike-proven, `.local/spikes/
  agent-sdk-seams/VERDICT.md`): `tools: []`, `settingSources: []`,
  string `systemPrompt`, init tool surface asserted (I6). Floor at probe
  size: 1,280 input tokens.
- **Permission seam:** `canUseTool` answers allow unconditionally — Pi
  owns gating. Without it the CLI silently denies MCP calls (spike
  finding).
- **Tool inversion:** SDK in-process MCP server whose handlers block on
  promises that Pi's next turn resolves — the pause/resume shape of
  bridge-v1 with live promises instead of wire correlation. Handlers are
  cancelled on restart/close so nothing hangs. Name-based proxy
  correlation from bridge-v1 is obsolete in-process.
- **Interrupt mapping:** an interrupted turn surfaces from the CLI as
  `error_during_execution`, and the SDK throws at stream close when the
  last result was an error (spike finding). The extension maps the
  former to Pi's interrupted stop and tolerates the latter.
- **Frame cap dissolved:** no NDJSON bridge, no 16 MiB frame, no
  extension-side image budget. The CLI and API own image rejection.
- **Usage:** occupancy published from `getContextUsage().totalTokens`
  (booked as cacheRead, input zero — the existing translation);
  per-turn `usage.iterations[]` keeps cost distinct from occupancy;
  cost surfaced as the CLI's own estimate (I7).
- **Gate** (`scripts/verify.sh`, CI runs exactly it): tsc typecheck,
  unit tests on the projection-diff/mirror module (tsx + node:test,
  dev-deps only), and a token-free smoke driving real Pi with the
  extension against the scripted fake claude. `fake_claude.py` and
  `pi_smoke.mjs` are copied from claude-go with a provenance note. No
  paid calls in the gate; the paid tier is deliberate with dated
  evidence.
- **Cutover:** side-by-side — both providers registered in one Pi until
  every parity slice lands and the outcome demo passes; then the old
  adapter symlink is retired.
- **Doctrine carryover:** I1, I2, I6, I7, I8 verbatim; ADR 0001
  identity-keyed diffing; honest restart, never replay.

## Seams under test

1. **Projection diff + mirror** as a pure module: unit tests with the
   restart taxonomy of bridge-v1 §prefix-match as the case source
   (shrunk history, prefix mismatch, stale tool_result, in-flight user
   content, identity-keyed masks, precision edges).
2. **The whole extension through real Pi** against the scripted fake
   claude: the ported pi_smoke covering open/turn/stream/tool
   pause-resume/interrupt/reopen paths, token-free.
3. **Deliberate paid tier:** floor and cache behavior at real session
   size (the spike sat under haiku's 2,048-token cache minimum), the
   parity demo, dated evidence in the repo's `.local/` surround.

Prior art: `tests/conformance_bridge.py` scenarios (restart taxonomy),
`tests/pi_smoke.mjs` (end-to-end shape).

## Slices

- [x] S1 Scaffold + gate skeleton: repo, README thesis and non-goals,
      MIT, verify.sh green over a provider stub, fake claude and smoke
      harness copied, SDK pinned with vet record, this spec copied in.
- [x] S2 Walking skeleton: one text turn streams through real Pi against
      the fake — open, delta, stop, usage. (after S1)
- [x] S3 Mirror, diff, honest-restart taxonomy, and tool inversion:
      pause/resume, deny-as-data, handler cancellation. (after S2)
- [x] S4 Occupancy and cost: getContextUsage translation, iterations
      split, Pi compaction thresholds fed truthfully. (after S3)
- [x] S5 Interrupt and steering: interrupt mapping, steering withheld
      in-flight and delivered next turn. (after S3)
- [x] S6 Reopen paths: model/effort/tool-set switches, accounts menu
      with CLAUDE_CONFIG_DIR selection and paused-tool-call refusal.
      (after S3)
- [x] S7 Images and folding: image blocks down the wire, ADR 0001
      no-op verified against a folding extension. (after S3)
- [ ] S8 Parity demo + paid characterization + cutover; then the
      owner-gated npm publish after a public-release sweep. (after
      S4–S7) — 2026-08-31: absorbed as S4 of
      `2026-08-31-native-bridge.md` (ADR 0002 replaced the SDK
      transport before this landed).

## Open questions

- Compaction reseed design (post-v1 slice): summary as first user
  message of the fresh session — framing, and whether Pi's compaction
  event exposes the summary to providers cleanly.
- Which SDK affordances earn adoption probes post-v1 (`setModel` first —
  it would remove the most-felt reopen).
- npm scope/account for publishing — owner decision at the publish gate.
- Whether the Python fake eventually ports to node to keep the repo
  single-language; not before parity.
