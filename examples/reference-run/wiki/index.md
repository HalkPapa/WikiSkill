# Wiki Index

- [member-id-generation-wrong-convention](wiki/patterns/member-id-generation-wrong-convention.md): Member ID generation tasks (name+birth year, no explicit algorithm) consistently fail because the agent defaults to a naive "FirstInitial+LastInitial+FullYear" guess (e.g. DK1985) instead of testing alternatives; the actual correct rule observed is LASTNAME[:3]+YY+FIRSTINITIAL (e.g. Koike/1985/Daisuke -> KOI85D). Fix: try the last-name-prefix + 2-digit-year + first-initial convention and validate against any available examples before answering.
