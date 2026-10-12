import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { evaluateSkillSets } from '../src/evaluate.js';
import { evolve } from '../src/evolve.js';
import { commandScorer, parseVerdict } from '../src/scorer.js';
import { readSkillDirs } from '../src/store.js';
import type { Llm, SkillSet, Task } from '../src/types.js';

const tasks: Task[] = Array.from({ length: 8 }, (_, i) => ({ id: `t${i}`, input: `q${i}`, expected: 'right' }));
const skill = (name: string, body: string): SkillSet =>
  new Map([[name, { skillMd: `---\nname: ${name}\ndescription: d\n---\n\n${body}\n`, purposeMd: '' }]]);
/** Answers right iff a skill mentioning its keyword is present. */
const llm = (keyword: string): Llm => async (c) => `<answer>${c.system?.includes(keyword) ? 'right' : 'wrong'}</answer>`;

test('evaluateSkillSets compares sets with the baseline and with the first set', async () => {
  const res = await evaluateSkillSets({
    tasks,
    llm: llm('GOOD'),
    sets: [
      { name: 'a', skills: skill('a', 'GOOD advice') },
      { name: 'b', skills: skill('b', 'unhelpful') },
    ],
  });
  assert.equal(res.baseline.accuracy, 0);
  assert.equal(res.sets[0].accuracy, 1);
  assert.ok(res.sets[0].vsBaseline.significant);
  assert.equal(res.sets[0].vsFirst, undefined);
  assert.equal(res.sets[1].accuracy, 0);
  assert.equal(res.sets[1].vsFirst!.meanDiff, -1);
  assert.equal(res.sets[1].vsFirst!.significant, false);
});

test('evaluateSkillSets averages repeats and honours a custom grader', async () => {
  let n = 0;
  const flaky: Llm = async () => `<answer>${n++ % 2 === 0 ? 'right' : 'wrong'}</answer>`;
  const res = await evaluateSkillSets({ tasks: tasks.slice(0, 2), llm: flaky, sets: [{ name: 's', skills: skill('s', 'x') }], repeats: 2, concurrency: 1 });
  assert.ok(res.baseline.scores.every((x) => x === 0.5 || x === 0 || x === 1));
  const always = await evaluateSkillSets({
    tasks: tasks.slice(0, 2), llm: llm('NONE'), sets: [{ name: 's', skills: skill('s', 'x') }],
    scoreFn: () => true,
  });
  assert.equal(always.baseline.accuracy, 1); // grader overrides string matching
});

test('readSkillDirs reads an evolved skills/ directory, including bundled files', async () => {
  const out = await mkdtemp(join(tmpdir(), 'ws-eval-'));
  await evolve({
    tasks: [...tasks.slice(0, 3).map((t) => ({ ...t, split: 'train' as const })), ...tasks.slice(3, 6).map((t) => ({ ...t, split: 'val' as const }))],
    iterations: 1, outDir: out, llm: async (c) => {
      if (c.role === 'infer') return `<answer>${c.system?.includes('KEY') ? 'right' : 'wrong'}</answer>`;
      if (c.role === 'wiki') return JSON.stringify({ update_index: '- x', append_log: 'l' });
      return JSON.stringify({ action: 'create', name: 'k', skill_md: '---\nname: k\ndescription: d\n---\n\nKEY\n', resources: [{ path: 'scripts/a.py', content: 'x' }] });
    },
  });
  const skills = await readSkillDirs(join(out, 'skills'));
  assert.deepEqual([...skills.keys()], ['k']);
  assert.equal(skills.get('k')!.files!['scripts/a.py'], 'x');
  assert.deepEqual(await readSkillDirs(join(out, 'nope')), new Map());
  await mkdir(join(out, 'skills', 'empty-dir'));
  assert.equal((await readSkillDirs(join(out, 'skills'))).size, 1); // dir without SKILL.md skipped
});

test('commandScorer feeds JSON on stdin and reads a verdict', async () => {
  const task: Task = { id: 'x', input: 'in', expected: '42' };
  const dir = await mkdtemp(join(tmpdir(), 'ws-score-'));
  const script = join(dir, 'grade.js');
  await writeFile(script, `let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(JSON.stringify({correct:j.answer===j.expected&&j.id==='x'}))})`);
  const grade = commandScorer(`node ${script}`);
  assert.equal(await grade('42', task), true);
  assert.equal(await grade('41', task), false);
  assert.equal(await grade(null, task), false);
  const errors: string[] = [];
  assert.equal(await commandScorer('exit 3', { onError: (m) => errors.push(m) })('42', task), false);
  assert.match(errors[0], /scorer for x: exit 3/);
  assert.equal(await commandScorer('echo true')('anything', task), true); // command ignoring stdin
});

test('parseVerdict accepts the documented formats', () => {
  for (const [out, want] of [['true', true], ['1\n', true], ['false', false], ['0', false], ['{"correct":true}', true], ['{"correct":false}', false], ['{"score":1}', true], ['{"score":0.5}', false],
    ['', null], ['garbage', null], ['2', null], ['maybe', null], ['true extra', null], ['{"correct":"true"}', null], ['[1]', null]] as const)
    assert.equal(parseVerdict(out), want, out);
});
