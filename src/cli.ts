#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';
import { evaluateSkillSets } from './evaluate.js';
import { SCHEMA_VERSION, parsePredictions } from './handoff.js';
import { checkRuns } from './check.js';
import { rescore } from './rescore.js';
import { splitTasks } from './evolve.js';
import { runExperiment } from './experiment.js';
import type { ScoreFn } from './infer.js';
import { claudeCli, openAiCompatible, routeLlm } from './llm.js';
import { commandScorer } from './scorer.js';
import { readSkillDirs } from './store.js';
import type { Llm, Scorer, Task } from './types.js';
import { snakeKeys } from './handoff.js';
import { splitTools } from './util.js';

const USAGE = `Usage:
  wikiskill evolve --tasks tasks.jsonl [options]    evolve skills (writes raw/ wiki/ skills/)
  wikiskill eval   --tasks tasks.jsonl --skills <dir> [--skills <dir> …] [options]
                                                     score existing skills, e.g. skills evolved with another model
  wikiskill rescore --predictions <file.jsonl> [--predictions …] [options]
                                                     re-score stored predictions with another scorer; runs no agent
  wikiskill check  --run <dir> [--run <dir> …]       verify a finished run is consistent before handing it over

evolve options
  --out <dir>            run directory holding raw/ wiki/ skills/ (default: .)
  --iters <n>            evolution iterations (default 5)
  --runs <n>             independent runs, averaged; each in <out>/run-N (paper: 3; default 1)
  --resume | --force     continue a previous run in <out> | delete it and start over
                         (without either, a non-empty <out> is refused)
  --train-sample <n>     max training tasks per iteration
  --proposer-no-wiki     ablation: hide the wiki from the skill proposer
  --inference-wiki       ablation: let the task agent read the wiki

eval options
  --skills <[label=]dir> a skills/ directory (repeatable). A no-skill baseline is always scored too;
                         later sets are also compared with the first.
  --split test|val|train|all   tasks to score (default test)
  --repeats <n>          repeat each rollout and average per task (default 1)
  --report <file>        also write the result as JSON
  --predictions-out <file>   write every rollout in the hand-off schema (+ prompts/ beside it); see docs/HANDOFF.md

rescore options
  --predictions <file>   results/predictions.jsonl of a run (repeatable; rows of all files are pooled)
  --baseline <condition> compare every condition with this one (default no-skills; e.g. external:gpt-x)
  --reparse              re-extract the answer from each row's raw output instead of using the stored one
  --rows-out <file>      write the re-scored rows as JSONL (default: print the summary only)
  --report <file>        also write the summary as JSON
  (--scorer / --scorer-cmd choose the new scorer)

common options
  --val-ratio <r>        validation share of tasks without a split (default 0.4)
  --test-ratio <r>       test share of tasks without a split (default 0)
  --scorer exact|contains
  --scorer-cmd "<cmd>"   external grader (overrides --scorer): gets {"id","input","expected","answer"} as JSON on stdin,
                         prints true/false, 1/0 or {"correct":true}. Runs on this machine.
  --concurrency <n>      parallel rollouts (default 4)
  --task-desc "<text>"   completes "an expert agent that solves …" in the prompts
  --model <m>            Claude model for the wiki maintainer and skill proposer (and the agent by default)
  --infer-model <m>      model for the task-solving agent
  --infer-backend claude|openai   openai = OpenAI-compatible server such as vLLM (text only)
  --base-url <url>       e.g. http://localhost:8000/v1      --api-key-env <VAR>  (default OPENAI_API_KEY)
  --agent-tools "<specs>"  comma-separated Claude Code tools for the task agent, e.g. "Read,Bash(python3 *)".
                         NOT a real sandbox: allowed Bash patterns run on this machine.

tasks.jsonl: one {"id","input","expected"[,"split":"train"|"val"|"test"]} object per line.`;

