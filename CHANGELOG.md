# Changelog

Versions are the npm package (`pi-with-claude`). The wire the extension speaks
is characterized against a pinned `claude` CLI version (`docs/contracts/`); each
re-pin is listed here with what moved.

## 0.2.0 - 2026-10-13

Pi 0.85.1 and later move the system prompt and tool declarations into the
transcript, so 0.1.0 reaches the model with no prompt and no tools on a current
Pi. This release is required on Pi 0.85.1+.

### Fixed

- Read the system prompt and tools from the transcript's system messages when
  Pi puts them there (0.85.1 and later, PR 9548); older Pi still supplies
  `context.systemPrompt` and `context.tools` and is read as before.
- A `tool_use` block the CLI answered itself (a model-invented tool name gets a
  `tool_use_error` from the CLI, never a host dispatch) is dropped instead of
  handed to Pi. Previously Pi executed and failed it, the next turn read that
  result as stale, and the session reopened with nothing sendable.
- A backend refusal (lapsed subscription, third-party billing 400) ends the turn
  as an error stop carrying the CLI's result text, rather than as an ordinary
  reply with a normal stop.
- A reply Pi recorded as failed (an error stop, or an Esc that landed while a
  tool ran) is skipped by the history diff rather than read as foreign history
  that forces a fresh session.
- The dead-end message for a forced fresh session names the actual cause
  (history rewritten, resumed history, foreign assistant history, a stale tool
  result between turns, an unclaimable result on a paused turn) and what went
  undelivered, instead of blaming "history changed underneath" for all five.
- An inherited `CLAUDE_CONFIG_DIR` leads account discovery, so a relocated
  default outside `~/.claude*` still appears as the running account.

### Changed

- `/reload` keeps the `claude` child. The idle session is parked across the
  extension reload and adopted by the new runtime; a parked child nobody adopts
  within 30 s is closed. Every other shutdown reason still closes the child.
- Steering: a message typed while tools run goes down with the tool results and
  reaches the model on its next request, rather than waiting for the turn to
  end. A prompt that starts with `/` is marked `client_composed` so the CLI
  hands it to the model instead of running it as a slash command.
- Wire contracts re-pinned through claude 2.1.267, 2.1.270, 2.1.281, 2.1.292,
  and 2.1.296 with zero drift on every depended-on surface. The floating
  aliases moved with the CLI: `opus` resolves to Opus 5.5 (2.1.281), `sonnet`
  to Sonnet 5.5 (2.1.292), and `haiku` to Haiku 5.5 with a 1M context window
  (2.1.296, previously `claude-haiku-4-5-20251001` at 200k).
- The child environment sets `CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH=1000000`
  so Pi's longer tool descriptions arrive whole instead of cut at the CLI's
  2,048-character default; a value already in the parent environment wins.
  Needs claude 2.1.280 or later.
- The first tool call of a stretch streams its arguments live from the wire's
  `input_json_delta` pieces (display only; the authoritative block still comes
  at the pause). Trial feature: revert if anything looks strange in use.
- Development dependencies track Pi 1.2.0 and add `@earendil-works/pi-ai` so
  typecheck resolves the import Pi's loader aliases at runtime. The package
  still installs nothing.
- `CHANGELOG.md` ships in the package.

## 0.1.0 - 2026-09-02

Initial release: Claude Code as a Pi model provider over the CLI's stream-json
wire, characterized against claude 2.1.258.
