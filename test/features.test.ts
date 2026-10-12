import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { evolve, splitTasks } from '../src/evolve.js';
import { runExperiment } from '../src/experiment.js';
import { openAiCompatible, parseStream, routeLlm } from '../src/llm.js';
import { applyProposal, countTraceReads, propose } from '../src/propose.js';
import { pairedBootstrap } from '../src/stats.js';
import { Store } from '../src/store.js';
import type { Llm, LlmCall, Task, Trace } from '../src/types.js';
import { splitTools } from '../src/util.js';

const tasks = (n: number, split?: Task['split']): Task[] =>
  Array.from({ length: n }, (_, i) => ({ id: `${split ?? 'u'}${i}`, input: `q${i}`, expected: 'right', ...(split ? { split } : {}) }));
const skillMd = (name: string, body: string) => `---\nname: ${name}\ndescription: use when asked\n---\n\n## Instructions\n${body}\n`;
const tmp = () => mkdtemp(join(tmpdir(), 'ws-feat-'));

/** Agent answers right iff the skill text contains USE-TRICK. `onCall` observes every call. */
function mock(proposal: object, onCall?: (c: LlmCall) => Promise<void> | void): Llm {
  return async (c) => {
    await onCall?.(c);
    if (c.role === 'infer') return `<answer>${c.system?.includes('USE-TRICK') ? 'right' : 'wrong'}</answer>`;
    if (c.role === 'wiki')
      return JSON.stringify({ create_patterns: [{ name: 'p.md', content: '# P\n> s' }], update_index: '- [p](wiki/patterns/p.md): s', append_log: 'l' });
    return JSON.stringify(proposal);
  };
}
const trick = { action: 'create', name: 'trick', skill_md: skillMd('trick', 'Do USE-TRICK.'), purpose_md: '# P' };
const base = { tasks: [...tasks(4, 'train'), ...tasks(3, 'val')], iterations: 1 };

test('fresh run refuses a non-empty directory; --force wipes; --resume continues numbering and skills', async () => {
  const out = await tmp();
  await evolve({ ...base, outDir: out, llm: mock({ action: 'no_action' }) });
  await assert.rejects(evolve({ ...base, outDir: out, llm: mock(trick) }), /--resume.*--force/);

  const forced = await evolve({ ...base, outDir: out, llm: mock(trick), force: true });
  assert.equal(forced.bestScore, 1);
  assert.deepEqual(await readdir(join(out, 'raw')), ['iter-01']);

  const logs: string[] = [];
  const resumed = await evolve({ ...base, outDir: out, llm: mock({ action: 'no_action' }), resume: true, log: (m) => logs.push(m) });
  assert.deepEqual([...resumed.skills.keys()], ['trick']); // loaded from skills/
  assert.equal(resumed.bestScore, 1);
  assert.ok(logs.some((l) => /resumed val=1\.000.*after iter 1/.test(l)));
});

test('test split: final evaluation, report.json and paired bootstrap', async () => {
  const out = await tmp();
  const res = await evolve({ tasks: [...tasks(3, 'train'), ...tasks(3, 'val'), ...tasks(6, 'test')], iterations: 1, outDir: out, llm: mock(trick) });
  assert.equal(res.test!.baselineAccuracy, 0);
  assert.equal(res.test!.evolvedAccuracy, 1);
  assert.ok(res.test!.bootstrap.significant);
  const report = JSON.parse(await readFile(join(out, 'report.json'), 'utf8'));
  assert.equal(report.schema_version, 1);
  assert.equal(report.test.evolved_accuracy, 1);
});

test('runs > 1: independent run-N directories and averaged test result', async () => {
  const out = await tmp();
  const r = await runExperiment({ tasks: [...tasks(3, 'train'), ...tasks(3, 'val'), ...tasks(4, 'test')], iterations: 1, outDir: out, llm: mock(trick), runs: 2 });
  assert.equal(r.runs.length, 2);
  assert.deepEqual((await readdir(out)).sort(), ['report.json', 'run-1', 'run-2']);
  assert.deepEqual((await readdir(join(out, 'run-2'))).sort(), ['manifest.json', 'raw', 'report.json', 'results', 'skills', 'splits.json', 'tasks.jsonl', 'wiki']);
  assert.equal(r.test!.meanEvolvedAccuracy, 1);
  assert.equal(r.meanBaselineVal, 0);
});