async function loadTasks(path: string): Promise<Task[]> {
  return (await readFile(path, 'utf8'))
    .split('\n')
    .filter((l) => l.trim())
    .map((l, i) => {
      const t = JSON.parse(l) as Task;
      if (!t.id || t.input === undefined || t.expected === undefined) throw new Error(`${path} line ${i + 1}: need id, input, expected`);
      return { ...t, id: String(t.id), expected: String(t.expected) };
    });
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      tasks: { type: 'string' },
      out: { type: 'string', default: '.' },
      iters: { type: 'string', default: '5' },
      runs: { type: 'string', default: '1' },
      resume: { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      skills: { type: 'string', multiple: true },
      predictions: { type: 'string', multiple: true },
      run: { type: 'string', multiple: true },
      baseline: { type: 'string', default: 'no-skills' },
      'predictions-out': { type: 'string' },
      reparse: { type: 'boolean', default: false },
      'rows-out': { type: 'string' },
      split: { type: 'string', default: 'test' },
      repeats: { type: 'string', default: '1' },
      report: { type: 'string' },
      model: { type: 'string' },
      'infer-model': { type: 'string' },
      'infer-backend': { type: 'string', default: 'claude' },
      'base-url': { type: 'string' },
      'api-key-env': { type: 'string', default: 'OPENAI_API_KEY' },
      concurrency: { type: 'string', default: '4' },
      scorer: { type: 'string', default: 'exact' },
      'scorer-cmd': { type: 'string' },
      'val-ratio': { type: 'string', default: '0.4' },
      'test-ratio': { type: 'string', default: '0' },
      'train-sample': { type: 'string' },
      'task-desc': { type: 'string' },
      'agent-tools': { type: 'string' },
      'proposer-no-wiki': { type: 'boolean', default: false },
      'inference-wiki': { type: 'boolean', default: false },
    },
  });
  const cmd = positionals[0];
  if (!['evolve', 'eval', 'rescore', 'check'].includes(cmd) || (cmd !== 'rescore' && cmd !== 'check' && !values.tasks)) {
    console.error(USAGE);
    process.exit(2);
  }
  const log = (m: string) => console.error(`[wikiskill] ${m}`);
  const scoreFn = values['scorer-cmd'] ? (commandScorer(values['scorer-cmd'], { onError: log }) as ScoreFn) : undefined;
  const scorerLabel = scoreFn ? 'custom' : values.scorer!;
  const f = (x: number) => x.toFixed(3);

  if (cmd === 'check') {
    if (!values.run?.length) throw new Error('check needs at least one --run <dir>');
    const reports = (await Promise.all(values.run.map(checkRuns))).flat();
    for (const r of reports) {
      console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.dir}`);
      for (const p of r.problems) console.log(`  problem: ${p}`);
      for (const n of r.notes) console.log(`  note: ${n}`);
    }
    if (reports.some((r) => !r.ok)) process.exitCode = 1;
    return;
  }

  if (cmd === 'rescore') {
    if (!values.predictions?.length) throw new Error('rescore needs at least one --predictions <file>');
    const rows = (await Promise.all(values.predictions.map(async (file) => parsePredictions(await readFile(file, 'utf8'), file)))).flat();
    const res = await rescore({ rows, scorer: values.scorer as Scorer, scoreFn, scorerLabel, reparse: values.reparse, baseline: values.baseline });
    console.log(`${rows.length} rows re-scored with "${scorerLabel}"; ${res.changed} changed verdict`);
    for (const g of res.summary)
      console.log(
        `  ${g.split.padEnd(6)} ${g.condition.padEnd(24)} ${f(g.accuracy)}  (${g.tasks} tasks, ${g.rows} rows)` +
          (g.vs_baseline ? `  vs ${res.baseline}: p=${f(g.vs_baseline.p)} (${g.vs_baseline.significant ? 'significant' : 'not significant'})` : ''),
      );
    if (values['rows-out']) await writeFile(values['rows-out'], res.rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    if (values.report) await writeFile(values.report, JSON.stringify({ schema_version: SCHEMA_VERSION, scorer: scorerLabel, baseline: res.baseline, changed: res.changed, summary: res.summary }, null, 2) + '\n');
    return;
  }

  const tasksText = await readFile(values.tasks!, 'utf8');
  const tasks = await loadTasks(values.tasks!);

  const agentTools = values['agent-tools'] ? splitTools(values['agent-tools']) : [];
  const openai = values['infer-backend'] === 'openai';
  if (openai && (agentTools.length > 0 || values['inference-wiki'])) {
    throw new Error('--infer-backend openai is text-only: it cannot be combined with --agent-tools or --inference-wiki');
  }
  if (openai && (!values['base-url'] || !values['infer-model'])) throw new Error('--infer-backend openai needs --base-url and --infer-model');
  const meta = claudeCli({ model: values.model });
  const inference = openai
    ? openAiCompatible({ baseUrl: values['base-url']!, model: values['infer-model']!, apiKey: process.env[values['api-key-env']!] })
    : claudeCli({ model: values['infer-model'] ?? values.model });
  const llm: Llm = routeLlm(inference, meta);
  const common = {
    llm,
    scorer: values.scorer as Scorer,
    scoreFn,
    scorerLabel,
    concurrency: Number(values.concurrency),
    taskDesc: values['task-desc'],
    agentTools,
    log,
  };
  const sh = promisify(execFile);
  const cap = async (cmd: string, args: string[]) => (await sh(cmd, args).then((r) => r.stdout.trim(), () => 'unknown'));
  const pkg = JSON.parse(await readFile(join(dirname(new URL(import.meta.url).pathname), '../../package.json'), 'utf8')) as { version: string };
  const runInfo = {
    tool: { name: 'wikiskill', version: pkg.version, git_commit: await cap('git', ['rev-parse', 'HEAD']), git_dirty: (await cap('git', ['status', '--porcelain'])) !== '' },
    runtime: { node: process.version, claude_cli: await cap('claude', ['--version']) },
    models: {
      task_agent: values['infer-model'] ?? values.model ?? 'claude CLI default',
      task_agent_backend: values['infer-backend'],
      wiki_maintainer_and_skill_proposer: values.model ?? 'claude CLI default',
    },
    tasks_file: { path: values.tasks, sha256: createHash('sha256').update(tasksText).digest('hex'), count: tasks.length },
    scorer_command: values['scorer-cmd'] ?? null,
  };
  const valRatio = Number(values['val-ratio']);
  const testRatio = Number(values['test-ratio']);

  if (cmd === 'eval') {
    if (!values.skills?.length) throw new Error('eval needs at least one --skills <dir>');
    const parts = splitTasks(tasks, valRatio, testRatio);
    const chosen = values.split === 'all' ? tasks : (parts as Record<string, Task[]>)[values.split!];
    if (!chosen) throw new Error(`--split must be test, val, train or all (got ${values.split})`);
    if (chosen.length === 0) throw new Error(`no ${values.split} tasks: add "split":"${values.split}" to tasks or use --test-ratio / --split all`);
    const sets = await Promise.all(
      values.skills.map(async (spec) => {
        const eq = spec.indexOf('=');
        const [name, dir] = eq > 0 ? [spec.slice(0, eq), spec.slice(eq + 1)] : [spec, spec];
        const skills = await readSkillDirs(dir);
        if (skills.size === 0) throw new Error(`no skills found in ${dir} (expected <dir>/<name>/SKILL.md)`);
        return { name, skills };
      }),
    );
    const res = await evaluateSkillSets({ ...common, tasks: chosen, sets, repeats: Number(values.repeats), splitLabel: values.split });
    console.log(`${values.split} tasks: ${chosen.length}`);
    console.log(`  no skills            ${f(res.baseline.accuracy)}`);
    for (const s of res.sets) {
      console.log(
        `  ${s.name.padEnd(20)} ${f(s.accuracy)}  vs no skills: p=${f(s.vsBaseline.p)} (${s.vsBaseline.significant ? 'significant' : 'not significant'})` +
          (s.vsFirst ? `; vs ${res.sets[0].name}: p=${f(s.vsFirst.p)}` : ''),
      );
    }
    if (values.report) await writeFile(values.report, JSON.stringify({ schema_version: SCHEMA_VERSION, ...(snakeKeys({ ...res, predictions: undefined, prompts: undefined }) as object) }, null, 2) + '\n');
    if (values['predictions-out']) {
      const file = values['predictions-out'];
      await mkdir(join(dirname(file), 'prompts'), { recursive: true });
      await writeFile(file, res.predictions.map((r) => JSON.stringify(r)).join('\n') + '\n');
      for (const [sha, text] of Object.entries(res.prompts)) await writeFile(join(dirname(file), 'prompts', `${sha}.txt`), text);
      log(`wrote ${res.predictions.length} predictions to ${file}`);
    }
    return;
  }

  const result = await runExperiment({
    ...common,
    tasks,
    outDir: values.out!,
    iterations: Number(values.iters),
    runs: Number(values.runs),
    resume: values.resume,
    force: values.force,
    valRatio,
    testRatio,
    runInfo,
    trainSample: values['train-sample'] ? Number(values['train-sample']) : undefined,
    proposerSeesWiki: !values['proposer-no-wiki'],
    inferenceSeesWiki: values['inference-wiki'],
  });
  console.log(`validation: no skills ${result.meanBaselineVal.toFixed(3)} → best ${result.meanBestVal.toFixed(3)} (mean of ${result.runs.length} run(s))`);
  if (result.test) {
    const t = result.test;
    console.log(
      `test: no skills ${t.meanBaselineAccuracy.toFixed(3)} → evolved ${t.meanEvolvedAccuracy.toFixed(3)}; ` +
        `paired bootstrap p=${t.bootstrap.p.toFixed(3)} (${t.bootstrap.significant ? 'significant' : 'not significant'} at 0.05)`,
    );
  }
  console.log(`skills of the last run: ${[...result.runs[result.runs.length - 1].skills.keys()].join(', ') || '(none)'}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
