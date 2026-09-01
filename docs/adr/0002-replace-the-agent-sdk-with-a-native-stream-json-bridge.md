# 0002: Replace the Agent SDK with a native TypeScript stream-json bridge

Date: 2026-08-31
Status: accepted

## Context

On 2026-08-31 the backend began billing sessions as "third-party apps" (extra
usage, not plan limits) when two signals coincide: the Agent SDK's
self-identification (`CLAUDE_CODE_ENTRYPOINT="sdk-ts"`) and a system prompt its
classifier recognizes as a third-party harness (Pi's default prompt). Either
signal alone bills to plan limits; the pair 400s the moment the extra-usage
pool is empty. claude-go, which speaks the same SDK-oracle wire but spawns the
CLI itself, bills to plan limits with identical prompt content — line-level
bisection and side-by-side probes in
`.local/evidence/2026-08-31-thirdparty-billing-classification.md`. Stripping
the SDK's entrypoint variable while keeping the SDK would misrepresent the
client (I2) and was not considered. The owner rules that driving the CLI's
documented stream-json wire directly, as claude-go has done throughout, is
within ToS and not a grey area.

## Decision

Port claude-go's bridge to TypeScript inside this extension and drop
`@anthropic-ai/claude-agent-sdk`. The extension spawns `claude` itself,
speaking bidirectional stream-json per the frozen claude-go contracts
(`contracts/bridge-v1.md`, `control-channel.md`, `events.md`, `mcp-dialect.md`,
`spawn-args.md`), making no identity declaration of its own.

## Consequences

The Go middleman goes away (the original goal of this project) and sessions
bill to plan limits like every other Claude Code invocation. We reinherit what
the SDK existed to absorb: wire drift (~25 CLI releases a month) is now ours to
track, with the CLI pin replacing the SDK pin as the deliberate,
verified-in-its-own-commit bump. The claude-go contracts and fixtures become
the port's characterization base and stay load-bearing. If enforcement later
keys on prompt content alone, this path fails with claude-go's, and the
sanctioned fallback is funded extra usage.

## Considered options

- **Keep the SDK, fund extra usage**: sanctioned but per-token API rates for
  every session; rejected as the daily-driver economics.
- **Wait for the paused SDK-credit policy to settle**: zero work, but blocks
  the project's goal indefinitely on a vendor timeline.
- **Strip `CLAUDE_CODE_ENTRYPOINT` under the SDK**: one line, and exactly the
  identity misrepresentation I2 exists to prohibit; rejected outright.