test('ablations follow the paper: no-wiki proposer also drops the Wiki Maintainer; agent reads the wiki in training only', async () => {
  // (1) proposer without wiki: workspace holds only raw/ and skills/, and the Wiki Maintainer is never called
  const roles: string[] = [];
  let proposeDir: string[] | undefined;
  const out1 = await tmp();
  await evolve({
    ...base, outDir: out1, proposerSeesWiki: false,
    llm: mock(trick, async (c) => {
      roles.push(c.role);
      if (c.role === 'propose') proposeDir = (await readdir(c.cwd!)).sort();
    }),
  });
  assert.deepEqual(proposeDir, ['raw', 'skills']);
  assert.ok(!roles.includes('wiki'));
  assert.deepEqual(await readdir(join(out1, 'wiki/patterns')), []); // nothing accumulated
  assert.equal(JSON.parse(await readFile(join(out1, 'manifest.json'), 'utf8')).options.wiki_maintainer_enabled, false);

  // (2) agent with wiki access: only training rollouts get Read + a wiki/ copy, validation does not
  const calls: { tools: string[]; wiki: boolean; prompt: string }[] = [];
  const out2 = await tmp();
  const named = [...base.tasks.map((t) => ({ ...t, input: `${t.split}-${t.input}` }))];
  await evolve({
    ...base, tasks: named, outDir: out2, inferenceSeesWiki: true,
    llm: mock(trick, async (c) => {
      if (c.role === 'infer') calls.push({ tools: c.tools ?? [], wiki: (await readdir(c.cwd!)).includes('wiki'), prompt: c.prompt });
    }),
  });
  const training = calls.filter((c) => c.prompt.startsWith('train'));
  const evaluation = calls.filter((c) => !c.prompt.startsWith('train'));
  assert.ok(training.length > 0 && training.every((c) => c.wiki && c.tools.includes('Read')));
  assert.ok(evaluation.length > 0 && evaluation.every((c) => !c.wiki && c.tools.length === 0));
});

test('default: inference agent has no tools and no wiki; agentTools + bundled resources reach its workspace', async () => {
  const dirs: string[][] = [];
  const toolsSeen: string[][] = [];
  const out = await tmp();
  const withScript = { ...trick, resources: [{ path: 'scripts/check.py', content: 'print(1)' }] };
  const mk = (extra: object) => ({ ...base, outDir: '', ...extra });
  await evolve({
    ...mk({}), outDir: out, llm: mock(withScript, async (c) => {
      if (c.role === 'infer') toolsSeen.push(c.tools ?? []);
    }),
  });
  assert.ok(toolsSeen.every((t) => t.length === 0));
  assert.equal(await readFile(join(out, 'skills/trick/scripts/check.py'), 'utf8'), 'print(1)');

  await evolve({
    ...mk({}), outDir: await tmp(), agentTools: ['Bash(python3 *)'],
    llm: mock(withScript, async (c) => {
      if (c.role === 'infer' && c.system?.includes('Bundled files')) dirs.push(await readdir(join(c.cwd!, 'skills/trick/scripts')));
    }),
  });
  assert.deepEqual(dirs[0], ['check.py']);
});

test('resources are validated', async () => {
  const skills = new Map();
  const ok = applyProposal(skills, { ...trick, resources: [{ path: 'scripts/a.py', content: 'x' }] } as never);
  assert.deepEqual(ok!.get('trick')!.files, { 'scripts/a.py': 'x' });
  const store = new Store('/nonexistent');
  const bad = (path: string) =>
    propose(async () => JSON.stringify({ ...trick, resources: [{ path, content: 'x' }] }), store, skills, [], 1);
  for (const p of ['../x.py', '/etc/x', 'SKILL.md', 'a/../../b']) assert.equal(await bad(p), null, p);
});

