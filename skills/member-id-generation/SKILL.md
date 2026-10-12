---
name: member-id-generation
description: Use when asked to generate/compute an 'internal member ID' (or similarly-named deterministic ID) for a person given name, surname, and birth year, especially when no explicit format spec is given in the task text.
---

## When to apply
Task asks to "generate the internal member ID" (or a clearly analogous deterministic-ID task) for a person described by given name, surname, and birth year, with no explicit format specification stated in the prompt.

## Steps
1. Do NOT invent an ad-hoc format (e.g. initials+year, first3+last3+year, hyphenated schemes) and do NOT call a guess "standard" or "commonly used" without basis.
2. First check the conversation/task context and wiki for any given examples of (name, year) -> ID pairs. If examples exist, reverse-engineer the exact character-by-character rule from them before answering.
3. If no examples are available, apply this confirmed house convention for this task family:
   `ID = SUR + YY + G`
   - `SUR` = first 3 letters of the surname, uppercase. If the surname has fewer than 3 letters, use the whole surname unpadded.
   - `YY` = last two digits of the birth year, zero-padded to 2 digits.
   - `G` = first letter of the given name, uppercase.
   - No separators (no hyphens/spaces/underscores), no sequence numbers, no extra letters.
4. Before finalizing, sanity-check the output against the rule by recomputing each component separately (surname slice, year mod 100, given-name initial) rather than eyeballing it.
5. General principle: when a task is templated (same phrasing, varying person details, repeated across a batch), assume a single fixed deterministic rule governs all instances — recall/derive it once, then apply it identically to every instance, rather than re-deriving a new scheme per instance.
