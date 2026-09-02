# pi-with-claude

Claude Code as a [Pi](https://github.com/earendil-works/pi) model provider: an
in-process TypeScript extension speaking the CLI's documented stream-json wire
directly, with no runtime dependencies, on a Claude subscription.

The extension runs `claude` as a stripped backend, so Pi owns the system
prompt, the tools, and the transcript, and the model answers through the
subscription the CLI itself authenticates.

The CLI adds a few things on its own side of the wire that the extension
cannot remove (observed at claude 2.1.258):

- The line `You are a Claude agent, built on Anthropic's Claude Agent SDK.` is
  prepended to the system prompt, with no newline after it.
- A `<system-reminder>` carrying your account email and today's date is
  injected into the first user message.
- Behind feature flags, a nudge is appended to user turns and tool results
  ("First privately list what you need next..."), and after a run of tool
  calls with no text, "The user hasn't heard from you in a while".

## Use

```sh
pi install npm:pi-with-claude
pi install git:github.com/Middlewatch/pi-with-claude   # or from source
```

Select provider `pi-with-claude`, model `haiku`, `sonnet`, `opus`, or `fable`
(the CLI's floating aliases). The real `claude` must be on PATH and logged in;
the extension never sees a credential. Pi's thinking level drives `--effort`
(`off` is hidden because the CLI cannot disable reasoning); changing model,
effort, tool set, or account reopens the session at the cost of a fresh model
context.

### Accounts

`/pi-with-claude` → **Account** picks which subscription the spawned CLI
authenticates as. An account is a `CLAUDE_CONFIG_DIR`: log one in with
`CLAUDE_CONFIG_DIR=~/.claude-<name> claude auth login` and it appears in the
menu (discovery covers `~/.claude` and `~/.claude-*`, labelled by
`claude auth status`). The choice persists at
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

## What this is not

- **Not a credential handler.** The spawned `claude` authenticates itself;
  nothing here reads, parses, logs, or forwards a credential.
- **Not a full-harness backend.** Community adapters run Claude Code as a
  second harness behind Pi (settings, skills, session persistence). This
  extension strips all of that; running two harnesses double-injects
  scaffolding and double-captures hooks.
- **Not a client masquerade.** No system-prompt scrubbing, no header or
  user-agent spoofing.
- **Not a general bridge.** This serves Pi only.

## Development

`scripts/verify.sh` is the definition of green: typecheck, unit tests, and a
token-free smoke driving real Pi against a scripted fake `claude`. CI runs
exactly it. The wire is characterized against a named CLI version
(`docs/contracts/`, currently claude 2.1.258); a re-pin is a deliberate,
dated commit.
