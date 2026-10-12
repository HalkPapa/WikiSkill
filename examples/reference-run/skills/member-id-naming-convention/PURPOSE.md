# Purpose

## Origin
Created in iteration 1 after observing 6/6 member-ID-generation tasks fail. In every case the agent defaulted to the naive "FirstInitial+LastInitial+FullYear" convention (e.g. DK1985, EW1990, BN1995) despite extensive internal deliberation considering alternatives — it always converged back to the "feels standard" naive guess rather than a validated rule. The actual ground truth across all 6 tasks followed one single consistent formula.

## Patterns Addressed
- wiki/patterns/member-id-generation-wrong-convention.md

## Evolution History
- iter-01: Created skill encoding the concrete formula LASTNAME[:3].upper() + YY + FIRSTNAME[0].upper(), derived and verified against all 6 training examples (KOI85D, WAT90E, MEN78C, TAN01Y, PET69O, NG95B). Chose to give a concrete default formula (not just "consider alternatives") because the prior wiki guidance to "enumerate candidates" alone did not stop the agent from picking the naive default — a mechanical, concrete formula with worked examples is more likely to override the strong naive-default prior.
