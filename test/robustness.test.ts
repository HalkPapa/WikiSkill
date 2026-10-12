// Regression tests for the code review of the hand-off contract (ガード).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, chmod, mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkRun, checkRuns } from '../src/check.js';
import { evolve } from '../src/evolve.js';
import { runExperiment } from '../src/experiment.js';
import { applyProposal, propose, sanitizeProposal, validResources } from '../src/propose.js';
import { pairedBootstrap } from '../src/stats.js';
import { Store, writeSkillDirs } from '../src/store.js';
import type { Llm, LlmCall, Task } from '../src/types.js';
import { intOption, safeName } from '../src/util.js';
import { maintainWiki } from '../src/wiki.js';

const all: Task[] = [
  ...[0, 1, 2].map((i) => ({ id: `a${i}`, input: `train-${i}`, expected: 'right', split: 'train' as const })),
  ...[0, 1].map((i) => ({ id: `v${i}`, input: `val-${i}`, expected: 'right', split: 'val' as const })),
  ...[0, 1].map((i) => ({ id: `x${i}`, input: `test-${i}`, expected: 'SECRET-TEST-ANSWER', split: 'test' as const })),
];
const tmp = (p = 'ws-rob-') => mkdtemp(join(tmpdir(), p));
const plain: Llm = async (c) => (c.role === 'infer' ? '<answer>wrong</answer>' : c.role === 'wiki' ? JSON.stringify({ update_index: '- x', append_log: 'l' }) : JSON.stringify({ action: 'no_action' }));

test('the proposer works in a sandbox: it cannot read tasks.jsonl, splits, predictions or the manifest', async () => {
  let listing: string[] = [];
  let leaked = true;
  const out = await tmp();
  await evolve({
    tasks: all, outDir: out, iterations: 1,
    llm: async (c: LlmCall) => {
      if (c.role === 'propose') {
        listing = (await readdir(c.cwd!)).sort();
        leaked = (await readFile(join(c.cwd!, 'tasks.jsonl'), 'utf8').catch(() => '')).includes('SECRET-TEST-ANSWER');
      }
      return plain(c);
    },
  });
  assert.deepEqual(listing, ['raw', 'skills', 'wiki']);
  assert.equal(leaked, false);
  // tasks.jsonl (which holds the test truths) appears only once the run is complete
  assert.match(await readFile(join(out, 'tasks.jsonl'), 'utf8'), /SECRET-TEST-ANSWER/);
});

test('bootstrap p-values are exact for fractional per-task scores (float noise must not flip a sample)', () => {
  const a = [0.1, 0.2, 0.3, 0, 0, 0];
  const b = [0, 0, 0, 0.1, 0.2, 0.3];
  const scaled = pairedBootstrap(a.map((x) => Math.round(x * 10)), b.map((x) => Math.round(x * 10)));
  const fractional = pairedBootstrap(a, b);
  assert.equal(fractional.p, scaled.p);
  assert.equal(fractional.pTwoSided, scaled.pTwoSided);
});

