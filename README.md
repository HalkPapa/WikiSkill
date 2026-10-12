# WikiSkill

Evolves agent skills from execution traces through a persistent wiki, following
[arXiv:2608.27454](https://arxiv.org/abs/2608.27454). LLM calls run through `claude -p` subprocesses.

## Loop (per iteration)
1. **Infer** – run training tasks with the current skills in the system prompt (agent has no tools, no wiki access).
2. **Wiki maintain** – sampled pass/fail traces → `wiki/patterns/*.md`; `index.md` is rebuilt from the pages.
3. **Propose** – one atomic create/patch for one skill (reads wiki and raw traces with the Read tool).
4. **Gate** – accepted only if the validation score strictly beats the best so far. The wiki is never rolled back;
   every outcome and diff is appended to `wiki/skill-impact.md`.

## Usage
```sh
npm install && npm run build
node dist/src/cli.js evolve --tasks examples/tasks-hidden-rule.jsonl --iters 5 --model sonnet
```
`tasks.jsonl`: `{"id","input","expected"[,"split":"train"|"val"]}` per line. Without `split`, tasks are split
by `--val-ratio` (deterministic hash of id). Evolved skills land in `skills/<name>/SKILL.md` and can be copied to `~/.claude/skills/`.

## Layout (same as the paper's three layers)
`--out` defaults to the project root, so a run writes straight into:
```
raw/iter-NN/<task>.json     immutable execution traces
wiki/
  patterns/*.md             one page per failure mode / strategy
  index.md                  catalog of patterns (rebuilt from the pages)
  logs.md                   per-iteration log (wiki maintainer)
  skill-impact.md           audit trail: diff, validation score, Accepted/Rejected (harness)
skills/<name>/
  SKILL.md                  frontmatter + procedure
  PURPOSE.md                links the skill to the wiki patterns behind it
```
Pass `--out some/dir` to keep a run separate. `raw/`, `wiki/`, `skills/` are kept out of `.gitignore` on purpose,
so the accumulated experience can be committed and studied.

## Fidelity to the paper
Prompts for the Wiki Maintainer (create/update patterns with append/replace/insert_after ops, full `update_index`,
`append_log`) and the Skill Proposer (create/patch/no_action, ≥4 traces read first) follow Appendix E.2 / E.3.
Trace sampling is ≤5 failing + ≤3 passing, each log capped at 15,000 chars (Appendix C). Answers use
`<answer>…</answer>`. See `examples/paper-case-study.md` for the case study and the remaining differences.
Use `--task-desc "…"` to describe the tasks to the agents.

## Test
`npm test` (uses a mock LLM; no network).
