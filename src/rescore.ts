import { extractAnswer, score, type ScoreFn } from './infer.js';
import { SCHEMA_VERSION, type PredictionRow } from './handoff.js';
import { pairedBootstrap, type BootstrapResult } from './stats.js';
import type { Scorer } from './types.js';

export interface RescoreOptions {
  rows: PredictionRow[];
  /** Built-in scorer name, used when no `scoreFn` is given. */
  scorer?: Scorer;
  scoreFn?: ScoreFn;
  /** Label written to the `scorer` field of the re-scored rows (default: the scorer name, or "custom"). */
  scorerLabel?: string;
  /** Re-extract the answer from `output` (<answer>…</answer>) instead of trusting the stored `answer`. */
  reparse?: boolean;
  /** Condition every other condition is compared with (default "no-skills"). */
  baseline?: string;
  concurrency?: number;
}

export interface GroupSummary {
  split: string;
  condition: string;
  /** Rollouts (rows) and distinct tasks in the group. */
  rows: number;
  tasks: number;
  /** Mean correctness over all rows (a task run several times counts several times). */
  accuracy: number;
  /** Paired bootstrap of this condition against the baseline condition in the same split (absent for the baseline itself or if it has no rows). */
  vs_baseline?: BootstrapResult;
}

export interface RescoreResult {
  baseline: string;
  rows: PredictionRow[];
  /** How many rows changed verdict. */
  changed: number;
  summary: GroupSummary[];
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Groups rows by split and condition; rows from several runs of the same task are averaged before comparing. */
export function summarize(rows: PredictionRow[], baseline = 'no-skills'): GroupSummary[] {
  const groups = new Map<string, PredictionRow[]>();
  for (const r of rows) {
    if (r.condition.startsWith('candidate:') || r.condition === 'resumed-skills') continue; // gate bookkeeping
    const k = `${r.split}\u0000${r.condition}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const perTask = (rs: PredictionRow[]) => {
    const byTask = new Map<string, number[]>();
    for (const r of rs) byTask.set(r.task_id, [...(byTask.get(r.task_id) ?? []), r.correct ? 1 : 0]);
    return byTask;
  };
  const out: GroupSummary[] = [];
  for (const [k, rs] of groups) {
    const [split, condition] = k.split('\u0000');
    const g: GroupSummary = { split, condition, rows: rs.length, tasks: perTask(rs).size, accuracy: mean(rs.map((r) => (r.correct ? 1 : 0))) };
    const base = groups.get(`${split}\u0000${baseline}`);
    if (base && condition !== baseline) {
      const a = perTask(rs);
      const b = perTask(base);
      const ids = [...a.keys()].filter((id) => b.has(id));
      if (ids.length > 0) g.vs_baseline = pairedBootstrap(ids.map((id) => mean(a.get(id)!)), ids.map((id) => mean(b.get(id)!)));
    }
    out.push(g);
  }
  return out.sort((x, y) => x.split.localeCompare(y.split) || x.condition.localeCompare(y.condition));
}

/**
 * Re-scores stored predictions without running any agent. The original verdict is kept in `correct_original`
 * (set once, so repeated re-scoring never loses it).
 */
export async function rescore(o: RescoreOptions): Promise<RescoreResult> {
  const label = o.scorerLabel ?? (o.scoreFn ? 'custom' : o.scorer ?? 'exact');
  let changed = 0;
  const out: PredictionRow[] = [];
  for (const r of o.rows) {
    const answer = o.reparse ? extractAnswer(r.output) : r.answer;
    const task = { id: r.task_id, input: r.input, expected: r.expected };
    const correct = o.scoreFn ? await o.scoreFn(answer, task, { output: r.output }) : score(answer, r.expected, o.scorer ?? 'exact');
    if (correct !== r.correct) changed++;
    out.push({
      ...r,
      schema_version: SCHEMA_VERSION,
      answer,
      correct,
      scorer: label,
      correct_original: (r as PredictionRow & { correct_original?: boolean }).correct_original ?? r.correct,
    } as PredictionRow);
  }
  const baseline = o.baseline ?? 'no-skills';
  return { baseline, rows: out, changed, summary: summarize(out, baseline) };
}
