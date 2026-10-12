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
It is **not** the authors' code (none has been released); it is rebuilt from the paper's text and appendices.
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

> The repository root already contains a small demo run (`raw/`, `wiki/`, `skills/`). A run refuses to start in a
> non-empty directory: use `--out <dir>` for a new run, `--resume` to continue one, or `--force` to wipe and restart.

### Options

| Option | Meaning |
|---|---|
| `--out <dir>` | run directory (default `.`) |
| `--iters <n>` | iterations (default 5) |
| `--runs <n>` | independent full runs, averaged; each in `<out>/run-N` (the paper uses 3) |
| `--resume` / `--force` | continue a previous run (loads its skills and wiki) / delete it and start over |
| `--val-ratio`, `--test-ratio` | shares of unsplit tasks for validation / test (defaults 0.4 / 0) |
| `--train-sample <n>` | max training tasks per iteration |
| `--concurrency <n>` | parallel rollouts (default 4) |
| `--model <m>` | Claude model for the wiki maintainer and skill proposer (and the agent by default) |
| `--infer-model <m>` | model for the task-solving agent |
| `--infer-backend claude\|openai` | `openai` = OpenAI-compatible server such as vLLM (text only); needs `--base-url`, `--infer-model` |
| `--agent-tools "Read,Bash(python3 *)"` | Claude Code tools for the task agent (default none) |
| `--proposer-no-wiki` | ablation: hide the wiki from the skill proposer |
| `--inference-wiki` | ablation: let the task agent read the wiki |
| `--task-desc "<text>"` | completes "an expert agent that solves …" in the prompts |

With a test split, the final skills and a no-skill baseline are scored on it, and a paired bootstrap
(1,000 resamples, one-sided, p < 0.05) compares them. Results are written to `report.json`.

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
report.json                 validation/test results of the run
```

## Fidelity to the paper

Implemented as described: the four-step loop and strict gating, the three layers, atomic one-skill proposals,
patch-based edits (`append` / `replace` / `insert_after`), the Wiki Maintainer and Skill Proposer prompts
(Appendix E.2 / E.3, adapted), trace sampling (Appendix C), skills injected in full into the agent prompt, the wiki
hidden from the agent, early stop at 1.0, a test split, multi-run averaging, paired bootstrap, and both wiki ablations.

Not reproduced: the five benchmarks (LiveMathematicianBench, SealQA, SpreadsheetBench, OfficeQA, ALFWorld) and their
environments, the paper's open-weight/Gemini models (a vLLM-compatible backend exists but is untested against a real
server), per-benchmark inference prompts, and the baselines (Trace2Skill, EvoSkill, SkillOpt). Details and the
remaining differences are in [`examples/paper-case-study.md`](examples/paper-case-study.md), which also summarises the
paper's ALFWorld case study.

## Safety notes

- `--agent-tools` runs model-chosen commands on **your machine**. Tool patterns such as `Bash(python3 *)` restrict
  what is allowed, but this is not a sandbox. Leave it off for untrusted tasks.
- `raw/`, `wiki/` and `skills/` are committed by design, so keep private task data out of a public repository: point
  `--out` outside the repo, or add those folders to `.gitignore`.
- Email addresses are masked in stored transcripts (Claude Code adds account context to every session), but
  that is the only redaction; review `raw/` before publishing it.

## Tests

`npm test` – 19 tests with a mock LLM and a local mock server; no network or API calls.

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
