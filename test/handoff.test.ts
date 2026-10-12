import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { evaluateSkillSets } from '../src/evaluate.js';
import { evolve } from '../src/evolve.js';
import { PREDICTION_REQUIRED_KEYS, SCHEMA_VERSION, parsePredictions, sha256, skillsDigest, snakeKeys, validatePredictionRow } from '../src/handoff.js';
import { rescore } from '../src/rescore.js';
import type { Llm, LlmCall, Task } from '../src/types.js';

const mk = (n: number, split: Task['split']): Task[] => Array.from({ length: n }, (_, i) => ({ id: `${split}${i}`, input: `${split}-q${i}`, expected: 'right', split }));
const all = [...mk(4, 'train'), ...mk(3, 'val'), ...mk(4, 'test')];
const trick = { action: 'create', name: 'trick', skill_md: '---\nname: trick\ndescription: d\n---\n\nUSE-TRICK\n', purpose_md: '# P' };
const llm = (onCall?: (c: LlmCall) => void): Llm => async (c) => {
  onCall?.(c);
  if (c.role === 'infer') return { text: `<answer>${c.system?.includes('USE-TRICK') ? 'right' : 'wrong'}</answer>`, transcript: `[thinking] hmm\n[final] <answer>${c.system?.includes('USE-TRICK') ? 'right' : 'wrong'}</answer>` };
  if (c.role === 'wiki') return JSON.stringify({ update_index: '- x', append_log: 'l' });
  return JSON.stringify(trick);
};
const readRows = async (dir: string) => parsePredictions(await readFile(join(dir, 'results/predictions.jsonl'), 'utf8'));

test('a run writes the hand-off files: manifest, splits, predictions, prompts', async () => {
  const out = await mkdtemp(join(tmpdir(), 'ws-hand-'));
  const res = await evolve({ tasks: all, outDir: out, iterations: 2, llm: llm(), runInfo: { tool: { name: 'wikiskill', version: 'x' } } });

  const manifest = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8'));
  assert.equal(manifest.schema_version, SCHEMA_VERSION);
  assert.equal(manifest.status, 'completed');
  assert.equal(manifest.run, 'run-1');
  assert.deepEqual(manifest.environment, { tool: { name: 'wikiskill', version: 'x' } });
  assert.deepEqual(manifest.split_sizes, { train: 4, val: 3, test: 4 });
  assert.equal(manifest.guarantees.test_split_used_during_evolution, false);
  assert.deepEqual(manifest.skills, { names: ['trick'], ...skillsDigest(res.skills) });
  assert.ok(manifest.finished_at && manifest.started_at);

  const splits = JSON.parse(await readFile(join(out, 'splits.json'), 'utf8'));
  assert.deepEqual(splits, { schema_version: 1, train: ['train0', 'train1', 'train2', 'train3'], val: ['val0', 'val1', 'val2'], test: ['test0', 'test1', 'test2', 'test3'] });

  const rows = await readRows(out);
  for (const r of rows) assert.deepEqual(validatePredictionRow(r), []);
  const conditions = (split: string) => [...new Set(rows.filter((r) => r.split === split).map((r) => r.condition))].sort();
  assert.deepEqual(conditions('test'), ['evolved', 'no-skills']); // the hand-off comparison
  assert.deepEqual(conditions('val'), ['candidate:trick@iter1', 'no-skills']);
  assert.equal(rows.filter((r) => r.split === 'test' && r.condition === 'evolved').length, 4);
  const evolvedRow = rows.find((r) => r.condition === 'evolved')!;
  assert.match(evolvedRow.output, /\[thinking\] hmm/); // raw execution log is kept, not just the verdict
  assert.equal(evolvedRow.answer, 'right');
  assert.equal(evolvedRow.scorer, 'exact');

  // every referenced system prompt is archived, and its hash matches its text
  const prompts = await readdir(join(out, 'results/prompts'));
  for (const sha of new Set(rows.map((r) => r.system_prompt_sha256))) {
    assert.ok(prompts.includes(`${sha}.txt`));
    assert.equal(sha256(await readFile(join(out, 'results/prompts', `${sha}.txt`), 'utf8')), sha);
  }
  assert.notEqual(rows.find((r) => r.condition === 'no-skills')!.system_prompt_sha256, evolvedRow.system_prompt_sha256);

  const report = JSON.parse(await readFile(join(out, 'report.json'), 'utf8'));
  assert.deepEqual([report.schema_version, report.best_val, report.test.evolved_accuracy], [1, 1, 1]);
});

