import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { SCHEMA_VERSION, parsePredictions, sha256, skillsDigest } from './handoff.js';
import { readSkillDirs } from './store.js';
import { safeName } from './util.js';

export interface CheckReport {
  dir: string;
  ok: boolean;
  problems: string[];
  notes: string[];
}

const readJson = async (p: string) => JSON.parse(await readFile(p, 'utf8')) as any;

/** Verifies that a finished run directory is internally consistent and safe to hand over. */
export async function checkRun(dir: string): Promise<CheckReport> {
  const problems: string[] = [];
  const notes: string[] = [];
  const bad = (m: string) => problems.push(m);

  const manifest = await readJson(join(dir, 'manifest.json')).catch(() => null);
  if (!manifest) return { dir, ok: false, problems: ['manifest.json is missing or not valid JSON'], notes };
  if (manifest.schema_version > SCHEMA_VERSION) bad(`manifest schema_version ${manifest.schema_version} is newer than supported (${SCHEMA_VERSION})`);
  if (manifest.status !== 'completed') bad(`run status is "${manifest.status}", not "completed"${manifest.error ? `: ${manifest.error}` : ''}`);
  if (manifest.environment?.tool?.git_dirty === true) notes.push('the code that produced this run had uncommitted changes (environment.tool.git_dirty)');
  if (!manifest.environment?.tool?.git_commit) notes.push('no git commit recorded for the producing code (not a git checkout?): the code cannot be pinned');

  if (manifest.guarantees?.test_split_used_during_evolution !== false) bad('manifest.guarantees.test_split_used_during_evolution is not false');

  // content hashes pinned at completion: detects rows, tasks or splits edited after the run
  const hashes = manifest.files_sha256;
  if (!hashes) notes.push('the manifest pins no content hashes (run produced by an older version); edits to predictions.jsonl would go unnoticed');
  else
    for (const [key, file] of [['predictions', 'results/predictions.jsonl'], ['tasks', 'tasks.jsonl'], ['splits', 'splits.json']] as const) {
      const text = await readFile(join(dir, file), 'utf8').catch(() => null);
      if (text === null) bad(`${file} is missing`);
      else if (sha256(text) !== hashes[key]) bad(`${file} was changed after the run (SHA-256 differs from manifest.files_sha256.${key})`);
    }

  // environment failures are not wrong answers: a run with failed agent or grader calls has distorted scores
  const q = manifest.quality;
  if (q?.agent_errors > 0) bad(`${q.agent_errors} agent call(s) failed (timeouts, rate limits, crashes) and were scored as wrong`);
  if (q?.grader_failures > 0) bad(`${q.grader_failures} external-grader call(s) failed and were scored as wrong`);

  // splits
  const splits = await readJson(join(dir, 'splits.json')).catch(() => null);
  const splitOf = new Map<string, string>();
  if (!splits) bad('splits.json is missing or not valid JSON');
  else {
    for (const sp of ['train', 'val', 'test'] as const)
      for (const id of splits[sp] ?? []) {
        if (splitOf.has(id)) bad(`task "${id}" is in both ${splitOf.get(id)} and ${sp}`);
        splitOf.set(id, sp);
      }
    for (const sp of ['train', 'val', 'test'] as const)
      if ((splits[sp] ?? []).length !== manifest.split_sizes?.[sp]) bad(`splits.json ${sp} has ${(splits[sp] ?? []).length} tasks, manifest says ${manifest.split_sizes?.[sp]}`);
  }

  // predictions
  let rows: ReturnType<typeof parsePredictions> = [];
  try {
    rows = parsePredictions(await readFile(join(dir, 'results/predictions.jsonl'), 'utf8'), 'results/predictions.jsonl');
  } catch (e) {
    bad((e as Error).message);
  }
  for (const r of rows) {
    if (r.error) bad(`row ${r.task_id}/${r.condition} is an agent failure, not an answer: ${String(r.error).slice(0, 80)}`);
    if (r.run !== manifest.run) bad(`row for ${r.task_id}/${r.condition} has run "${r.run}", manifest says "${manifest.run}"`);
    const sp = splitOf.get(r.task_id);
    if (splits && sp !== r.split) bad(`row ${r.task_id}/${r.condition} says split "${r.split}" but splits.json ${sp ? `puts it in "${sp}"` : 'does not list the task at all'}`);
    if (r.split === 'test' && r.condition.startsWith('candidate:')) bad(`test task ${r.task_id} was used in a gate rollout (${r.condition})`);
  }
  const count = (split: string, condition: string) => rows.filter((r) => r.split === split && r.condition === condition);
  for (const [split, condition] of [['val', 'no-skills'], ['test', 'no-skills'], ['test', 'evolved']] as const) {
    const n = manifest.split_sizes?.[split] ?? 0;
    if (split === 'test' && n === 0) continue;
    const got = count(split, condition);
    const perTask = new Map<string, number>();
    for (const r of got) perTask.set(r.task_id, (perTask.get(r.task_id) ?? 0) + 1);
    if (perTask.size !== n) bad(`${split}/${condition}: rows for ${perTask.size} tasks, expected ${n}`);
    const dup = [...perTask].filter(([, c]) => c !== 1).map(([id]) => id);
    if (dup.length) bad(`${split}/${condition}: tasks with more than one row: ${dup.slice(0, 5).join(', ')}${dup.length > 5 ? ', …' : ''}`);
  }
  if ((manifest.split_sizes?.test ?? 0) === 0) notes.push('no test split: nothing to compare on held-out data');
  notes.push(`${rows.length} prediction rows`);
  if (manifest.environment?.tool?.git_dirty === true && !manifest.files?.code_diff) notes.push('git_dirty is true but no results/code.diff was saved; the exact code cannot be reproduced');

  // test rows must have been written after every gate (candidate) rollout
  const lastGate = Math.max(0, ...rows.filter((r) => r.condition.startsWith('candidate:') && r.created_at).map((r) => Date.parse(r.created_at!)));
  const firstTest = Math.min(Infinity, ...rows.filter((r) => r.split === 'test' && r.created_at).map((r) => Date.parse(r.created_at!)));
  if (lastGate > 0 && Number.isFinite(firstTest) && firstTest < lastGate) bad('a test row was written before the last gate rollout (created_at order)');

  // tasks.jsonl must agree with splits.json
  const tasksText = await readFile(join(dir, 'tasks.jsonl'), 'utf8').catch(() => null);
  if (tasksText === null) {
    if (manifest.files_sha256) bad('tasks.jsonl is missing');
    else notes.push('tasks.jsonl is missing (run produced by an older version)');
  }
  else {
    const inTasks = new Map<string, string>();
    for (const line of tasksText.split('\n').filter((l) => l.trim())) {
      try {
        const t = JSON.parse(line);
        inTasks.set(String(t.id), t.split);
      } catch {
        bad('tasks.jsonl has a line that is not valid JSON');
      }
    }
    if (splits) {
      for (const [id, sp] of splitOf) if (inTasks.get(id) !== sp) bad(`tasks.jsonl ${inTasks.has(id) ? `has "${id}" in ${inTasks.get(id)}` : `lacks "${id}"`}, splits.json says ${sp}`);
      for (const id of inTasks.keys()) if (!splitOf.has(id)) bad(`tasks.jsonl has "${id}", which splits.json does not list`);
    }
  }

  // prompts
  for (const sha of new Set(rows.map((r) => r.system_prompt_sha256))) {
    if (!sha) {
      bad('a row has an empty system_prompt_sha256');
      continue;
    }
    const text = await readFile(join(dir, 'results/prompts', `${sha}.txt`), 'utf8').catch(() => null);
    if (text === null) bad(`prompt ${sha} is referenced but results/prompts/${sha}.txt is missing`);
    else if (sha256(text) !== sha) bad(`results/prompts/${sha}.txt does not hash to its name`);
  }

  // skills
  const skills = await readSkillDirs(join(dir, 'skills'));
  const digest = skillsDigest(skills);
  if (digest.bundle_sha256 !== manifest.skills?.bundle_sha256) {
    const pinned: Record<string, string> = manifest.skills?.per_skill ?? {};
    const diff = [...new Set([...Object.keys(pinned), ...Object.keys(digest.per_skill)])].filter((n) => pinned[n] !== digest.per_skill[n]);
    bad(`skills/ does not match manifest.skills: ${diff.map((n) => `${n} (${!(n in digest.per_skill) ? 'missing' : !(n in pinned) ? 'not in the manifest' : 'changed'})`).join(', ') || 'bundle hash differs'}`);
  }
  notes.push(`${skills.size} skill(s): ${[...skills.keys()].join(', ') || '(none)'}`);

  // no test leakage into training traces
  const testFiles = new Set<string>((splits?.test ?? []).map((id: string) => safeName(String(id))));
  for (const it of (await readdir(join(dir, 'raw')).catch(() => [] as string[])))
    for (const f of await readdir(join(dir, 'raw', it)).catch(() => [] as string[]))
      if (testFiles.has(f.replace(/\.json$/, ''))) bad(`raw/${it}/${f} is a test task trace`);

  return { dir, ok: problems.length === 0, problems, notes };
}

/** Checks <dir> if it holds a manifest, otherwise every run-N subdirectory (a multi-run experiment). */
export async function checkRuns(dir: string): Promise<CheckReport[]> {
  const subs = (await readdir(dir).catch(() => [] as string[])).filter((n) => /^run-\d+$/.test(n)).sort();
  if (await readFile(join(dir, 'manifest.json')).then(() => true, () => false)) {
    if (subs.length === 0) return [await checkRun(dir)];
    // a single run and run-N directories in one place: the parent's manifest would hide the others
    return [{ dir, ok: false, problems: [`${dir} holds both a single run (manifest.json) and ${subs.join(', ')}; check each separately or use a clean directory`], notes: [] }];
  }
  if (subs.length === 0) return [await checkRun(dir)];
  return Promise.all(subs.map((n) => checkRun(join(dir, n))));
}
