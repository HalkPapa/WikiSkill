import { answerFromOutput, score, type ScoreFn } from './infer.js';
import { SCHEMA_VERSION, type PredictionRow } from './handoff.js';
import { pairedBootstrap, type BootstrapResult } from './stats.js';
import type { Scorer } from './types.js';
import { mapLimit } from './util.js';

export interface RescoreOptions {
  rows: PredictionRow[];
  /** Built-in scorer name, used when no `scoreFn` is given. */
  scorer?: Scorer;
  scoreFn?: ScoreFn;
  /** Label written to the `scorer` field of the re-scored rows (default: the scorer name, or "custom"). */
  scorerLabel?: string;
  /**
   * Re-extract every answer from `output` instead of trusting the stored `answer`. Rows whose stored `answer` is null
   * are always re-extracted (an external AI's rows may leave it null).
   */
  reparse?: boolean;
  /** task ids per split (splits.json): rows whose task is not in their split are reported. */
  splits?: { train?: string[]; val?: string[]; test?: string[] };
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
  /** Rows in which no answer could be extracted (counted as wrong). A high number means a format problem, not a wrong answer. */
  unanswered: number;
  /** Paired bootstrap of this condition against the baseline condition in the same split (absent for the baseline itself or if it has no rows). */
  vs_baseline?: BootstrapResult;
}

export interface RescoreResult {
  baseline: string;
  /** Inconsistencies in the input rows that can make a comparison meaningless. Empty = none found. */
  warnings: string[];
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
    const g: GroupSummary = { split, condition, rows: rs.length, tasks: perTask(rs).size, accuracy: mean(rs.map((r) => (r.correct ? 1 : 0))), unanswered: rs.filter((r) => r.answer === null).length };
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

/** Consistency checks across rows: same task, same input/expected; coverage versus the baseline; split membership. */
export function checkRows(rows: PredictionRow[], baseline: string, splits?: RescoreOptions['splits']): string[] {
  const warnings: string[] = [];
  const comparison = rows.filter((r) => !r.condition.startsWith('candidate:') && r.condition !== 'resumed-skills');
  const byTask = new Map<string, PredictionRow[]>();
  for (const r of comparison) byTask.set(`${r.split}\u0000${r.task_id}`, [...(byTask.get(`${r.split}\u0000${r.task_id}`) ?? []), r]);
  for (const [k, rs] of byTask) {
    const [split, id] = k.split('\u0000');
    const expected = new Set(rs.map((r) => r.expected));
    const inputs = new Set(rs.map((r) => r.input));
    if (expected.size > 1) warnings.push(`${split}/${id}: rows disagree on "expected" (${[...expected].map((e) => JSON.stringify(e)).join(' vs ')}) — conditions are not graded against the same truth`);
    if (inputs.size > 1) warnings.push(`${split}/${id}: rows disagree on "input" — conditions did not solve the same task`);
  }
  const tasksOf = (split: string, condition: string) => new Set(comparison.filter((r) => r.split === split && r.condition === condition).map((r) => r.task_id));
  for (const split of new Set(comparison.map((r) => r.split))) {
    const base = tasksOf(split, baseline);
    if (base.size === 0) continue;
    for (const condition of new Set(comparison.filter((r) => r.split === split).map((r) => r.condition))) {
      if (condition === baseline) continue;
      const have = tasksOf(split, condition);
      const missing = [...base].filter((t) => !have.has(t));
      const extra = [...have].filter((t) => !base.has(t));
      if (missing.length) warnings.push(`${split}/${condition}: covers ${base.size - missing.length} of the ${base.size} ${baseline} tasks; missing ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', …' : ''} — compared on the common tasks only`);
      if (extra.length) warnings.push(`${split}/${condition}: has ${extra.length} task(s) the ${baseline} condition lacks (${extra.slice(0, 5).join(', ')}) — ignored in comparisons`);
    }
  }
  if (splits) {
    for (const r of comparison) {
      const ids = (splits as Record<string, string[] | undefined>)[r.split];
      if (ids && !ids.includes(r.task_id)) warnings.push(`${r.split}/${r.condition}: task ${r.task_id} is not in the ${r.split} split of splits.json`);
    }
  }
  return [...new Set(warnings)];
}

/**
 * Re-scores stored predictions without running any agent. The original verdict is kept in `correct_original`
 * (set once, so repeated re-scoring never loses it).
 */
export async function rescore(o: RescoreOptions): Promise<RescoreResult> {
  const label = o.scorerLabel ?? (o.scoreFn ? 'custom' : o.scorer ?? 'exact');
  const baseline = o.baseline ?? 'no-skills';
  const conditions = new Set(o.rows.map((r) => r.condition));
  if (!conditions.has(baseline)) throw new Error(`baseline condition "${baseline}" has no rows; conditions present: ${[...conditions].join(', ')}`);

  const graded = await mapLimit(o.rows, o.concurrency ?? 4, async (r) => {
    const answer = o.reparse || r.answer === null ? answerFromOutput(r.output) : r.answer;
    const task = { id: r.task_id, input: r.input, expected: r.expected };
    const correct = o.scoreFn ? await o.scoreFn(answer, task, { output: r.output }) : score(answer, r.expected, o.scorer ?? 'exact');
    return { r, answer, correct };
  });
  let changed = 0;
  const out: PredictionRow[] = graded.map(({ r, answer, correct }) => {
    if (correct !== r.correct) changed++;
    return {
      ...r,
      schema_version: SCHEMA_VERSION,
      answer,
      correct,
      scorer: label,
      correct_original: (r as PredictionRow & { correct_original?: boolean }).correct_original ?? r.correct,
    } as PredictionRow;
  });
  return { baseline, warnings: checkRows(o.rows, baseline, o.splits), rows: out, changed, summary: summarize(out, baseline) };
}
