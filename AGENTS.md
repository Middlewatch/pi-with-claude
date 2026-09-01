# pi-with-claude — Claude Code as a Pi model provider

An in-process TypeScript Pi extension speaking Claude Code's stream-json
wire directly (zero runtime dependencies), running `claude` as a stripped
backend on a Claude subscription.
`DESIGN.md` is the doctrine home — build only what it or an approved plan
covers. The owner's plan lane, evidence artifacts, and spikes live in the
untracked `.local/` surround, outside the public tree.

## The gate

`scripts/verify.sh` is the definition of green and CI runs exactly it:
`typecheck unit smoke`. One local run reproduces CI. Run it before every
commit. A red gate is the product speaking; fix the cause or report the
blocker, never weaken the gate to pass.

## Project rules

- **Never handle credentials** (DESIGN.md I1). The extension spawns
  `claude` and lets it authenticate. If a task seems to need a
  credential, stop and ask.
- **Never misrepresent the client** (I2). This is a compliance boundary,
  not a style preference.
- **The wire pin is a CLI oracle.** `docs/contracts/` names the `claude`
  version each surface was characterized against; a re-pin is a
  deliberate, dated characterization with its own commit, never ambient.
- **No paid model calls in the gate.** The smoke drives real Pi against a
  scripted fake `claude`. Anything that would spend a real subscription is
  run deliberately, outside the default battery and outside CI, with the
  results recorded as dated evidence in `.local/`.
- **Honest restart, never replay** (DESIGN.md). Restart semantics follow
  the frozen `contracts/bridge-v1.md` §prefix-match in the claude-go repo.

## Layout

`src/` the extension (`index.ts` Pi entry, `extension.ts` provider,
`bridge.ts` the stream-json wire driver, `projection.ts` pure
diff/mirror module, `accounts.ts` account routing) · `tests/` unit
tests plus the Pi smoke and the scripted fake claude · `fixtures/`
golden wire frames characterized from the real CLI · `docs/contracts/`
the frozen wire contracts · `docs/specs/` the build spec · `docs/adr/`
decisions.

`CLAUDE.md` is a tracked symlink to this file — one policy, both harnesses.
