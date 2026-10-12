import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fill, makeTasks } from '../src/maketasks.js';

const records = Array.from({ length: 10 }, (_, i) => ({ qid: `q${i}`, q: { text: `Question ${i}?`, choices: ['A) x', 'B) y', 'C) z'] }, answer: 'B', part: i < 5 ? 'train' : i < 7 ? 'val' : 'test' }));
const base = { records, idField: 'qid', inputTemplate: '{q.text}\n\nChoices:\n{q.choices}', expected: 'answer' };

test('fill replaces nested fields, joins arrays by line, and refuses a missing field', () => {
  assert.equal(fill('{q.text} / {q.choices}', records[0], 'r'), 'Question 0? / A) x\nB) y\nC) z');
  assert.throws(() => fill('{nope}', records[0], 'record 1'), /record 1: field "nope" is missing/);
});

test('split from a field keeps the dataset\'s own assignment', () => {
  const r = makeTasks({ ...base, splitField: 'part' });
  assert.deepEqual(r.counts, { train: 5, val: 2, test: 3 });
  assert.equal(r.warnings.length, 0);
  assert.deepEqual(r.tasks[0], { id: 'q0', input: 'Question 0?\n\nChoices:\nA) x\nB) y\nC) z', expected: 'B', split: 'train' });
  assert.throws(() => makeTasks({ ...base, splitField: 'answer' }), /must be train, val or test \(got "B"\)/);
});

test('split from a splits file leaves unlisted tasks out and rejects unknown or doubly listed ids', () => {
  const r = makeTasks({ ...base, splits: { train: ['q0', 'q1'], val: ['q2'], test: ['q9'] } });
  assert.deepEqual(r.counts, { train: 2, val: 1, test: 1 });
  assert.equal(r.tasks.length, 4);
  assert.throws(() => makeTasks({ ...base, splits: { train: ['q0'], test: ['nope'] } }), /ids that the dataset does not have: nope/);
  assert.throws(() => makeTasks({ ...base, splits: { train: ['q0'], val: ['q0'] } }), /in two splits/);
});

test('random split is seeded, has the requested sizes, and warns that it is not the paper\'s split', () => {
  const a = makeTasks({ ...base, random: { train: 4, val: 2, test: 3, seed: 7 } });
  const b = makeTasks({ ...base, random: { train: 4, val: 2, test: 3, seed: 7 } });
  const c = makeTasks({ ...base, random: { train: 4, val: 2, test: 3, seed: 8 } });
  assert.deepEqual(a.counts, { train: 4, val: 2, test: 3 });
  assert.deepEqual(a.tasks, b.tasks);
  assert.notDeepEqual(a.tasks.map((t) => t.id), c.tasks.map((t) => t.id));
  assert.match(a.warnings[0], /NOT the split used in the paper/);
  assert.throws(() => makeTasks({ ...base, random: { train: 8, val: 2, test: 3, seed: 1 } }), /asked for 13 tasks but the dataset has 10/);
});

test('exactly one split mode, unique ids, an expected answer for every task', () => {
  assert.throws(() => makeTasks({ ...base }), /exactly one way to split/);
  assert.throws(() => makeTasks({ ...base, splitField: 'part', random: { train: 1, val: 1, test: 1, seed: 1 } }), /exactly one way to split/);
  assert.throws(() => makeTasks({ ...base, records: [...records, records[0]], splitField: 'part' }), /duplicate task id "q0"/);
  assert.throws(() => makeTasks({ ...base, records: [{ ...records[0], answer: '' }], splitField: 'part' }), /no expected answer/);
  assert.throws(() => makeTasks({ ...base, records: [{ ...records[0], qid: undefined }], splitField: 'part' }), /no "qid" field/);
});

test('CLI make-tasks writes a tasks.jsonl that evolve accepts (JSON array input)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ws-mt-'));
  await writeFile(join(dir, 'data.json'), JSON.stringify(records));
  const out = join(dir, 'tasks.jsonl');
  const run = spawnSync('node', [join(process.cwd(), 'dist/src/cli.js'), 'make-tasks', '--in', join(dir, 'data.json'), '--id-field', 'qid', '--input-template', '{q.text}\n{q.choices}', '--expected', 'answer', '--split-field', 'part', '--tasks-out', out], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /wrote 10 tasks to .*: train 5, val 2, test 3/);
  const lines = (await readFile(out, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 10);
  assert.deepEqual(Object.keys(lines[0]).sort(), ['expected', 'id', 'input', 'split']);
  const bad = spawnSync('node', [join(process.cwd(), 'dist/src/cli.js'), 'make-tasks', '--in', join(dir, 'data.json'), '--id-field', 'qid', '--input-template', '{nope}', '--expected', 'answer', '--random-split', '4/2/3'], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /^error: record 1 \(q0\): field "nope" is missing/);
});
