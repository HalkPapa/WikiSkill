# WikiSkill

> **🚧 Work in progress / 作成中**
> This project is under active construction and experimental. CLI options, file formats and prompts may change without
> notice, results have **not** been validated against the paper, and it is not ready for production use.
> 本プロジェクトは作成中の実験的なものです。CLIオプション・ファイル形式・プロンプトは予告なく変わることがあり、
> 論文の結果との一致も検証していません。本番利用には向きません。
>
> **Use at your own risk / 利用は自己責任で** – see [Copyright and disclaimer](#copyright-and-disclaimer).

An unofficial TypeScript implementation of the framework described in
[**WikiSkill: Compiling Agent Experience into Persistent Knowledge for Skill Evolution**](https://arxiv.org/abs/2608.27454)
(Tang, Rashtchian, Ferng, Tomkins, Juan, Vu; arXiv:2608.27454, Aug 2026).
It is **not** the authors' code (I found no official release); it is rebuilt from the paper's text and appendices.
The idea belongs to the paper's authors; see [Credits](#credits-and-original-ideas).

An agent's trial and error is compiled into a persistent **wiki** of failure modes and strategies, and that wiki guides
the evolution of **skills** (`SKILL.md` procedures). A skill edit is kept only if it improves a validation score.
Model weights are never updated.

## How it works

Each iteration:

1. **Infer** – roll out the agent on training tasks with the current skills injected into its system prompt.
   By default the agent has no tools and cannot see the wiki.
2. **Wiki maintain** – an LLM reads sampled traces (≤5 failing, ≤3 passing, each capped at 15,000 chars), does
   root-cause analysis, and creates/patches `wiki/patterns/*.md`, the index and the log.
3. **Propose** – an LLM explores the wiki and raw traces with a Read tool and proposes **one** atomic change to **one**
   skill (create / patch / no_action).
4. **Gate** – the candidate skill set is scored on the validation split; it is accepted only if the score **strictly**
   beats the best so far. Otherwise skills roll back, but the wiki never does. The outcome and diff are appended to
   `wiki/skill-impact.md`, so later proposals can avoid repeating rejected ideas.

Evolution starts from an empty skill set and an empty wiki and stops early when validation reaches 1.0.

## Quick start

Requirements: Node 22+, and the [`claude` CLI](https://claude.com/claude-code) logged in (all LLM calls run as
`claude -p` subprocesses, so no API key is needed).

```sh
npm install && npm run build
node dist/src/cli.js evolve --tasks examples/tasks-hidden-rule.jsonl --out runs/demo --iters 3 \
  --model sonnet --task-desc "member ID generation tasks"
```

`tasks.jsonl` has one `{"id","input","expected"[,"split":"train"|"val"|"test"]}` object per line. Tasks without a
`split` are divided by `--val-ratio` / `--test-ratio` (deterministic hash of the id). The answer is read from
`<answer>…</answer>` in the agent's reply and compared with `expected` (`--scorer exact|contains`).

> A finished example run is in [`examples/reference-run/`](examples/reference-run/) (try `check --run` on it). A run
> needs an empty `--out` directory (default `runs/default`, git-ignored): use `--resume` to continue a previous run or
> `--force` to wipe and restart one. A directory holding files that are not from a WikiSkill run is never touched.

### Options

| Option | Meaning |
|---|---|
| `--out <dir>` | run directory (default `runs/default`); must be empty or a previous run |
| `--iters <n>` | iterations (default 5) |
| `--runs <n>` | independent full runs, averaged; each in `<out>/run-N` (the paper uses 3); needs a clean `--out`, cannot be combined with `--resume` |
| `--max-cost <usd>` | stop before the next call once the claude CLI's reported cost reaches this (list price, not what a subscription bills); continue with `--resume`. Usage is printed at the end and recorded in `manifest.json` (`usage`) and per row (`cost_usd`) |
| `--run-label run-N` | label for a single run, so the runs of one experiment can be done one at a time (`--out runs/x/run-2 --run-label run-2`) |
| `--resume` / `--force` | continue a previous run (loads its skills and wiki) / delete it and start over |
| `--val-ratio`, `--test-ratio` | shares of unsplit tasks for validation / test (defaults 0.4 / 0) |
| `--train-sample <n>` | max training tasks per iteration |
| `--concurrency <n>` | parallel rollouts (default 4) |
| `--model <m>` | Claude model for the wiki maintainer and skill proposer (and the agent by default) |
| `--infer-model <m>` | model for the task-solving agent |
| `--infer-backend claude\|openai` | `openai` = OpenAI-compatible server such as vLLM (text only); needs `--base-url`, `--infer-model` |
| `--agent-tools "Read,Bash(python3 *)"` | Claude Code tools for the task agent (default none) |
| `--proposer-no-wiki` | ablation (paper Table 3): the skill proposer has no wiki access and the wiki maintainer is removed too |
| `--inference-wiki` | ablation: the task agent may read the wiki during training rollouts (not during validation/test, as in the paper) |
| `--scorer exact\|contains` | built-in answer matching (default `exact`) |
| `--scorer-cmd "<cmd>"` | external grader instead (see [Plugging in a grader](#plugging-in-a-grader)) |
| `--task-desc "<text>"` | completes "an expert agent that solves …" in the prompts |

With a test split, the final skills and a no-skill baseline are scored on it, and a paired bootstrap
(1,000 resamples, p < 0.05; the paper does not say whether its test is one- or two-sided, this tool uses one-sided) compares them. Results are written to `report.json`.

## Evaluating and transferring skills (`eval`)

`eval` scores existing skill directories without evolving anything, e.g. the paper's cross-model transfer check (§4.2.2):
run skills evolved with one model under another model and compare them with that model's own skills and with no skills.

```sh
node dist/src/cli.js eval --tasks tasks.jsonl --split test --infer-model haiku \
  --skills own=runs/haiku/skills --skills from-sonnet=runs/sonnet/skills --repeats 3
```

A no-skill baseline is always scored; each set gets a paired-bootstrap p-value against it, and later sets also against
the first. `--split` is `test` (default), `val`, `train` or `all`; the split rules are the same as in `evolve`, so the
same ratios select the same tasks. `--report <file>` saves the result as JSON.

### Plugging in a grader

The built-in scorers only compare strings. For benchmarks that need a real grader (spreadsheet diffs, simulators, …),
pass `--scorer-cmd "<command>"`. It is run through `sh -c` once per answer, receives
`{"id","input","expected","answer"}` as JSON on stdin, and prints `true`/`false`, `1`/`0` or `{"correct": true}`.
A failing command or timeout (60 s) counts as wrong. The command runs on your machine with your permissions.

## Handing results to another team

Final scoring and comparison with external AIs can be done by someone else without re-running anything: a run keeps
every answer, the full execution log and the exact system prompts, in a versioned format (`schema_version: 1`).

```sh
node dist/src/cli.js check   --run <run dir>                      # is this run complete and consistent?
node dist/src/cli.js rescore --predictions <run dir>/results/predictions.jsonl --scorer-cmd "…" [--baseline <condition>]
```

- `check` verifies the manifest, the task splits, the prediction rows, the archived prompts, the skills' hashes, the
  pinned content hashes, that no agent or grader call failed, and that the held-out test split left no trace in
  anything produced during evolution. The proposer works in a sandbox copy that holds no validation or test truths.
- `rescore` re-grades stored predictions with another scorer (and optionally re-extracts the answers) and compares
  conditions with a paired bootstrap. Rows for an external AI use the same schema (`condition: "external:<name>"`).
- Full guide for the receiving team (in Japanese): [`docs/HANDOFF.md`](docs/HANDOFF.md). Schemas:
  [`docs/schema/`](docs/schema/), sample: [`docs/examples/predictions.sample.jsonl`](docs/examples/predictions.sample.jsonl).

## Directory layout (as in the paper)

```
raw/iter-NN/<task>.json     immutable execution traces (reasoning, tool calls, tool outputs, final reply)
wiki/
  patterns/*.md             one page per failure mode or strategy
  index.md                  catalog of patterns (written by the wiki maintainer)
  logs.md                   per-iteration log (wiki maintainer)
  skill-impact.md           audit trail: diff, validation score, Accepted/Rejected (written by the harness)
skills/<name>/
  SKILL.md                  frontmatter + When to Apply / When NOT to Apply / Instructions
  PURPOSE.md                Origin, Patterns Addressed, Evolution History
  …                         optional bundled scripts/resources
manifest.json               what produced the run: code commit, models, options, task file hash, skill hashes
splits.json                 task ids per split (train / val / test)
results/predictions.jsonl   every validation and test rollout (answer, full output, verdict), see docs/HANDOFF.md
results/prompts/<sha>.txt   the exact system prompts the agent saw
report.json                 provisional summary of the run
```

## Fidelity to the paper

Implemented as described: the four-step loop and strict gating, the three layers, atomic one-skill proposals,
patch-based edits (`append` / `replace` / `insert_after`), the Wiki Maintainer and Skill Proposer prompts
(Appendix E.2 / E.3, adapted), trace sampling (Appendix C), skills injected in full into the agent prompt, the wiki
hidden from the agent, early stop at 1.0, a test split, multi-run averaging, paired bootstrap, both wiki ablations, and
a command to run the cross-model transfer comparison (`eval`; the experiments themselves have not been run).

Not reproduced: the five benchmarks (LiveMathematicianBench, SealQA, SpreadsheetBench, OfficeQA, ALFWorld) and their
environments, the paper's open-weight/Gemini models (a vLLM-compatible backend exists but is untested against a real
server), per-benchmark inference prompts, and the baselines (Trace2Skill, EvoSkill, SkillOpt). Details and the
remaining differences are in [`examples/paper-case-study.md`](examples/paper-case-study.md), which also summarises the
paper's ALFWorld case study.

## Safety notes

- `--agent-tools` runs model-chosen commands on **your machine**. Tool patterns such as `Bash(python3 *)` restrict
  what is allowed, but this is not a sandbox. Leave it off for untrusted tasks.
- Run directories hold your tasks, the agents' full outputs and the test answers. `runs/` is git-ignored; if you commit
  a run (like the reference run), make sure it contains no private data.
- Email addresses are masked in stored transcripts (Claude Code adds account context to every session), but
  that is the only redaction; review `raw/` before publishing it.

## Tests

`npm test` – 61 tests with a mock LLM, a local mock server and an offline stand-in for the `claude` CLI; no network or API calls.

## Credits and original ideas

This is my own implementation, but the idea behind it is not mine. Please read the originals:

- **WikiSkill** – L. Tang, C. Rashtchian, C.-S. Ferng, A. Tomkins, D.-C. Juan, T. Vu.
  *WikiSkill: Compiling Agent Experience into Persistent Knowledge for Skill Evolution.* arXiv:2608.27454, 2026.
  [Abstract](https://arxiv.org/abs/2608.27454) · [HTML](https://arxiv.org/html/2608.27454) ·
  [PDF](https://arxiv.org/pdf/2608.27454) (CC BY 4.0)
- Related work the paper compares against or builds on:
  - Trace2Skill – Ni et al., [arXiv:2603.25158](https://arxiv.org/abs/2603.25158)
  - EvoSkill – Alzubi et al., [arXiv:2603.02766](https://arxiv.org/abs/2603.02766)
  - SkillOpt – Yang et al., [arXiv:2605.23904](https://arxiv.org/abs/2605.23904)
  - SoK: Agentic Skills – Jiang et al., [arXiv:2602.20867](https://arxiv.org/abs/2602.20867)
  - Andrej Karpathy, [LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) (GitHub Gist) – the wiki idea the paper cites
  - Anthropic, [A complete guide to building skills for Claude](https://claude.com/blog/complete-guide-to-building-skills-for-claude) – the `SKILL.md` skill format

The Wiki Maintainer and Skill Proposer prompts here are adapted from the paper's Appendix E. Names and trademarks
belong to their owners; this project is not affiliated with or endorsed by the paper's authors, Google, or Anthropic.

## Copyright and disclaimer

Copyright (c) 2026 HalkPapa. The code in this repository is my own work and is released under the [MIT License](LICENSE);
the paper itself is licensed CC BY 4.0 by its authors.

**No warranty, and responsibility lies with the user.** The software is provided "as is". You are responsible for how
you use it, including the cost of LLM calls, any commands run through `--agent-tools`, the data you feed into it
(`raw/`, `wiki/` and `skills/` are written to disk and may be committed), and any decision based on its output.
The author accepts no liability for damages or losses arising from its use.

著作権は作者(HalkPapa)にありますが、本ソフトウェアは無保証で提供します。利用に伴う費用・データの取り扱い・
実行結果の利用などの責任は、各自が負うものとします。作者は利用による損害について責任を負いません。
