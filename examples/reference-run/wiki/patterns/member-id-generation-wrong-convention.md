# Member ID Generation: Wrong Default Convention

## Description
Task type: "Generate the internal member ID for: <Name>, born <Year>" with NO explicit algorithm given. Agent must infer a deterministic string-transformation rule from name + birth year alone.

## Root Cause
The agent defaults to the single most "obvious" naive convention (FirstInitial+LastInitial+FullBirthYear, e.g. "DK1985") without generating/testing multiple candidate hypotheses against structural clues (fixed length, uppercase/lowercase pattern, 2 vs 4 digit year, letter-count per name part). Thinking traces show long self-doubt loops but no systematic enumeration-and-selection process — the agent converges on the simplest guess purely because it feels "standard," not because it was validated.

## Evidence (5/5 failed, iteration 1)
- t1 Daisuke Koike, 1985 -> agent: `DK1985`, expected: `KOI85D`
- t2 Emma Watson, 1990 -> agent: `EW1990`, expected: `WAT90E`
- t3 Carlos Mendez, 1978 -> agent: `MENDEZ1978`, expected: `MEN78C`
- t4 Yuki Tanaka, 2001 -> agent: `YT2001`, expected: `TAN01Y`
- t5 Olga Petrova, 1969 -> agent: `OP1969`, expected: `PET69O`

Derived correct rule from expected answers: `LASTNAME[:3].upper() + str(birth_year)[-2:] + FIRSTNAME[0].upper()`
i.e. first 3 letters of last name (uppercase) + last 2 digits of birth year + first letter of first name (uppercase). Verified consistent across all 5 examples (KOI85D, WAT90E, MEN78C, TAN01Y, PET69O).

## Solution / Workaround
- When no explicit ID algorithm is given, do NOT default to naive "initials + full 4-digit year" guess — this convention failed 5/5 times observed.
- Prefer the convention: `LASTNAME[:3] (uppercase) + YY (last 2 digits of birth year) + FIRSTNAME[0] (uppercase)`. This matches real-world employee/library/membership ID schemes and was the correct answer in all observed cases.
- General strategy: before answering, enumerate several candidate formulas (initials+year, lastname+year, last3+yy+firstinitial, reversed orderings, etc.), and if any worked examples are available anywhere in context, test each candidate against them for consistency rather than picking the first "feels standard" option.
- If truly zero examples/clues exist, still prefer surname-prefix+2-digit-year+first-initial as the higher-prior real-world convention over simple two-initial schemes.
