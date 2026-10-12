// Regression tests for the findings of the receiving-team walkthrough (docs/HANDOFF.md).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkRun } from '../src/check.js';
import { evolve } from '../src/evolve.js';
import { SCHEMA_VERSION, parsePredictions, sha256 } from '../src/handoff.js';
import { answerFromOutput, finalPart } from '../src/infer.js';
import { parseStream } from '../src/llm.js';
import { checkRows, rescore } from '../src/rescore.js';
import { commandScorer } from '../src/scorer.js';
import { pairedBootstrap } from '../src/stats.js';
import type { Llm, Task } from '../src/types.js';

const row = (o: Partial<Record<string, unknown>> = {}) => ({
  schema_version: 1, run: 'r', split: 'test', condition: 'external:x', iteration: 0, task_id: 't1', input: 'i', expected: 'A',
  answer: null, correct: false, scorer: 'exact', system_prompt_sha256: '', output: 'noise <answer>A</answer>', ...o,
}) as any;

test('answer extraction from stored logs follows the run-time rule: final reply first, then the whole log', () => {
  assert.equal(finalPart('[thinking] a\n[final] <answer>X</answer>'), '<answer>X</answer>');
  assert.equal(finalPart('plain text'), 'plain text');
  assert.equal(finalPart('[final] ANSWER: Z'), 'ANSWER: Z');
  // reasoning mentions a tagged answer, the final reply uses an ANSWER: line -> the final reply wins
  assert.equal(answerFromOutput('[thinking] x <answer>ThinkTag</answer>\n[final] ANSWER: FinalLine'), 'FinalLine');
  assert.equal(answerFromOutput('[final] ANSWER: OnlyLine'), 'OnlyLine'); // marker and answer on the same line
  assert.equal(answerFromOutput('[thinking] <answer>Early</answer>\n[final] no answer here'), 'Early'); // falls back to the whole log
  assert.equal(answerFromOutput('external AI text <answer> 42 </answer>'), '42'); // no markers needed
  assert.equal(answerFromOutput('nothing'), null);
});

test('rows whose answer is null are re-extracted, so an external AI is not silently scored 0', async () => {
  const res = await rescore({ rows: [row(), row({ condition: 'no-skills', output: 'x', answer: 'A' })] });
  const ext = res.summary.find((g) => g.condition === 'external:x')!;
  assert.equal(ext.accuracy, 1);
  assert.equal(ext.unanswered, 0);
  assert.equal(res.rows[0].answer, 'A');
  const lost = await rescore({ rows: [row({ output: 'I refuse' }), row({ condition: 'no-skills', answer: 'A' })] });
  assert.equal(lost.summary.find((g) => g.condition === 'external:x')!.unanswered, 1);
});

test('rescore reports inconsistent rows, missing tasks and split mismatches; unknown baseline is an error', async () => {
  const base = [row({ condition: 'no-skills', task_id: 't1' }), row({ condition: 'no-skills', task_id: 't2', expected: 'B' })];
  const ext = [row({ condition: 'external:x', task_id: 't1', expected: 'ZZ', input: 'other' })]; // t2 missing, t1 disagrees
  const w = checkRows([...base, ...ext], 'no-skills', { test: ['t1'] }).join('\n');
  assert.match(w, /test\/t1: rows disagree on "expected"/);
  assert.match(w, /test\/t1: rows disagree on "input"/);
  assert.match(w, /test\/external:x: covers 1 of the 2 no-skills tasks; missing t2/);
  assert.match(w, /task t2 is not in the test split/);
  assert.deepEqual(checkRows([...base], 'no-skills'), []);
  await assert.rejects(rescore({ rows: base, baseline: 'external:typo' }), /baseline condition "external:typo" has no rows; conditions present: no-skills/);
});

test('command grader: unrecognized output, missing command and timeouts are reported and counted wrong; a timeout also stops children', async () => {
  const errs: string[] = [];
  const t: Task = { id: 'x', input: '', expected: 'a' };
  assert.equal(await commandScorer('echo maybe', { onError: (m) => errs.push(m) })('a', t), false);
  assert.equal(await commandScorer('echo 2', { onError: (m) => errs.push(m) })('a', t), false);
  assert.equal(await commandScorer('no-such-command-xyz', { onError: (m) => errs.push(m) })('a', t), false);
  assert.match(errs[0], /unrecognized grader output "maybe"/);
  assert.match(errs[1], /unrecognized grader output "2"/);
  assert.match(errs[2], /exit 127/);
  const started = Date.now();
  assert.equal(await commandScorer('sleep 30; echo true', { timeoutMs: 300, onError: (m) => errs.push(m) })('a', t), false);
  assert.ok(Date.now() - started < 5000, 'a child of the shell must not keep the grader alive');
  assert.match(errs[3], /timed out after 0\.3 s/);
});

test('bootstrap reports a two-sided p, the pair count, and 0 means below the resolution', () => {
  const worse = pairedBootstrap(Array(20).fill(0), Array(20).fill(1));
  assert.equal(worse.p, 1); // "A better than B" is certainly false...
  assert.equal(worse.pTwoSided, 0); // ...but the two-sided test shows a clear difference
  assert.equal(worse.n, 20);
  assert.equal(pairedBootstrap(Array(5).fill(1), Array(5).fill(1)).pTwoSided, 1);
});

test('parseStream captures the resolved model id', () => {
  const r = parseStream([{ type: 'system', subtype: 'init', model: 'claude-haiku-4-5-20251001' }, { type: 'result', result: 'ok' }].map((e) => JSON.stringify(e)).join('\n'));
  assert.equal(r.model, 'claude-haiku-4-5-20251001');
});

