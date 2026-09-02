# 0003: Retire DESIGN.md; invariants live in AGENTS.md and the code

Date: 2026-09-02
Status: accepted

## Context

`DESIGN.md` carried claude-go's invariants (I1, I2, I6, I7, I8) and session
doctrine verbatim. The as-built review before 0.1.0 found it drifting from
the code in three places (I7's promised fields, I8's silence on the account
probe, the index-wise prefix rule `diffNew` never implemented), while the
same rules were already stated where they bind: `AGENTS.md` restated I1
and I2, `assertInitSurface` is I6, the result handler's comments are I7,
and the `bridge.ts` and `accounts.ts` headers are I1, I2, and I8. Two
homes for one rule is where drift starts.

## Decision

Delete `DESIGN.md`. `AGENTS.md` (the file both harnesses read) holds the
invariant list, keeping the I-labels because `src/`, `docs/contracts/`,
and `tests/` cite them by number. Session doctrine that the code already
states stays in the code and the contracts; ADR 0001 keeps the
identity-key decision. Historical documents (`docs/specs/`, ADR 0002) keep
their `DESIGN.md` references as written.

## Consequences

One place to update when an invariant changes, and it is the place the
agent reads on every session. The tarball drops `DESIGN.md`; the public
statement of what the extension refuses to do is the README's "What this
is not". A rule that needs more than a bullet gets an ADR.