test('proposer must read the required traces: one reminder, then accept', async () => {
  const out = await tmp();
  const store = new Store(out);
  await store.init();
  const failing: Trace[] = Array.from({ length: 5 }, (_, i) => ({ iteration: 1, taskId: `t${i}`, input: '', expected: 'a', output: '', answer: 'b', correct: false }));
  const read = (n: number) =>
    Array.from({ length: n }, (_, i) => `[tool_use] Read {"file_path":"/w/raw/iter-01/t${i}.json"}`).join('\n');
  const prompts: string[] = [];
  const llm: Llm = async (c) => {
    prompts.push(c.prompt);
    return { text: JSON.stringify(trick), transcript: read(prompts.length === 1 ? 1 : 4) };
  };
  const logs: string[] = [];
  const p = await propose(llm, store, new Map(), failing, 1, { log: (m) => logs.push(m) });
  assert.equal(p?.action, 'create');
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /REMINDER.*only 1 trace.*at least 4/s);
  assert.equal(countTraceReads(read(3) + '\n' + read(2)), 3); // distinct files
});

test('parseStream renders reasoning, tool calls and the final text', () => {
  const events = [
    { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'tool_use', name: 'Read', input: { file_path: 'a' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'file body' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'done <answer>1</answer>' }] } },
    { type: 'result', result: 'done <answer>1</answer>' },
  ].map((e) => JSON.stringify(e)).join('\n');
  const r = parseStream(events);
  assert.equal(r.text, 'done <answer>1</answer>');
  assert.match(r.transcript, /\[thinking\] hmm\n\[tool_use\] Read \{"file_path":"a"\}\n\[tool_result\] file body\n\[assistant\] done/);
});

test('parseStream redacts email addresses in the stored transcript but not in the scored text', () => {
  const events = [
    { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'User email: someone@example.com' }] } },
    { type: 'result', result: 'mail a.b@x.org' },
  ].map((e) => JSON.stringify(e)).join('\n');
  const r = parseStream(events);
  assert.match(r.transcript, /User email: \[email\]/);
  assert.ok(!r.transcript.includes('example.com') && !r.transcript.includes('x.org')); // incl. the [final] line
  assert.equal(r.text, 'mail a.b@x.org');
});

test('openAiCompatible talks to /chat/completions; routeLlm sends only the agent there', async () => {
  let body: any;
  const server = createServer((req, res) => {
    let s = '';
    req.on('data', (d) => (s += d));
    req.on('end', () => {
      body = JSON.parse(s);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: ' <answer>7</answer> ' } }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  try {
    const vllm = openAiCompatible({ baseUrl: `http://127.0.0.1:${port}/v1`, model: 'qwen' });
    const llm = routeLlm(vllm, async () => 'meta');
    assert.equal(await llm({ role: 'infer', system: 'S', prompt: 'P', tools: [] }), '<answer>7</answer>');
    assert.deepEqual(body.messages, [{ role: 'system', content: 'S' }, { role: 'user', content: 'P' }]);
    assert.equal(body.model, 'qwen');
    assert.equal(await llm({ role: 'wiki', prompt: 'x' }), 'meta');
    await assert.rejects(vllm({ role: 'infer', prompt: 'x', tools: ['Read'] }), /does not support tools/);
  } finally {
    server.close();
  }
});

test('pairedBootstrap, splitTasks with a test share, splitTools', () => {
  const one = Array(20).fill(1);
  const zero = Array(20).fill(0);
  assert.equal(pairedBootstrap(one, zero).p, 0);
  assert.ok(pairedBootstrap(one, zero).significant);
  assert.equal(pairedBootstrap(one, one).p, 1);
  assert.deepEqual(pairedBootstrap(one, zero), pairedBootstrap(one, zero)); // deterministic

  const s = splitTasks(tasks(20), 0.25, 0.25);
  assert.equal(s.test.length, 5);
  assert.equal(s.val.length, 4); // 25% of the 15 left
  assert.equal(s.train.length, 11);
  assert.equal(new Set([...s.train, ...s.val, ...s.test].map((t) => t.id)).size, 20);

  assert.deepEqual(splitTools('Read,Bash(python3 *, -m x), WebSearch'), ['Read', 'Bash(python3 *, -m x)', 'WebSearch']);
});
