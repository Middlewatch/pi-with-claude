# Contracts

Frozen, language-neutral descriptions of the `claude` child-process wire
this extension speaks: the stream-json event families, the spawn argv,
the control channel, the in-process MCP dialect, and the neutral message
schema with its restart taxonomy.

Each file names the `claude` version and date it was characterized
against. A change lands through a deliberate, dated re-characterization
against a named CLI oracle rather than an ambient edit. The raw captures
live in the maintainer's untracked evidence surround (`.local/`), and the
committed excerpts are the frames in `fixtures/`.

- `events.md`: the stream-json event families and the tolerant-decode
  posture (I4).
- `spawn-args.md`: the argument set the bridge spawns `claude` with.
- `control-channel.md`: the bidirectional control-request protocol
  (initialize, tool hosting, interrupt, context usage).
- `mcp-dialect.md`: the MCP subset spoken over the control channel for
  in-process tools.
- `bridge-v1.md`: the neutral message schema and the prefix-match
  restart taxonomy (AGENTS.md "honest restart").
