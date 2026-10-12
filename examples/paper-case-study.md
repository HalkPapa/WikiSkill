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
The prompts, output formats and sampling follow the paper's Appendix C and E. What still differs:
- Inference prompt: paper uses a task-specific prompt per benchmark; ours is one generic prompt
  (`--task-desc` fills "an expert agent that solves …"). Answers use `<answer>…</answer>` tags as in the paper
  (a trailing `ANSWER:` line is accepted as a fallback).
- Inference agents: the paper's have environment tools (bash, search, file readers); ours answer in plain text.
- Proposer tools: the paper's `read_file` / `finish` are Claude Code's Read tool and the final JSON reply;
  traces are read at `raw/iter-NN/<task_id>.json` instead of a `traces/` alias. It is asked to read ≥4 traces,
  but that is not enforced.
- Skill names: kebab-case (paper's prompt says snake_case, its case study shows kebab-case).
- Prompt additions: the proposer is told SKILL.md must start with frontmatter and may add a `rationale`.
- Wiki log file is `logs.md` (the paper's prompt says `log.md`, its structure list says `logs.md`).
- Starting state: every run starts from an empty skill set (as in the paper) and does not resume from `skills/`.
- Splits, models and iteration count are user-chosen; the paper's are in its Table 6 / Appendix B.