test('the held-out test split is never given to the agent during evolution', async () => {
  const order: string[] = [];
  const out = await mkdtemp(join(tmpdir(), 'ws-leak-'));
  await evolve({ tasks: all, outDir: out, iterations: 3, llm: llm((c) => order.push(c.role === 'infer' ? c.prompt : c.role)) });
  const firstTest = order.findIndex((x) => x.startsWith('test-'));
  const lastEvolution = Math.max(order.lastIndexOf('wiki'), order.lastIndexOf('propose'));
  const lastNonTestInfer = Math.max(...order.map((x, i) => (x.startsWith('train-') || x.startsWith('val-') ? i : -1)));
  assert.ok(firstTest > lastEvolution && firstTest > lastNonTestInfer, 'test tasks must come after all training, validation and proposal calls');
  const raw = (await readdir(join(out, 'raw'))).length ? await readdir(join(out, 'raw', 'iter-01')) : [];
  assert.ok(raw.every((f) => !f.startsWith('test'))); // no test traces among the training traces
});

test('a crashed run leaves manifest.status = failed with the error', async () => {
  const out = await mkdtemp(join(tmpdir(), 'ws-fail-'));
  const boom: Llm = async (c) => {
    if (c.role === 'wiki') throw new Error('wiki exploded');
    return '<answer>wrong</answer>';
  };
  await assert.rejects(evolve({ tasks: all, outDir: out, iterations: 1, llm: boom }), /wiki exploded/);
  const m = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8'));
  assert.equal(m.status, 'failed');
  assert.match(m.error, /wiki exploded/);
});

test('rescore re-grades stored predictions without an agent and keeps the original verdict', async () => {
  const out = await mkdtemp(join(tmpdir(), 'ws-resc-'));
  await evolve({ tasks: all, outDir: out, iterations: 1, llm: llm() });
  const rows = await readRows(out);

  const strict = await rescore({ rows, scoreFn: () => false });
  assert.equal(strict.changed, rows.filter((r) => r.correct).length);
  assert.ok(strict.rows.every((r) => r.scorer === 'custom' && (r as any).correct_original !== undefined));
  assert.ok(strict.rows.every((r) => r.correct === false));

  const again = await rescore({ rows: strict.rows, scorer: 'exact' }); // re-scoring twice must not lose the first verdict
  assert.deepEqual(again.rows.map((r) => (r as any).correct_original), rows.map((r) => r.correct));
  assert.deepEqual(again.rows.map((r) => r.correct), rows.map((r) => r.correct));

  const test = again.summary.filter((g) => g.split === 'test');
  assert.deepEqual(test.map((g) => [g.condition, g.accuracy]), [['evolved', 1], ['no-skills', 0]]);
  assert.ok(test.find((g) => g.condition === 'evolved')!.vs_baseline!.significant);
  assert.ok(!again.summary.some((g) => g.condition.startsWith('candidate:'))); // gate bookkeeping is not a comparison arm

  // a grader that looks at the raw output: --reparse re-extracts the answer from it
  const damaged = rows.map((r) => ({ ...r, answer: null, correct: false }));
  const fixed = await rescore({ rows: damaged, reparse: true });
  assert.ok(fixed.rows.filter((r) => r.condition === 'evolved').every((r) => r.correct && r.answer === 'right'));
});

test('parsePredictions refuses malformed or newer-schema rows with the line number', () => {
  const ok = { schema_version: 1, run: 'r', split: 'test', condition: 'c', iteration: 0, task_id: 't', input: 'i', expected: 'e', answer: null, correct: false, scorer: 'exact', system_prompt_sha256: '', output: '' };
  assert.equal(parsePredictions(JSON.stringify(ok) + '\n').length, 1);
  assert.throws(() => parsePredictions(`${JSON.stringify(ok)}\n{not json}\n`, 'f.jsonl'), /f\.jsonl line 2: not valid JSON/);
  const { output, ...missing } = ok;
  assert.throws(() => parsePredictions(JSON.stringify(missing)), /line 1: missing output/);
  assert.throws(() => parsePredictions(JSON.stringify({ ...ok, schema_version: 2 })), /newer than supported/);
  assert.deepEqual(validatePredictionRow({ ...ok, extra_field: 1 }), []); // additive changes stay compatible
  assert.deepEqual(snakeKeys({ bestVal: 1, test: { evolvedAccuracy: 2 } }), { best_val: 1, test: { evolved_accuracy: 2 } });
});

test('eval emits predictions in the same schema, with prompts', async () => {
  const skills = new Map([['trick', { skillMd: '---\nname: trick\ndescription: d\n---\n\nUSE-TRICK\n', purposeMd: '' }]]);
  const res = await evaluateSkillSets({ tasks: mk(3, 'test'), llm: llm(), sets: [{ name: 'from-other-model', skills }], splitLabel: 'test', runLabel: 'xfer' });
  assert.equal(res.predictions.length, 6);
  for (const r of res.predictions) assert.deepEqual(validatePredictionRow(r), []);
  assert.deepEqual([...new Set(res.predictions.map((r) => r.condition))].sort(), ['from-other-model', 'no-skills']);
  assert.ok(res.predictions.every((r) => r.run === 'xfer' && r.split === 'test' && sha256(res.prompts[r.system_prompt_sha256]) === r.system_prompt_sha256));
});

