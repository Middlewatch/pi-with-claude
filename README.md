# pi-with-claude

Claude Code as a [Pi](https://github.com/earendil-works/pi) model provider: an
in-process TypeScript extension speaking the CLI's documented stream-json wire
directly, with no runtime dependencies, on a Claude subscription.

The extension runs `claude` as a stripped backend. Pi owns the system prompt,
the tools, and the transcript, and the model answers through the subscription
the CLI itself authenticates.

## Use

```sh
pi install npm:pi-with-claude
pi install git:github.com/Middlewatch/pi-with-claude   # or from source
```

Select provider `pi-with-claude` and model `haiku`, `sonnet`, `opus`, or
`fable` (the CLI's floating aliases). The real `claude` must be on PATH and
logged in, since the extension never sees a credential. Pi's thinking level
drives `--effort`, with `off` hidden because the CLI cannot disable reasoning.
Changing model, effort, tool set, or account reopens the session at the cost of
a fresh model context.

### Accounts

`/pi-with-claude` → **Account** picks which subscription the spawned CLI
authenticates as. An account is a `CLAUDE_CONFIG_DIR`. Log one in with
`CLAUDE_CONFIG_DIR=~/.claude-<name> claude auth login` and it appears in the
menu, since discovery covers `~/.claude` and `~/.claude-*` and labels each
directory from `claude auth status`. The choice persists at
`$XDG_CONFIG_HOME/pi-with-claude/account` (default `~/.config/...`) and takes
effect on the next turn.

### Environment

- `PI_WITH_CLAUDE_ACCOUNTS`: `label=dir` pairs, `:` or `,` separated, that
  replace account discovery.
- `PI_WITH_CLAUDE_ACCOUNT`: a dir or roster label that pins the account and
  makes the menu read-only.
- `PI_WITH_CLAUDE_CLAUDE`: path of the `claude` binary to spawn (the gate aims
  it at a scripted fake).
- `PI_WITH_CLAUDE_DEBUG=<path>`: append one line per seam event.

## What the CLI adds on its own

A few things reach the model from the CLI's side of the wire, where the
extension cannot remove them (observed at claude 2.1.258):

- The line `You are a Claude agent, built on Anthropic's Claude Agent SDK.` is
  prepended to the system prompt, with no newline after it.
- A `<system-reminder>` carrying your account email and today's date is
  injected into the first user message.
- Behind feature flags, a nudge is appended to user turns and tool results
  ("First privately list what you need next...") and, after a run of tool
  calls with no text, "The user hasn't heard from you in a while".

## History and folding

The `claude` child is stateful: the extension sends each new user input down
the wire and the CLI keeps the conversation. Pi history the session has already
absorbed stays there. When Pi rewrites that history (branch navigation,
compaction, a stale tool result), the extension restarts the session clean from
the newest user input rather than replaying an edited transcript as if the
model had lived it.

Folding extensions such as context-fold are the exception. They rewrite
absorbed history in place, masking a stale tool result's content or a thinking
block's text to a short digest, and the CLI cannot be reseeded with the edited
version. The extension therefore keys its history diff by identity (a tool
result by its call id and error flag, a thinking block by its type alone), so a
fold diffs as history already absorbed and the session continues, with the
model keeping the full content the digest stands for. The CLI's own compaction
manages the real window. The trade-off is that a genuine in-place edit to an
already-seen tool result's content or thinking text is invisible to the
extension, and no known Pi source produces one apart from folding.

## Boundaries

- **Credentials stay with the CLI.** The spawned `claude` authenticates itself;
  nothing here reads, parses, logs, or forwards a credential.
- **Pi is the only harness.** Community adapters run Claude Code as a second
  harness behind Pi (settings, skills, session persistence). This extension
  strips all of that, because two harnesses double-inject scaffolding and
  double-capture hooks.
- **The client is what it says it is.** No system-prompt scrubbing and no
  header or user-agent spoofing.
- **Pi is the only host.** Nothing here serves another consumer.

## Why a native bridge and not the Agent SDK

The Agent SDK declares itself to the CLI (`CLAUDE_CODE_ENTRYPOINT=sdk-ts`).
Since 2026-08-31 the backend bills a session to extra usage rather than plan
limits when that declaration coincides with a system prompt its classifier
reads as a third-party harness, and Pi's default prompt is one. Either signal
alone bills to plan limits. The pair returns 400 the moment the extra-usage
pool is empty. Driving the CLI's stream-json wire directly, with no identity
declaration of any kind, bills to plan limits with identical prompt content.
Stripping the SDK's variable while keeping the SDK would misrepresent the
client and was never considered.

The cost is inheriting what the SDK existed to absorb: the wire moves roughly
25 CLI releases a month, and this repository tracks it through a pinned
`claude` version (`docs/contracts/`). If enforcement later keys on prompt
content alone, this path fails too, and the sanctioned fallback is funded extra
usage.

## Development

`scripts/verify.sh` is the definition of green: typecheck, unit tests, and a
token-free smoke driving real Pi against a scripted fake `claude`. CI runs
exactly it. The wire is characterized against a named CLI version
(`docs/contracts/`, currently claude 2.1.267), and a re-pin is a deliberate,
dated commit.
