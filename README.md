# pi-with-claude

Claude Code as a [Pi](https://github.com/earendil-works/pi) model provider:
an in-process TypeScript extension on the vendor
[Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript),
running on a Claude subscription.

Pi stays the harness. The extension runs `claude` as a stripped backend —
no settings, no vendor scaffolding, a tool surface asserted at startup —
so Pi owns the system prompt, the tools, and the transcript, and the model
answers through the subscription the CLI itself authenticates. Successor to
the [claude-go](../claude-go) bridge and its Pi adapter (ADR 0002 there);
the session-reconciliation doctrine carries over unchanged
(`DESIGN.md`, `docs/adr/0001`).

**Status: feature-complete, pre-parity.** Streaming, tool inversion
(Pi's tools hosted in-process, pause/resume), interrupt, occupancy and
cost, model/effort/account switches, images, and folding-as-a-no-op are
built and gated (`docs/specs/2026-08-31-pi-with-claude.md`); the paid
side-by-side parity demo against the claude-go provider and the npm
publish are still ahead. Not yet on npm.

## Use

```sh
pi install /path/to/pi-with-claude   # or the git source once published
```

Select provider `pi-with-claude`, model `haiku`, `sonnet`, `opus`, or
`fable` — the CLI's floating aliases. The real `claude` must be on PATH
and logged in; the extension never sees a credential. Pi's thinking
level drives `--effort` (`off` is hidden — the CLI cannot disable
reasoning); changing model, effort, tool set, or account reopens the
session at the cost of a fresh model context.

`/pi-with-claude` → **Account** picks which subscription the spawned
CLI authenticates as (an account is a `CLAUDE_CONFIG_DIR`; log one in
with `CLAUDE_CONFIG_DIR=~/.claude-<name> claude auth login`).
`PI_WITH_CLAUDE_ACCOUNTS` pins the roster, `PI_WITH_CLAUDE_ACCOUNT`
pins the choice, `PI_WITH_CLAUDE_DEBUG=<path>` traces seam events, and
`PI_WITH_CLAUDE_CLAUDE` points the SDK at another `claude` (the gate
aims it at the scripted fake).

## What this is not

- **Not a credential handler.** The spawned `claude` authenticates itself;
  nothing here reads, parses, logs, or forwards a credential (I1).
- **Not a full-harness backend.** Community adapters run Claude Code as a
  second harness behind Pi — settings, skills, session persistence. This
  extension strips all of that; running two harnesses double-injects
  scaffolding and double-captures hooks.
- **Not a client masquerade.** No system-prompt scrubbing, no header or
  user-agent spoofing (I2).
- **Not a general bridge.** The language-neutral wire died with its last
  non-Pi consumer; this serves Pi only.

## The gate

`scripts/verify.sh` is the definition of green: typecheck, unit tests, and
a token-free smoke driving real Pi with the extension against a scripted
fake `claude`. No gate spends a paid token; paid characterization is
deliberate and recorded as dated evidence.
