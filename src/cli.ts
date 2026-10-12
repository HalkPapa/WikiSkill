#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { runExperiment } from './experiment.js';
import { claudeCli, openAiCompatible, routeLlm } from './llm.js';
import type { Scorer, Task } from './types.js';
import { splitTools } from './util.js';

const USAGE = `Usage: wikiskill evolve --tasks tasks.jsonl [options]

  --out <dir>            run directory holding raw/ wiki/ skills/ (default: .)
  --iters <n>            evolution iterations (default 5)
  --runs <n>             independent runs, averaged; each in <out>/run-N (paper: 3; default 1)
  --resume | --force     continue a previous run in <out> | delete it and start over
                         (without either, a non-empty <out> is refused)
  --val-ratio <r>        validation share of tasks without a split (default 0.4)
  --test-ratio <r>       test share of tasks without a split (default 0)
  --train-sample <n>     max training tasks per iteration
  --scorer exact|contains
  --concurrency <n>      parallel rollouts (default 4)
  --task-desc "<text>"   completes "an expert agent that solves …" in the prompts

  Models
  --model <m>            Claude model for the wiki maintainer, skill proposer (and agent by default)
  --infer-model <m>      model for the task-solving agent
  --infer-backend claude|openai   openai = OpenAI-compatible server such as vLLM (text only, no tools)
  --base-url <url>       e.g. http://localhost:8000/v1   --api-key-env <VAR>  (default OPENAI_API_KEY)

  Agent environment and ablations
  --agent-tools "<specs>"  comma-separated Claude Code tools for the task agent, e.g. "Read,Bash(python3 *)".
                         NOT a real sandbox: allowed Bash patterns run on this machine.
  --proposer-no-wiki     ablation: hide the wiki from the skill proposer
  --inference-wiki       ablation: let the task agent read the wiki

tasks.jsonl: one {"id","input","expected"[,"split":"train"|"val"|"test"]} object per line.`;

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
      model: { type: 'string' },
      'infer-model': { type: 'string' },
      'infer-backend': { type: 'string', default: 'claude' },
      'base-url': { type: 'string' },
      'api-key-env': { type: 'string', default: 'OPENAI_API_KEY' },
      concurrency: { type: 'string', default: '4' },
      scorer: { type: 'string', default: 'exact' },
      'val-ratio': { type: 'string', default: '0.4' },
      'test-ratio': { type: 'string', default: '0' },
      'train-sample': { type: 'string' },
      'task-desc': { type: 'string' },
      'agent-tools': { type: 'string' },
      'proposer-no-wiki': { type: 'boolean', default: false },
      'inference-wiki': { type: 'boolean', default: false },
    },
  });
  if (positionals[0] !== 'evolve' || !values.tasks) {
    console.error(USAGE);
    process.exit(2);
  }
  const tasks: Task[] = (await readFile(values.tasks, 'utf8'))
    .split('\n')
    .filter((l) => l.trim())
    .map((l, i) => {
      const t = JSON.parse(l) as Task;
      if (!t.id || t.input === undefined || t.expected === undefined) throw new Error(`tasks line ${i + 1}: need id, input, expected`);
      return { ...t, id: String(t.id), expected: String(t.expected) };
    });

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

  const result = await runExperiment({
    tasks,
    outDir: values.out!,
    iterations: Number(values.iters),
    runs: Number(values.runs),
    resume: values.resume,
    force: values.force,
    llm: routeLlm(inference, meta),
    scorer: values.scorer as Scorer,
    concurrency: Number(values.concurrency),
    valRatio: Number(values['val-ratio']),
    testRatio: Number(values['test-ratio']),
    trainSample: values['train-sample'] ? Number(values['train-sample']) : undefined,
    taskDesc: values['task-desc'],
    agentTools,
    proposerSeesWiki: !values['proposer-no-wiki'],
    inferenceSeesWiki: values['inference-wiki'],
    log: (m) => console.error(`[wikiskill] ${m}`),
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
