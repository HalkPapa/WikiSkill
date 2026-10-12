import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { SCHEMA_VERSION, parsePredictions, sha256, skillsDigest } from './handoff.js';
import { readSkillDirs } from './store.js';

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
  if (!manifest.environment?.tool?.git_commit || manifest.environment.tool.git_commit === 'unknown') notes.push('no git commit recorded for the producing code');

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
    if (r.run !== manifest.run) bad(`row for ${r.task_id}/${r.condition} has run "${r.run}", manifest says "${manifest.run}"`);
    const sp = splitOf.get(r.task_id);
    if (splits && sp !== r.split) bad(`row ${r.task_id}/${r.condition} says split "${r.split}" but splits.json says "${sp ?? 'unknown task'}"`);
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
    if ([...perTask.values()].some((c) => c !== 1)) bad(`${split}/${condition}: some tasks have more than one row`);
  }
  if ((manifest.split_sizes?.test ?? 0) === 0) notes.push('no test split: nothing to compare on held-out data');
  notes.push(`${rows.length} prediction rows`);

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
  if (digest.bundle_sha256 !== manifest.skills?.bundle_sha256) bad('skills/ does not match manifest.skills.bundle_sha256 (edited after the run?)');
  notes.push(`${skills.size} skill(s): ${[...skills.keys()].join(', ') || '(none)'}`);

  // no test leakage into training traces
  const testIds = new Set<string>(splits?.test ?? []);
  for (const it of (await readdir(join(dir, 'raw')).catch(() => [] as string[])))
    for (const f of await readdir(join(dir, 'raw', it)).catch(() => [] as string[]))
      if (testIds.has(f.replace(/\.json$/, ''))) bad(`raw/${it}/${f} is a test task trace`);

  return { dir, ok: problems.length === 0, problems, notes };
}

/** Checks <dir> if it holds a manifest, otherwise every run-N subdirectory (a multi-run experiment). */
export async function checkRuns(dir: string): Promise<CheckReport[]> {
  if (await readFile(join(dir, 'manifest.json')).then(() => true, () => false)) return [await checkRun(dir)];
  const subs = (await readdir(dir).catch(() => [] as string[])).filter((n) => /^run-\d+$/.test(n)).sort();
  if (subs.length === 0) return [await checkRun(dir)];
  return Promise.all(subs.map((n) => checkRun(join(dir, n))));
}