const all: Task[] = [...[0, 1, 2].map((i) => ({ id: `a${i}`, input: `train-${i}`, expected: 'right', split: 'train' as const })), ...[0, 1].map((i) => ({ id: `v${i}`, input: `val-${i}`, expected: 'right', split: 'val' as const })), ...[0, 1, 2].map((i) => ({ id: `x${i}`, input: `test-${i}`, expected: 'right', split: 'test' as const }))];
const llm: Llm = async (c) => {
  if (c.role === 'infer') return { text: `<answer>${c.system?.includes('USE-TRICK') ? 'right' : 'wrong'}</answer>`, transcript: '[final] <answer>x</answer>', model: 'claude-test-1' };
  if (c.role === 'wiki') return JSON.stringify({ update_index: '- x', append_log: 'l' });
  return JSON.stringify({ action: 'create', name: 'trick', skill_md: '---\nname: trick\ndescription: d\n---\n\nUSE-TRICK\n', purpose_md: '# P' });
};

test('a run ships tasks.jsonl, pins content hashes, records the model and write times; check detects later edits', async () => {
  const out = await mkdtemp(join(tmpdir(), 'ws-rev-'));
  await evolve({ tasks: all, outDir: out, iterations: 1, llm, codeDiff: 'diff --git a b\n+x\n' });
  const m = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8'));
  for (const [key, file] of [['predictions', 'results/predictions.jsonl'], ['tasks', 'tasks.jsonl'], ['splits', 'splits.json']] as const)
    assert.equal(m.files_sha256[key], sha256(await readFile(join(out, file), 'utf8')), key);
  assert.equal(m.files.code_diff, 'results/code.diff');
  const tasks = (await readFile(join(out, 'tasks.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(tasks.length, 8);
  assert.deepEqual(tasks.find((t) => t.id === 'x1'), { id: 'x1', input: 'test-1', expected: 'right', split: 'test' });
  const rows = parsePredictions(await readFile(join(out, 'results/predictions.jsonl'), 'utf8'));
  assert.ok(rows.every((r) => r.model === 'claude-test-1' && !Number.isNaN(Date.parse(r.created_at!))));
  assert.deepEqual((await checkRun(out)).problems, []);

  // tampering with a stored verdict, or with the claim, is detected
  const file = join(out, 'results/predictions.jsonl');
  const original = await readFile(file, 'utf8');
  await writeFile(file, original.replace('"correct":true', '"correct":false'));
  assert.match((await checkRun(out)).problems.join('\n'), /results\/predictions\.jsonl was changed after the run/);
  await writeFile(file, original);
  await writeFile(join(out, 'manifest.json'), JSON.stringify({ ...m, guarantees: { ...m.guarantees, test_split_used_during_evolution: true } }));
  assert.match((await checkRun(out)).problems.join('\n'), /test_split_used_during_evolution is not false/);
  await writeFile(join(out, 'manifest.json'), JSON.stringify(m));
  await writeFile(join(out, 'tasks.jsonl'), (await readFile(join(out, 'tasks.jsonl'), 'utf8')).replace('"split":"test"', '"split":"val"'));
  assert.match((await checkRun(out)).problems.join('\n'), /tasks\.jsonl was changed after the run/);
});

test('check names the skill that changed and the tasks that have duplicate rows', async () => {
  const out = await mkdtemp(join(tmpdir(), 'ws-rev2-'));
  await evolve({ tasks: all, outDir: out, iterations: 1, llm });
  await writeFile(join(out, 'skills/trick/SKILL.md'), (await readFile(join(out, 'skills/trick/SKILL.md'), 'utf8')) + 'x');
  assert.match((await checkRun(out)).problems.join('\n'), /skills\/ does not match manifest\.skills: trick \(changed\)/);
});

test('CLI: --help works, errors have no stack trace, unknown scorer and baseline are explained, grader failures set exit status 1', async () => {
  const cli = (...args: string[]) => spawnSync('node', ['dist/src/cli.js', ...args], { encoding: 'utf8' });
  const help = cli('--help');
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage:/);
  assert.match(help.stdout, /Exit status/);
  const dir = await mkdtemp(join(tmpdir(), 'ws-cli2-'));
  const pred = join(dir, 'p.jsonl');
  await writeFile(pred, [row({ condition: 'no-skills', answer: 'A' }), row()].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const badScorer = cli('rescore', '--predictions', pred, '--scorer', 'fuzzy');
  assert.equal(badScorer.status, 1);
  assert.match(badScorer.stderr, /^error: --scorer must be exact or contains \(got "fuzzy"\)/);
  assert.ok(!badScorer.stderr.includes('    at '));
  const badBase = cli('rescore', '--predictions', pred, '--baseline', 'external:typo');
  assert.equal(badBase.status, 1);
  assert.match(badBase.stderr, /baseline condition "external:typo" has no rows/);
  const ok = cli('rescore', '--predictions', pred);
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /diff \+0\.000 on 1 tasks, p=1\.000 \(one-sided\), 1\.000 \(two-sided\)[^\n]*low power/);
  const failing = cli('rescore', '--predictions', pred, '--scorer-cmd', 'echo maybe');
  assert.equal(failing.status, 1);
  assert.match(failing.stderr, /could not be graded by --scorer-cmd/);
  assert.ok(SCHEMA_VERSION === 1);
});
