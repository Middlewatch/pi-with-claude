# Contracts

Frozen, language-neutral descriptions of the `claude` child-process wire
this extension speaks: the stream-json event families, the spawn argv,
the control channel, the in-process MCP dialect, and the neutral message
schema with its restart taxonomy.

**Provenance:** copied verbatim on 2026-08-31 from the claude-go
repository at commit `c6d30d7f7c903528459e7b5c4921f7edbd48c528`, where
each was characterized against the real `claude` (pinned versions and
capture dates are recorded inside each file). Per ADR 0002, claude-go's
copies freeze as history and this repo owns the living wire: a change
lands here first, through a deliberate, dated re-characterization
against a named CLI oracle rather than an ambient edit. File-internal
references to claude-go's `.local/` artifacts and Go test names are part
of the frozen provenance record and are left as written.

- `events.md`: the stream-json event families and the tolerant-decode
  posture (I4).
- `spawn-args.md`: the argument set the bridge spawns `claude` with.
- `control-channel.md`: the bidirectional control-request protocol
  (initialize, tool hosting, interrupt, context usage).
- `mcp-dialect.md`: the MCP subset spoken over the control channel for
  in-process tools.
- `bridge-v1.md`: the neutral message schema and prefix-match restart
  semantics (DESIGN.md "honest restart"); the NDJSON stdio transport it
  also describes is claude-go's and is not implemented here.
