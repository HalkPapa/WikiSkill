import { mapLimit } from './util.js';
import { runTask, type ScoreFn } from './infer.js';
import { predictionRow, type PredictionRow } from './handoff.js';
import { pairedBootstrap, type BootstrapResult } from './stats.js';
import type { Llm, Scorer, SkillSet, Task } from './types.js';

export interface EvaluateOptions {
  tasks: Task[];
  /** Named skill sets to evaluate, e.g. skills evolved by different models. A no-skill baseline is always added. */
  sets: { name: string; skills: SkillSet }[];
  llm: Llm;
  scorer?: Scorer;
  scoreFn?: ScoreFn;
  concurrency?: number;
  taskDesc?: string;
  agentTools?: string[];
  agentPrompt?: string;
  agentMcpConfig?: string;
  /** Repeat every rollout this many times and average per task (agent sampling is noisy). Default 1. */
  repeats?: number;
  /** Split name and run label written to prediction rows. */
  splitLabel?: string;
  runLabel?: string;
  scorerLabel?: string;
  log?: (msg: string) => void;
}

export interface SetResult {
  name: string;
  accuracy: number;
  /** Per-task score averaged over repeats. */
  scores: number[];
  /** Paired bootstrap against the no-skill baseline. */
  vsBaseline: BootstrapResult;
  /** Paired bootstrap against the first set (only for the 2nd and later sets). */
  vsFirst?: BootstrapResult;
}

export interface EvaluateResult {
  ids: string[];
  baseline: { accuracy: number; scores: number[] };
  sets: SetResult[];
  /** Every rollout, in the hand-off schema (condition = "no-skills" or the set name). */
  predictions: PredictionRow[];
  /** System prompt texts by SHA-256 (the `system_prompt_sha256` of the rows). */
  prompts: Record<string, string>;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/**
 * Scores skill sets on a task list without evolving anything — e.g. the paper's cross-model transfer check (§4.2.2):
 * run skills evolved with model A under model B and compare them with model B's own skills and with no skills.
 */
export async function evaluateSkillSets(o: EvaluateOptions): Promise<EvaluateResult> {
  if (o.tasks.length === 0) throw new Error('no tasks to evaluate');
  const repeats = Math.max(1, o.repeats ?? 1);
  const predictions: PredictionRow[] = [];
  const prompts: Record<string, string> = {};
  const score = async (skills: SkillSet, condition: string): Promise<number[]> => {
    const runs: number[][] = [];
    for (let r = 0; r < repeats; r++) {
      const traces = await mapLimit(o.tasks, o.concurrency ?? 4, (t) =>
        runTask(o.llm, t, { skills, scorer: o.scorer ?? 'exact', scoreFn: o.scoreFn, iteration: 0, taskDesc: o.taskDesc, agentTools: o.agentTools, promptTemplate: o.agentPrompt, mcpConfig: o.agentMcpConfig, onPrompt: (sha, text) => void (prompts[sha] = text) }),
      );
      runs.push(traces.map((t) => (t.correct ? 1 : 0)));
      const run = repeats > 1 ? `${o.runLabel ?? 'eval'}-${r + 1}` : o.runLabel ?? 'eval';
      predictions.push(...traces.map((t) => predictionRow(t, { run, split: o.splitLabel ?? 'eval', condition, scorer: o.scorerLabel ?? (o.scoreFn ? 'custom' : o.scorer ?? 'exact') })));
    }
    return o.tasks.map((_, i) => mean(runs.map((r) => r[i])));
  };

  const baseline = await score(new Map(), 'no-skills');
  o.log?.(`no skills: ${mean(baseline).toFixed(3)}`);
  const sets: SetResult[] = [];
  for (const s of o.sets) {
    const scores = await score(s.skills, s.name);
    const res: SetResult = { name: s.name, accuracy: mean(scores), scores, vsBaseline: pairedBootstrap(scores, baseline) };
    if (sets.length > 0) res.vsFirst = pairedBootstrap(scores, sets[0].scores);
    sets.push(res);
    o.log?.(`${s.name}: ${res.accuracy.toFixed(3)} (p vs no skills = ${res.vsBaseline.p.toFixed(3)})`);
  }
  return { ids: o.tasks.map((t) => t.id), baseline: { accuracy: mean(baseline), scores: baseline }, sets, predictions, prompts };
}