test('the JSON schema files list the same required keys as the code, and the CLI re-scores a file', async () => {
  const schema = JSON.parse(await readFile(join(process.cwd(), 'docs/schema/prediction-row.schema.json'), 'utf8'));
  assert.deepEqual([...schema.required].sort(), [...PREDICTION_REQUIRED_KEYS].sort());
  assert.deepEqual(Object.keys(schema.properties).filter((k) => k !== 'correct_original').sort(), [...PREDICTION_REQUIRED_KEYS].sort());
  const manifestSchema = JSON.parse(await readFile(join(process.cwd(), 'docs/schema/manifest.schema.json'), 'utf8'));

  const out = await mkdtemp(join(tmpdir(), 'ws-cli-'));
  await evolve({ tasks: all, outDir: out, iterations: 1, llm: llm() });
  const manifest = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8'));
  for (const k of manifestSchema.required) assert.ok(k in manifest, `manifest.${k}`);
  for (const k of manifestSchema.properties.options.required) assert.ok(k in manifest.options, `options.${k}`);

  const rowsOut = join(out, 'rescored.jsonl');
  const run = spawnSync('node', ['dist/src/cli.js', 'rescore', '--predictions', join(out, 'results/predictions.jsonl'), '--scorer', 'contains', '--rows-out', rowsOut], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /rows re-scored with "contains"; 0 changed verdict/);
  assert.match(run.stdout, /test\s+evolved\s+1\.000/);
  assert.equal(parsePredictions(await readFile(rowsOut, 'utf8')).length, (await readRows(out)).length);
  await writeFile(join(out, 'bad.jsonl'), '{"oops":1}\n');
  const bad = spawnSync('node', ['dist/src/cli.js', 'rescore', '--predictions', join(out, 'bad.jsonl')], { encoding: 'utf8' });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /line 1: missing schema_version/);
});

test('check passes on a clean run and catches tampering, leaks and missing pieces', async () => {
  const { checkRun, checkRuns } = await import('../src/check.js');
  const out = await mkdtemp(join(tmpdir(), 'ws-check-'));
  await evolve({ tasks: all, outDir: out, iterations: 1, llm: llm() });
  const clean = await checkRun(out);
  assert.deepEqual(clean.problems, []);
  assert.ok(clean.ok);

  // editing a skill after the run breaks the pinned digest
  const skillFile = join(out, 'skills/trick/SKILL.md');
  const original = await readFile(skillFile, 'utf8');
  await writeFile(skillFile, original + '\nextra');
  assert.match((await checkRun(out)).problems.join('\n'), /skills\/ does not match manifest/);
  await writeFile(skillFile, original);

  // a tampered prompt file no longer hashes to its name
  const prompts = await readdir(join(out, 'results/prompts'));
  await writeFile(join(out, 'results/prompts', prompts[0]), 'changed');
  assert.match((await checkRun(out)).problems.join('\n'), /does not hash to its name/);

  // a missing prediction row for a test task is reported
  const file = join(out, 'results/predictions.jsonl');
  const lines = (await readFile(file, 'utf8')).trim().split('\n');
  const dropAt = lines.findIndex((l) => JSON.parse(l).split === 'test' && JSON.parse(l).condition === 'evolved');
  await writeFile(file, lines.filter((_, i) => i !== dropAt).join('\n') + '\n');
  assert.match((await checkRun(out)).problems.join('\n'), /test\/evolved: rows for 3 tasks, expected 4/);

  // an unfinished run is not hand-over ready
  const m = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8'));
  await writeFile(join(out, 'manifest.json'), JSON.stringify({ ...m, status: 'running' }));
  assert.match((await checkRun(out)).problems.join('\n'), /status is "running"/);

  assert.equal((await checkRuns(await mkdtemp(join(tmpdir(), 'ws-empty-'))))[0].ok, false);
});

test('resuming does not duplicate test or baseline rows, and --baseline picks the comparison arm', async () => {
  const { checkRun } = await import('../src/check.js');
  const out = await mkdtemp(join(tmpdir(), 'ws-resume-'));
  await evolve({ tasks: all, outDir: out, iterations: 1, llm: llm() });
  await evolve({ tasks: all, outDir: out, iterations: 1, llm: llm(), resume: true });
  const check = await checkRun(out);
  assert.deepEqual(check.problems, []);

  // treat "evolved" as the reference, e.g. when an external AI is compared with the evolved skills
  const rows = await readRows(out);
  const external = rows.filter((r) => r.condition === 'evolved' && r.split === 'test').map((r) => ({ ...r, condition: 'external:other-ai', answer: 'wrong', correct: false }));
  const res = await rescore({ rows: [...rows, ...external], baseline: 'evolved' });
  const ext = res.summary.find((g) => g.split === 'test' && g.condition === 'external:other-ai')!;
  assert.equal(res.baseline, 'evolved');
  assert.equal(ext.accuracy, 0);
  assert.equal(ext.vs_baseline!.meanDiff, -1);
  assert.equal(res.summary.find((g) => g.split === 'test' && g.condition === 'evolved')!.vs_baseline, undefined);
});
