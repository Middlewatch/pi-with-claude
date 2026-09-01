# native-bridge

Date: 2026-08-31   Status: draft

Successor transport for this extension, per ADR 0002. Supersedes the
runtime-shape decision of `2026-08-31-pi-with-claude.md` (SDK-based);
that spec's S8 parity-and-cutover work lands here as S4.

## Problem

On 2026-08-31 the backend began billing sessions to extra usage when the
Agent SDK's self-identification coincides with a system prompt its
classifier reads as a third-party harness — which Pi's default prompt
is. Every real Pi session on this extension 400s the moment the
extra-usage pool is empty, regardless of account or plan headroom.
claude-go, speaking the same wire without the SDK's declaration, bills
to plan limits with identical prompt content (evidence:
`.local/evidence/2026-08-31-thirdparty-billing-classification.md`). The
owner rules the raw stream-json wire is within ToS and not a grey area.

## Outcome

A real Pi session on the native bridge, carrying Pi's default system
prompt, completes billed to plan limits — no third-party extra-usage
400 — while `scripts/verify.sh` is green and `package.json` carries
zero runtime dependencies. A dated paid run records the billing proof;
an unexplained parity difference against the SDK-era behavior, a red
gate, or a surviving runtime dependency falsifies the claim.

## Non-goals

- **Entrypoint or UA declaration of any kind.** Honest absence is the
  ruled I2 posture (contracts/spawn-args.md §Environment): the bridge
  sets no `CLAUDE_CODE_ENTRYPOINT`, spoofs nothing, and claims nothing.
- **Serving non-Pi hosts** (bridge-v1 NDJSON stdio). Died with Evoker;
  the contract's restart taxonomy is what survives, not the transport.
- **SDK affordances** (`setModel`, `resume`, `reinitialize`). Reopen
  semantics port as proven; affordances are post-v1 slices with probes.
- **Dual-transport fallback flag.** The SDK leaves in one commit; a
  transport toggle would double the smoke matrix for a path nobody runs.
- **Compaction reseeding.** Still post-v1 (owner-ruled 2026-08-31).
- **Porting the Python fake to node.** Not before parity, as before.

## Decisions

- **Transport:** a `src/bridge.ts` module speaking bidirectional
  stream-json to a self-spawned `claude`, per the five contracts copied
  from claude-go into `docs/contracts/` with provenance notes
  (bridge-v1, control-channel, events, mcp-dialect, spawn-args).
  claude-go's copies freeze as history; this repo owns the living wire.
- **CLI posture:** tolerant decode, `claude` from PATH
  (`PI_WITH_CLAUDE_CLAUDE` still overrides), contracts pinned to a
  named oracle version; re-pins are deliberate dated paid
  characterizations. The DESIGN.md "SDK pin is exact" invariant is
  rewritten to this CLI-oracle ritual in S2.
- **Zero runtime dependencies:** the MCP dialect is implemented
  natively (61-line contract; claude-go speaks it in 82 lines of Go).
  Both `@anthropic-ai/claude-agent-sdk` and `@modelcontextprotocol/sdk`
  leave in S2.
- **Permission seam dropped:** `--permission-mode bypassPermissions`
  per claude-go's characterized Pipe profile (dontAsk denies; the SDK's
  canUseTool callback existed only to un-break the SDK's own permission
  layer). Pi owns all gating.
- **Initialize exchange:** systemPrompt / sdkMcpServers via the
  control-channel initialize request (the SDK-oracle path), interrupt
  and context usage as control requests — all per the copied contracts.
- **What does not move:** `projection.ts`, `accounts.ts`, the turn
  loop's parking/reopen/honest-restart logic in `extension.ts`, the
  fake, the fixtures, the smoke, and the gate definition. The port
  replaces `query()` and the SDK MCP instance; everything downstream of
  the event stream keeps its shape.
- **Doctrine carryover:** I1, I2, I6, I7, I8 verbatim; ADR 0001; ADR
  0002 is this spec's mandate.

## Seams under test

1. **The bridge module against the fake claude** (new): a driver test
   spawning `fake_claude.py` directly — spawn argv per contract,
   initialize validation (the fake exits 2 on malformed frames), turn
   streaming, MCP tool exchange, interrupt ack, usage request. Prior
   art: claude-go `session_test.go` and the fake's own validation.
2. **Projection diff + mirror** unchanged (`tests/projection.test.ts`).
3. **The whole extension through real Pi** against the fake: the
   existing `pi_smoke.mjs` unchanged in intent — the same wire arrives
   from a different client.
4. **Deliberate paid tier:** re-characterization against the pinned
   CLI, the billing proof with Pi's real prompt, the parity demo; dated
   evidence in `.local/`.

## Slices

- [x] S1 Bridge module complete against the fake: contracts copied in
      with provenance, `bridge.ts` (spawn, initialize, tolerant read
      pump, user frames, native MCP dialect, interrupt, usage), driver
      tests green. Extension untouched.
- [x] S2 The swap: `extension.ts` onto the bridge, permission seam
      dropped, both runtime deps removed, DESIGN.md pin invariant
      rewritten, smoke and full gate green. (after S1)
- [x] S3 Paid characterization: re-pin contracts to the tested CLI
      version, billing proof with Pi's default prompt (plan limits, no
      third-party 400), floor and cache behavior re-measured, dated
      evidence. (after S2)
- [ ] S4 Parity demo against the claude-go provider + cutover: old
      adapter symlink retired, predecessor spec closed out, claude-go
      freeze note. Owner-gated publish steps remain owner-gated.
      (after S3)

## Open questions

- Whether the billing classifier's enforcement shape shifts mid-build
  (it went live mid-diagnosis today); S3 is where a shift would
  surface, and a content-only classifier would fail claude-go too —
  the sanctioned fallback is funded extra usage, recorded here if
  taken.
- claude-go repo freeze timing: after S4 cutover, with a README pointer
  to this repo (carried from the predecessor spec).
- 2026-08-31: predecessor spec's S8 absorbed here as S4; its checkbox
  stays open there with a pointer note.