test('an agent failure is retried once, then flagged: the row is an error, not a wrong answer, and check refuses the run', async () => {
  let calls = 0;
  const flaky: Llm = async (c) => {
    if (c.role === 'infer' && c.prompt === 'val-0' && calls++ === 0) throw new Error('rate limited'); // first attempt only
    return plain(c);
  };
  const out = await tmp();
  await evolve({ tasks: all, outDir: out, iterations: 0, llm: flaky });
  const rows = (await readFile(join(out, 'results/predictions.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(rows.every((r) => r.error === undefined)); // the retry succeeded
  assert.equal(JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8')).quality.agent_errors, 0);

  // one task keeps failing: flagged, counted in the manifest, and check fails the run
  const picky: Llm = async (c) => {
    if (c.role === 'infer' && c.prompt === 'test-1') throw new Error('timeout');
    return plain(c);
  };
  const out2 = await tmp();
  await evolve({ tasks: all, outDir: out2, iterations: 0, llm: picky });
  const rows2 = (await readFile(join(out2, 'results/predictions.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  const bad = rows2.filter((r) => r.error);
  assert.deepEqual(bad.map((r) => [r.task_id, r.correct]), [['x1', false], ['x1', false]]); // both conditions
  assert.match(bad[0].output, /^\[agent error\] timeout/);
  const problems = (await checkRun(out2)).problems.join('\n');
  assert.match(problems, /2 agent call\(s\) failed/);
  assert.match(problems, /is an agent failure, not an answer/);

  // when most calls fail the run stops instead of writing a column of zeros
  const down: Llm = async (c) => {
    if (c.role === 'infer') throw new Error('service down');
    return plain(c);
  };
  const out3 = await tmp();
  await assert.rejects(evolve({ tasks: all, outDir: out3, iterations: 1, llm: down }), /agent calls failed.*stopping/);
  assert.equal(JSON.parse(await readFile(join(out3, 'manifest.json'), 'utf8')).status, 'failed');
});

test('a directory that is not a WikiSkill run is never reset, merged into or deleted from', async () => {
  const dir = await tmp();
  await mkdir(join(dir, 'skills', 'my-tool'), { recursive: true });
  await writeFile(join(dir, 'skills', 'my-tool', 'main.py'), 'precious');
  await mkdir(join(dir, 'results'));
  await writeFile(join(dir, 'results', 'thesis.csv'), 'precious');
  await assert.rejects(evolve({ tasks: all, outDir: dir, iterations: 0, llm: plain }), /not from a WikiSkill run/);
  await assert.rejects(evolve({ tasks: all, outDir: dir, iterations: 0, llm: plain, force: true }), /not from a WikiSkill run/);
  assert.equal(await readFile(join(dir, 'skills', 'my-tool', 'main.py'), 'utf8'), 'precious');
  assert.equal(await readFile(join(dir, 'results', 'thesis.csv'), 'utf8'), 'precious');
  assert.equal(await new Store(dir).state(), 'foreign');
  await assert.rejects(evolve({ tasks: all, outDir: await tmp(), iterations: 0, llm: plain, resume: true }), /holds no WikiSkill run to continue/);
});

test('--runs N: the parent must be clean, --resume is refused, and check reports a parent holding both layouts', async () => {
  const dir = await tmp();
  await evolve({ tasks: all, outDir: dir, iterations: 0, llm: plain }); // a single run in <dir>
  await assert.rejects(runExperiment({ tasks: all, outDir: dir, iterations: 0, llm: plain, runs: 2 }), /already holds a single run/);
  await assert.rejects(runExperiment({ tasks: all, outDir: dir, iterations: 0, llm: plain, runs: 2, resume: true }), /--resume cannot be combined with --runs/);
  await runExperiment({ tasks: all, outDir: dir, iterations: 0, llm: plain, runs: 2, force: true }); // --force replaces it
  assert.deepEqual((await readdir(dir)).filter((n) => /^run-/.test(n)).sort(), ['run-1', 'run-2']);
  assert.ok(!(await readdir(dir)).includes('manifest.json'));
  // a leftover single-run manifest next to run-N is reported, not silently preferred
  await writeFile(join(dir, 'manifest.json'), '{}');
  const reports = await checkRuns(dir);
  assert.equal(reports.length, 1);
  assert.match(reports[0].problems[0], /holds both a single run \(manifest\.json\) and run-1, run-2/);
});

test('task ids map to distinct trace files, and check finds a test trace even for ids with odd characters', async () => {
  assert.notEqual(safeName('a/b'), safeName('a_b'));
  assert.equal(safeName('plain-1.x'), 'plain-1.x');
  const tasks: Task[] = [
    { id: 'a/b', input: 'train-1', expected: 'right', split: 'train' },
    { id: 'a_b', input: 'train-2', expected: 'right', split: 'train' },
    { id: 'v', input: 'val-1', expected: 'right', split: 'val' },
    { id: 'test/1', input: 'test-1', expected: 'right', split: 'test' },
  ];
  const out = await tmp();
  await evolve({ tasks, outDir: out, iterations: 1, llm: plain });
  assert.deepEqual((await readdir(join(out, 'raw/iter-01'))).sort(), ['a%2Fb.json', 'a_b.json']); // two tasks, two files
  assert.deepEqual((await checkRun(out)).problems, []);
  await writeFile(join(out, 'raw/iter-01', `${safeName('test/1')}.json`), '{}');
  assert.match((await checkRun(out)).problems.join('\n'), /is a test task trace/);
});

test('model output is validated: hostile wiki and proposal JSON cannot crash a paid run', async () => {
  const dir = await tmp();
  const store = new Store(dir);
  await store.init();
  const traces = [{ iteration: 1, taskId: 't', input: 'i', expected: 'e', output: 'o', answer: 'x', correct: false }];
  const hostile: Llm = async () => JSON.stringify({ create_patterns: { name: 'x.md' }, update_patterns: 'nope', update_index: ['a'], append_log: ['not', 'a', 'string'] });
  assert.match(await maintainWiki(hostile, store, traces, 1), /0 created, 0 updated/); // no exception
  const partial: Llm = async () => JSON.stringify({ create_patterns: [null, { name: 5, content: 'x' }, { name: 'ok.md', content: '# T\n> s' }], append_log: 'fine' });
  assert.match(await maintainWiki(partial, store, traces, 1), /1 created, 0 updated, 2 invalid/);

  assert.ok(!('rationale' in sanitizeProposal({ action: 'patch', name: 's', edits: [{ op: 'append', content: 'x' }], rationale: ['array'] })!));
  assert.equal(sanitizeProposal({ action: 'create', name: 's', skill_md: 5 }), null);
  assert.equal(sanitizeProposal({ action: 'patch', name: 's', edits: 'x' }), null);
  assert.equal(sanitizeProposal({ action: 'create', name: '../x', skill_md: 'y' }), null);
  assert.equal(sanitizeProposal(null), null);
});

test('bundled resources must be canonical, non-reserved, collision-free; a patch cannot create a file/directory clash', () => {
  const ok = (...paths: string[]) => validResources(paths.map((path) => ({ path, content: 'x' })));
  assert.ok(ok('scripts/check.py', 'data/a.txt'));
  assert.ok(!ok('a', 'a/b')); // "a" would have to be a file and a directory
  assert.ok(!ok('scripts/./x.py'));
  assert.ok(!ok('scripts//x.py'));
  assert.ok(!ok('scripts/'));
  assert.ok(!ok('../x'));
  assert.ok(!ok('/etc/x'));
  assert.ok(!ok('SKILL.md'));
  assert.ok(!ok('skill.md/x'));
  assert.ok(!ok('same.txt', 'same.txt'));
  const skills = new Map([['s', { skillMd: '---\nname: s\ndescription: d\n---\n\nb\n', purposeMd: '', files: { 'a': 'file' } }]]);
  const clash = applyProposal(skills, { action: 'patch', name: 's', edits: [{ op: 'append', content: 'x' }], resources: [{ path: 'a/b', content: 'y' }] });
  assert.equal(clash, null);
});

test('skills are swapped in atomically: no leftovers, and the previous set survives a failed write', async () => {
  const dir = join(await tmp(), 'skills');
  const set = (n: string, files?: Record<string, string>) => new Map([[n, { skillMd: `---\nname: ${n}\ndescription: d\n---\n`, purposeMd: 'p', files }]]);
  await writeSkillDirs(set('one'), dir);
  assert.deepEqual(await readdir(dir), ['one']);
  assert.deepEqual(await readdir(join(dir, '..')), ['skills']); // no ".writing" directory left behind
  await assert.rejects(writeSkillDirs(set('two', { a: 'file', 'a/b': 'clash' }), dir)); // impossible layout
  assert.deepEqual(await readdir(dir), ['one']); // the adopted skills are untouched
});

test('check accepts an older run without hashes or tasks.jsonl but says so', async () => {
  const out = await tmp();
  await evolve({ tasks: all, outDir: out, iterations: 0, llm: plain });
  const m = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8'));
  delete m.files_sha256;
  await writeFile(join(out, 'manifest.json'), JSON.stringify(m));
  await writeFile(join(out, 'tasks.jsonl'), '');
  const r = await checkRun(out);
  assert.ok(!r.problems.some((p) => /hash/.test(p)));
  assert.ok(r.notes.some((n) => /pins no content hashes/.test(n)));
});

test('numeric options are validated instead of becoming NaN', () => {
  assert.equal(intOption('iters', '3'), 3);
  for (const bad of ['abc', '', '1.5', '-1']) assert.throws(() => intOption('iters', bad), /--iters must be an integer >= 0/);
  assert.throws(() => intOption('concurrency', '0', 1), /--concurrency must be an integer >= 1/);
});

// ---- CLI end to end with an offline stand-in for the claude CLI ----
async function fakeClaudeEnv() {
  const bin = await tmp('ws-bin-');
  await copyFile(join(process.cwd(), 'test/fixtures/fake-claude.mjs'), join(bin, 'claude'));
  await chmod(join(bin, 'claude'), 0o755);
  return { ...process.env, PATH: `${bin}:${process.env.PATH}` };
}
const tasksFile = async (lines: object[]) => {
  const f = join(await tmp('ws-tasks-'), 'tasks.jsonl');
  await writeFile(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return f;
};
const cli = (env: NodeJS.ProcessEnv, cwd: string, ...args: string[]) => spawnSync('node', [join(process.cwd(), 'dist/src/cli.js'), ...args], { encoding: 'utf8', env, cwd });

test('CLI: task files are validated before anything runs', async () => {
  const env = await fakeClaudeEnv();
  const cwd = await tmp('ws-cwd-');
  const run = (lines: object[], ...extra: string[]) => tasksFile(lines).then((f) => cli(env, cwd, 'evolve', '--tasks', f, '--out', join(cwd, 'o'), ...extra));
  const ok = [{ id: 'a', input: 'i', expected: 'e', split: 'train' }, { id: 'b', input: 'i', expected: 'e', split: 'val' }];
  const typo = await run([...ok, { id: 'c', input: 'i', expected: 'e', split: 'Test' }]);
  assert.equal(typo.status, 1);
  assert.match(typo.stderr, /line 3: split must be "train", "val" or "test" \(got "Test"\)/);
  const dup = await run([...ok, { id: 'a', input: 'i', expected: 'e' }]);
  assert.match(dup.stderr, /line 3: duplicate task id "a"/);
  const noInput = await run([{ id: 'x', expected: 'e' }]);
  assert.match(noInput.stderr, /need a non-empty id, a string input and an expected value/);
  const badIters = await run(ok, '--iters', 'abc');
  assert.match(badIters.stderr, /--iters must be an integer >= 0 \(got "abc"\)/);
  assert.ok(!(await readdir(cwd)).includes('o')); // nothing was created
});

test('CLI: evolve end to end — git facts come from the tool checkout, not the current directory; check passes', async () => {
  const env = await fakeClaudeEnv();
  const elsewhere = await tmp('ws-else-'); // an unrelated git repo with an uncommitted secret
  spawnSync('git', ['init', '-q'], { cwd: elsewhere });
  await writeFile(join(elsewhere, 'private.env'), 'API_KEY=hunter2');
  const file = await tasksFile([
    ...[0, 1, 2].map((i) => ({ id: `a${i}`, input: `q${i}`, expected: 'right', split: 'train' })),
    ...[0, 1].map((i) => ({ id: `v${i}`, input: `q${i}`, expected: 'right', split: 'val' })),
    ...[0, 1].map((i) => ({ id: `x${i}`, input: `q${i}`, expected: 'right', split: 'test' })),
  ]);
  const out = join(elsewhere, 'out dir ünï'); // spaces and non-ASCII in the output path
  const run = cli({ ...env, FAKE_PROPOSAL: JSON.stringify({ action: 'create', name: 'trick', skill_md: '---\nname: trick\ndescription: d\n---\n\nUSE-TRICK\n' }) }, elsewhere, 'evolve', '--tasks', file, '--out', out, '--iters', '1', '--concurrency', '2');
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /test: no skills 0\.000 → evolved 1\.000/);
  const manifest = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8'));
  const toolHead = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: process.cwd(), encoding: 'utf8' }).stdout.trim();
  assert.equal(manifest.environment.tool.git_commit, toolHead);
  assert.equal(manifest.environment.runtime.claude_cli, 'fake-claude 0.0.0');
  assert.equal(manifest.status, 'completed');
  assert.deepEqual(manifest.quality, { agent_errors: 0, grader_failures: 0 });
  const diff = await readFile(join(out, 'results/code.diff'), 'utf8').catch(() => '');
  assert.ok(!diff.includes('hunter2')); // the other repo's uncommitted file is never captured
  const rows = (await readFile(join(out, 'results/predictions.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(rows.filter((r) => r.condition === 'evolved').every((r) => r.model === 'fake-model-1'));
  const check = cli(env, elsewhere, 'check', '--run', out);
  assert.equal(check.status, 0, check.stdout);
});

test('CLI: a failing external grader or a failing agent makes evolve exit 1 and the run fail check/stop', async () => {
  const env = await fakeClaudeEnv();
  const cwd = await tmp('ws-cwd2-');
  const file = await tasksFile([
    ...[0, 1].map((i) => ({ id: `a${i}`, input: `q${i}`, expected: 'wrong', split: 'train' })),
    ...[0, 1].map((i) => ({ id: `v${i}`, input: `q${i}`, expected: 'wrong', split: 'val' })),
    ...[0, 1].map((i) => ({ id: `x${i}`, input: `q${i}`, expected: 'wrong', split: 'test' })),
  ]);
  const out = join(cwd, 'g');
  const g = cli(env, cwd, 'evolve', '--tasks', file, '--out', out, '--iters', '0', '--scorer-cmd', 'no-such-grader-xyz');
  assert.equal(g.status, 1);
  assert.match(g.stderr, /could not be graded by --scorer-cmd/);
  assert.equal(JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8')).quality.grader_failures > 0, true);
  assert.match(cli(env, cwd, 'check', '--run', out).stdout, /external-grader call\(s\) failed/);

  const down = cli({ ...env, FAKE_FAIL_INFER: '1' }, cwd, 'evolve', '--tasks', file, '--out', join(cwd, 'd'), '--iters', '1');
  assert.equal(down.status, 1);
  assert.match(down.stderr, /agent calls failed.*stopping/);
  assert.equal(JSON.parse(await readFile(join(cwd, 'd/manifest.json'), 'utf8')).status, 'failed');
});

// ---- spending meter and cap ----
import { parseStream } from '../src/llm.js';
import { BudgetExceededError, UsageMeter } from '../src/usage.js';
import { runTask } from '../src/infer.js';

test('UsageMeter totals per role and refuses the next call once the cap is reached', () => {
  const m = new UsageMeter(0.05);
  m.add('infer', { costUsd: 0.02, input: 10, output: 5, cacheCreation: 100, cacheRead: 7 });
  m.add('wiki', { costUsd: 0.03 });
  const s = m.snapshot();
  assert.deepEqual([s.calls, s.usd, s.max_usd, s.by_role.infer.calls, s.by_role.wiki.usd, s.cache_creation_tokens], [2, 0.05, 0.05, 1, 0.03, 100]);
  assert.throws(() => m.assertWithin(), BudgetExceededError);
  assert.doesNotThrow(() => new UsageMeter().assertWithin()); // no cap: never
  assert.doesNotThrow(() => new UsageMeter(1).assertWithin());
});

test('parseStream reads cost and token counts from the result event', () => {
  const r = parseStream([{ type: 'result', result: 'ok', total_cost_usd: 0.0142, usage: { input_tokens: 9, output_tokens: 96, cache_creation_input_tokens: 6577 } }].map((e) => JSON.stringify(e)).join('\n'));
  assert.deepEqual(r.usage, { costUsd: 0.0142, input: 9, output: 96, cacheCreation: 6577, cacheRead: undefined });
});

test('a spending cap is not an agent failure: it propagates out of runTask', async () => {
  const capped: Llm = async () => {
    throw new BudgetExceededError('cap reached');
  };
  await assert.rejects(runTask(capped, { id: 't', input: 'i', expected: 'e' }, { skills: new Map(), scorer: 'exact', iteration: 0 }), BudgetExceededError);
});

test('CLI: usage is reported and recorded; --max-cost stops the run, which can then be resumed', async () => {
  const env = await fakeClaudeEnv();
  const cwd = await tmp('ws-cost-');
  const file = await tasksFile([
    ...[0, 1, 2].map((i) => ({ id: `a${i}`, input: `q${i}`, expected: 'right', split: 'train' })),
    ...[0, 1].map((i) => ({ id: `v${i}`, input: `q${i}`, expected: 'right', split: 'val' })),
    ...[0, 1].map((i) => ({ id: `x${i}`, input: `q${i}`, expected: 'right', split: 'test' })),
  ]);
  const out = join(cwd, 'ok');
  const run = cli({ ...env, FAKE_COST: '0.02' }, cwd, 'evolve', '--tasks', file, '--out', out, '--iters', '1', '--concurrency', '1');
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /\[wikiskill\] usage: \d+ calls, \$\d+\.\d\d as reported by the claude CLI \(.*infer \d+ calls/);
  const manifest = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8'));
  assert.ok(manifest.usage.calls > 5 && manifest.usage.usd > 0.1 && manifest.usage.by_role.infer.calls > 0 && manifest.usage.by_role.wiki.calls === 1);
  assert.equal(manifest.usage.max_usd, null);
  const rows = (await readFile(join(out, 'results/predictions.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(rows.every((r) => r.cost_usd === 0.02));

  const capped = join(cwd, 'capped');
  const stop = cli({ ...env, FAKE_COST: '0.02' }, cwd, 'evolve', '--tasks', file, '--out', capped, '--iters', '2', '--concurrency', '1', '--max-cost', '0.1');
  assert.equal(stop.status, 1);
  assert.match(stop.stderr, /spending cap of \$0\.10 reached/);
  const failed = JSON.parse(await readFile(join(capped, 'manifest.json'), 'utf8'));
  assert.equal(failed.status, 'failed');
  assert.equal(failed.usage.max_usd, 0.1);
  assert.ok(failed.usage.usd >= 0.1 && failed.usage.usd < 0.2); // concurrency 1: at most one call over the cap
  assert.equal(cli(env, cwd, 'check', '--run', capped).status, 1); // an unfinished run is never hand-over ready

  const bad = cli(env, cwd, 'evolve', '--tasks', file, '--out', join(cwd, 'b'), '--max-cost', '0');
  assert.match(bad.stderr, /--max-cost must be a positive number of USD/);
});
