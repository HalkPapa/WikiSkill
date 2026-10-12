/**
 * The stable, versioned data contract for whoever scores or compares the results later (see docs/HANDOFF.md).
 * Everything written for them uses snake_case keys and carries `schema_version`. Breaking changes bump the version.
 */
import { createHash } from 'node:crypto';
import type { SkillSet, Trace } from './types.js';

export const SCHEMA_VERSION = 1;

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** One agent rollout on one task under one condition. One JSON object per line in results/predictions.jsonl. */
export interface PredictionRow {
  schema_version: number;
  /** Run label: "run-1", "run-2", … (one evolution run), or a free label for `eval`. */
  run: string;
  /** Which task split the task belongs to for this experiment. */
  split: string;
  /**
   * What produced the answer: "no-skills", "evolved" (final skills), "candidate:<skill>@iter<k>" (a validation
   * rollout used by the gate), "resumed-skills", or the label of an `eval` skill set.
   */
  condition: string;
  /** Evolution iteration for gate rollouts; 0 otherwise. */
  iteration: number;
  task_id: string;
  input: string;
  expected: string;
  /** Answer extracted from the agent's reply (<answer>…</answer>), or null if none was found. */
  answer: string | null;
  /** Verdict of `scorer` at the time of the run. Re-score with `wikiskill rescore`; the raw `output` is kept. */
  correct: boolean;
  /** "exact", "contains" or "custom" (an external grader command). */
  scorer: string;
  /** SHA-256 of the exact system prompt the agent saw; the text is in results/prompts/<sha>.txt. */
  system_prompt_sha256: string;
  /**
   * Full execution log: reasoning, tool calls and tool outputs when available, then the final reply. Lines start with
   * the markers `[thinking]`, `[assistant]`, `[tool_use]`, `[tool_result]`; the final reply is the text after the last
   * `[final] ` marker. An external AI's output needs no markers (the whole text counts as the final reply).
   */
  output: string;
  /** Resolved model id that produced the answer (optional; absent for external rows and mocks). */
  model?: string;
  /** When the row was written (ISO 8601; optional). Test rows are written after all gate rollouts. */
  created_at?: string;
  /** Optional. Present when the agent call itself failed (after one retry): `correct` is then false but not a real verdict. */
  error?: string;
}

export const PREDICTION_REQUIRED_KEYS = [
  'schema_version', 'run', 'split', 'condition', 'iteration', 'task_id', 'input', 'expected', 'answer',
  'correct', 'scorer', 'system_prompt_sha256', 'output',
] as const;

export function predictionRow(
  t: Trace,
  meta: { run: string; split: string; condition: string; scorer: string },
): PredictionRow {
  return {
    schema_version: SCHEMA_VERSION,
    run: meta.run,
    split: meta.split,
    condition: meta.condition,
    iteration: t.iteration,
    task_id: t.taskId,
    input: t.input,
    expected: t.expected,
    answer: t.answer,
    correct: t.correct,
    scorer: meta.scorer,
    system_prompt_sha256: t.systemPromptSha256 ?? '',
    output: t.output,
    ...(t.model ? { model: t.model } : {}),
    ...(t.error ? { error: t.error } : {}),
    created_at: new Date().toISOString(),
  };
}

/** Returns a list of problems (empty = valid). Unknown extra keys are allowed; a newer major version is refused. */
export function validatePredictionRow(row: unknown): string[] {
  if (!row || typeof row !== 'object') return ['not an object'];
  const r = row as Record<string, unknown>;
  const problems = PREDICTION_REQUIRED_KEYS.filter((k) => !(k in r)).map((k) => `missing ${k}`);
  if (typeof r.schema_version === 'number' && r.schema_version > SCHEMA_VERSION)
    problems.push(`schema_version ${r.schema_version} is newer than supported (${SCHEMA_VERSION})`);
  for (const k of ['run', 'split', 'condition', 'task_id', 'input', 'expected', 'scorer', 'system_prompt_sha256', 'output'] as const)
    if (k in r && typeof r[k] !== 'string') problems.push(`${k} must be a string`);
  if ('correct' in r && typeof r.correct !== 'boolean') problems.push('correct must be a boolean');
  if ('iteration' in r && typeof r.iteration !== 'number') problems.push('iteration must be a number');
  if ('answer' in r && r.answer !== null && typeof r.answer !== 'string') problems.push('answer must be a string or null');
  return problems;
}

/** Parses a predictions.jsonl text; throws with the line number on a malformed row. */
export function parsePredictions(text: string, source = 'predictions'): PredictionRow[] {
  return text
    .split('\n')
    .filter((l) => l.trim())
    .map((line, i) => {
      let row: unknown;
      try {
        row = JSON.parse(line);
      } catch {
        throw new Error(`${source} line ${i + 1}: not valid JSON`);
      }
      const problems = validatePredictionRow(row);
      if (problems.length) throw new Error(`${source} line ${i + 1}: ${problems.join('; ')}`);
      return row as PredictionRow;
    });
}

/** Hashes skills so the exact evolved set can be pinned in the manifest: per skill and for the whole bundle. */
export function skillsDigest(skills: SkillSet): { bundle_sha256: string; per_skill: Record<string, string> } {
  const per: Record<string, string> = {};
  for (const name of [...skills.keys()].sort()) {
    const f = skills.get(name)!;
    const parts = [['SKILL.md', f.skillMd], ['PURPOSE.md', f.purposeMd], ...Object.entries(f.files ?? {}).sort(([a], [b]) => a.localeCompare(b))];
    per[name] = sha256(parts.map(([p, c]) => `${p}\n${c}`).join('\n--\n'));
  }
  return { bundle_sha256: sha256(Object.entries(per).map(([n, h]) => `${n}:${h}`).join('\n')), per_skill: per };
}

const snake = (k: string) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** Recursively converts camelCase object keys to snake_case (arrays and values are left alone). */
export function snakeKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(snakeKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [snake(k), snakeKeys(x)]));
  return v;
}
