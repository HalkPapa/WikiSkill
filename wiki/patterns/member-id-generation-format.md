# Member ID Generation Format
> When asked to "generate the internal member ID" for a person with no explicit format spec given, agents hallucinate ad-hoc schemes instead of the actual fixed rule, causing 100% failure.

## Symptoms
- Task phrasing: "Generate the internal member ID for: <Given> <Surname>, born <Year>."
- No ID-format specification is provided in the task text.
- Agent invents a plausible-sounding but wrong scheme (e.g. first-initial+last-initial+year, or first3+last3+year, or random separators/sequence numbers), explicitly labeling it "standard" or "commonly used" with no basis.
- All 6 sampled attempts failed, each with a *different* invented format, confirming the agent is guessing rather than applying a consistent known rule.

## Root Cause
The agent treats an underspecified task as license to fabricate a convention, rather than recognizing that:
1. A deterministic, consistent ID scheme exists and is expected to be inferred/recalled, not invented fresh each time.
2. The agent never pauses to check whether prior examples/outputs in the conversation or wiki reveal the real rule before committing to an answer.

## Evidence (task ids)
t1, t2, t3, t4, t5, t6 — all FAIL, each with a distinct fabricated format and confident "standard scheme" framing.

## Correct Rule (reverse-engineered from expected answers)
Format: `SUR` + `YY` + `G`
- `SUR` = first 3 letters of the **surname**, uppercase. If the surname has fewer than 3 letters, use the whole surname (no padding).
- `YY` = last two digits of the birth year, zero-padded to 2 digits (e.g. 2001 → "01").
- `G` = first letter of the **given name**, uppercase.
- No separators (no hyphens/spaces), no sequence numbers.

Verification against all sampled examples:
| Name | Born | Expected | Breakdown |
|---|---|---|---|
| Daisuke Koike | 1985 | KOI85D | KOI + 85 + D |
| Emma Watson | 1990 | WAT90E | WAT + 90 + E |
| Carlos Mendez | 1978 | MEN78C | MEN + 78 + C |
| Yuki Tanaka | 2001 | TAN01Y | TAN + 01 + Y |
| Olga Petrova | 1969 | PET69O | PET + 69 + O |
| Ben Ng | 1995 | NG95B | NG (surname <3 letters, use all) + 95 + B |

## Workaround / Strategy
1. For any "generate internal member ID" task, apply the rule: `SURNAME[:3].upper() + str(year)[-2:].zfill(2) + GIVENNAME[0].upper()`, with no separators or extra digits.
2. Do NOT invent a new scheme per task, do NOT add sequence numbers, hyphens, or extra letters, and do NOT describe a guess as "standard" — if a format must be inferred, first check whether a consistent rule can be derived from any given examples before answering.
3. If genuinely no examples or spec are available and this rule cannot be confirmed, default to this documented SUR+YY+G rule since it is the confirmed house convention for this task family.
4. General lesson: when a task looks templated/repeated (same phrasing, different people), assume there is one fixed underlying rule — look for it or recall it — rather than ad-libbing a new, individually-justified format each time.
