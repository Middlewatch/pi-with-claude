# pi-with-claude: Claude Code as a Pi model provider

An in-process TypeScript Pi extension speaking Claude Code's stream-json
wire directly (zero runtime dependencies), running `claude` as a stripped
backend on a Claude subscription. Build only what an approved plan
covers. The owner's plan lane, evidence artifacts, and spikes live in the
untracked `.local/` surround, outside the public tree.

## The gate

`scripts/verify.sh` is the definition of green and CI runs exactly it:
`typecheck unit smoke`. One local run reproduces CI. Run it before every
commit. A red gate is the product speaking, so fix the cause or report the
blocker rather than weakening the gate to pass.

## Invariants

Code, contracts, and tests cite these by number, so the labels stay.

- **I1 Never handle credentials.** The extension spawns `claude` and
  lets it authenticate; nothing reads, parses, forwards, or persists a
  credential file, keychain entry, or token. Which identity the child
  uses is selected only through its environment (`CLAUDE_CONFIG_DIR`).
  If a task seems to need a credential, stop and ask.
- **I2 Never misrepresent the client.** No system-prompt scrubbing, no
  user-agent or header spoofing, no entrypoint declaration of any kind.
  This is a compliance boundary.
- **I4 Tolerant decode.** Unknown frame types, unknown fields, and
  non-JSON lines on the wire are delivered or dropped, never an error
  (`docs/contracts/events.md`).
- **I6 Assert the tool surface at startup.** `system/init`'s `tools`
  must equal the hosted set; a mismatch, or a turn ending with no init
  seen, is an error. This catches a CLI release reintroducing
  scaffolding.
- **I7 Usage is a first-class return value.** The CLI's own context
  occupancy (`get_context_usage`) fills every field Pi gauges compaction
  from, and cost is the per-turn delta of the CLI's cumulative estimate
  rather than a Pi-side rate.
- **I8 No resident footprint.** One `claude` child per open session and
  nothing else: no daemon, warm pool, socket, or helper process. The one
  other spawn is `claude auth status --json`, once per process, to label
  the account menu.

## Session rules

- **Honest restart, never replay.** History Pi has rewritten (branch
  navigation, compaction, a stale tool result) restarts the session
  clean from the newest user input; a silent replay would misrepresent
  an edited transcript as lived context. The taxonomy is
  `docs/contracts/bridge-v1.md` §prefix-match. This extension diffs by
  identity-key membership rather than index (`projection.ts` `diffNew`),
  and in-place masks of absorbed content diff as already absorbed
  (README "History and folding").
- **The wire pin is a CLI oracle.** `docs/contracts/` names the `claude`
  version each surface was characterized against. A re-pin is a
  deliberate, dated characterization with its own commit and evidence
  in `.local/`.
- **No paid model calls in the gate.** The smoke drives real Pi against
  a scripted fake `claude`. Anything that would spend a real
  subscription runs deliberately, outside the default battery and CI,
  with results recorded as dated evidence in `.local/`.

## Layout

`src/` is the extension (`index.ts` Pi entry, `extension.ts` provider,
`bridge.ts` the stream-json wire driver, `projection.ts` pure diff and
mirror module, `accounts.ts` account routing). `tests/` holds the unit
tests, the Pi smoke, and the scripted fake claude. `fixtures/` holds
golden wire frames characterized from the real CLI, and
`docs/contracts/` the frozen wire contracts.

`CLAUDE.md` is a tracked symlink to this file (one policy, both
harnesses).
