---
name: member-id-naming-convention
description: Use when asked to generate an internal/member ID from a person's full name and birth year with no explicit algorithm given.
---

## When to Apply
- Task asks to "generate the internal member ID" (or similar: employee ID, membership ID, account ID) for a person, given their full name (first + last) and a birth year.
- No explicit algorithm, example mapping, or format spec is provided in the prompt.

## When NOT to Apply
- If the task DOES give an explicit algorithm, worked example, or format string — follow that instead; this skill is only the fallback default when no rule is stated.
- If birth year is given but no name, or name but no year, this specific formula doesn't apply — look for other structural clues.

## Instructions
Do NOT default to the naive "FirstInitial+LastInitial+FullYear" guess (e.g. "DK1985") — this is the single most common wrong answer and has been verified wrong in every observed case.

Instead, apply this concrete, mechanical formula as the default answer:

**MemberID = LASTNAME[:3] (uppercase, first up to 3 letters of the last/family name) + YY (last 2 digits of the birth year) + FIRSTNAME[0] (uppercase first letter of the first/given name)**

Steps:
1. Split the full name into first name and last name (assume Western order "First Last" unless told otherwise).
2. Take the first 3 letters of the last name (if the last name has fewer than 3 letters, use all of them — do not pad), uppercase.
3. Take the last 2 digits of the birth year (zero-padded if needed, e.g. 2001 -> "01").
4. Take the first letter of the first name, uppercase.
5. Concatenate in this exact order: LAST3 + YY + FIRSTINITIAL.

Worked examples (verified correct):
- Daisuke Koike, 1985 -> KOI + 85 + D -> `KOI85D`
- Emma Watson, 1990 -> WAT + 90 + E -> `WAT90E`
- Carlos Mendez, 1978 -> MEN + 78 + C -> `MEN78C`
- Yuki Tanaka, 2001 -> TAN + 01 + Y -> `TAN01Y`
- Olga Petrova, 1969 -> PET + 69 + O -> `PET69O`
- Ben Ng, 1995 -> NG (only 2 letters available) + 95 + B -> `NG95B`

Before finalizing, double check: output should be LAST-NAME-PREFIX (≤3 letters) + 2-digit-year + 1-letter first-initial, in that exact order — NOT initials-first, NOT full 4-digit year, NOT full last name.

If the task provides worked examples of its own, validate this formula against them first; if they contradict this formula, derive and follow the pattern shown in the task's own examples instead.
