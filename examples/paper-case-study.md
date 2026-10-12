# Case study from the paper (§5.3, Figure 3)

Source: arXiv:2608.27454. Qwen-3.6-27B on ALFWorld. The paper shows only names and one-line rules
("file contents are simplified"), so the SKILL.md bodies themselves are **not** published.

| Iter | Wiki pattern (Wiki Maintainer)        | Skill proposal (Skill Proposer)       | Gate     |
|------|---------------------------------------|---------------------------------------|----------|
| 0    | `take-examine-move-loop.md`           | `goal-directed-action` (create)       | Rejected |
| 1    | —                                     | `break-repetition-loop` (create)      | Accepted |
|      |                                       | rule: "Never Return an Item to Its Origin Location" | |
| …    | `multi-operation-loop.md` (new loop variant) | —                              | —        |
| 4    | —                                     | `break-repetition-loop` (edit)        | Accepted |
|      |                                       | new rule: "Each Operation Type ONCE Per Item" | |

What it shows: the rejection at iter 0 stays in `wiki/skill-impact.md` (diff + outcome), so the proposer at iter 1
avoids the failed idea; later wiki patterns drive refinement of an already accepted skill.

## Statistics the paper reports (Table 4, averages over runs)
- Accepted creations per run: ~1.2–1.6 (proposed 2.3–4.8); accepted edits: ~0.7–1.3 (proposed 3.2–5.7).
- Skill length: 45–129 lines on average (Gemma-4-31B shortest, Qwen models longest).
- Wiki: 6.3–8.9 pattern creations and 7.0–18.4 edits per run; wiki edits are all retained.
- Accepted updates cluster early: 39–52 % in iterations 0–1.

Skill names are chosen by the proposer LLM per run; there is no fixed list in the paper.

## Differences from this implementation
Follows the paper's loop, layout, Appendix C sampling and Appendix E.2 / E.3 prompts. What still differs:

**Not implemented**
- The five benchmarks and their environments (datasets, ALFWorld simulator, spreadsheet tooling; benchmark graders can
  be plugged in with `--scorer-cmd`), and the
  per-benchmark inference prompts of Appendix E.1 (ours is one generic prompt; `--task-desc` fills in the task).
- The baselines Trace2Skill, EvoSkill and SkillOpt. Cross-model skill transfer can be run with `wikiskill eval`,
  but the experiments themselves have not been run.
- The paper's models (Qwen-3.5/3.6, Gemma-4, Gemini-3.5-Flash). A text-only OpenAI-compatible backend
  (`--infer-backend openai`, e.g. vLLM) exists but has only been tested against a mock server.

**Implemented, but with assumptions**
- Inference-agent tools: optional Claude Code tools (`--agent-tools`) instead of the paper's bash/search/file
  readers; permission patterns, not a sandbox. The default is no tools.
- Proposer: `read_file` / `finish` are Claude Code's Read tool and the final JSON reply; traces are read at
  `raw/iter-NN/<task_id>.json` instead of a `traces/` alias. "Read at least 4 traces" is enforced from the
  transcript with a single reminder, then the proposal is accepted anyway.
- Wiki ablations: the paper does not say exactly what "no wiki access" means. Here the proposer works in a copy
  holding only `raw/` and `skills/` (so it also loses `skill-impact.md`); the agent variant copies `wiki/` into its
  workspace for every rollout (training, validation and test), not only training.
- Statistics: one-sided paired bootstrap of the evolved skills against the no-skill baseline (1,000 resamples, seeded);
  no tie grouping across several methods, since there are no other methods.
- Test evaluation is run once at the end, from the final skill set; the number of runs, iterations and split sizes are
  user-chosen (the paper's are in its Table 6 / Appendix B).

**Small deviations**
- Skill names are kebab-case (the paper's prompt says snake_case, its case study shows kebab-case).
- Prompt additions: SKILL.md must start with frontmatter; an optional `rationale` and `resources` field.
- The wiki log file is `logs.md` (the paper's prompt says `log.md`, its structure list says `logs.md`).
- Iterations are numbered from 1 (`raw/iter-01`); the paper's figures and tables count from 0. The baseline
  validation is scored before iteration 1.
- A run starts from an empty skill set and wiki (as in the paper) and refuses a non-empty directory unless
  `--resume` or `--force` is given.
