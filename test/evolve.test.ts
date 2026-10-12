import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { evolve } from '../src/evolve.js';
import { buildSystem, extractAnswer, score } from '../src/infer.js';
import { applyEdits } from '../src/patch.js';
import { applyProposal, type Proposal } from '../src/propose.js';
import type { Llm, SkillSet, Task } from '../src/types.js';
import { sampleTraces } from '../src/wiki.js';
import { unifiedDiff } from '../src/util.js';

const tasks: Task[] = Array.from({ length: 6 }, (_, i) => ({ id: `t${i}`, input: `q${i}`, expected: 'right' }));

const skillMd = (name: string, body: string) => `---\nname: ${name}\ndescription: use when asked\n---\n\n## When to Apply\nAlways.\n\n## Instructions\n${body}\n`;

function mockLlm(proposals: object[], wikiReplies: object[] = []): { llm: Llm; seen: { infer: string[]; wiki: string[] } } {
  const seen = { infer: [] as string[], wiki: [] as string[] };
  let p = 0;
  let w = 0;
  const llm: Llm = async (c) => {
    if (c.role === 'infer') {
      seen.infer.push(c.system ?? '');
      return `thinking\n<answer>${c.system?.includes('USE-TRICK') ? 'right' : 'wrong'}</answer>`;
    }
    if (c.role === 'wiki') {
      seen.wiki.push(c.prompt);
      const r = wikiReplies[w++] ?? {
        create_patterns: [
          { name: 'needs-trick.md', content: '# Needs trick\n> agent fails without the trick\nbody' },
          { name: '../evil.md', content: 'x' },
        ],
        update_index: '- [needs-trick](wiki/patterns/needs-trick.md): fails without the trick; root cause X; use the trick',
        append_log: 'found pattern',
      };
      return JSON.stringify(r);
    }
    return JSON.stringify(proposals[p++] ?? proposals[proposals.length - 1]);
  };
  return { llm, seen };
}

test('accepts improving edit, keeps wiki, stops early at 1.0', async () => {
  const out = await mkdtemp(join(tmpdir(), 'ws-test-'));
  const { llm, seen } = mockLlm([
    { action: 'create', name: 'trick', skill_md: skillMd('trick', 'Do USE-TRICK.'), purpose_md: '# Purpose\nOrigin: needs-trick' },
  ]);
  const res = await evolve({ tasks, outDir: out, iterations: 3, llm, valRatio: 0.5, concurrency: 2 });

  assert.equal(res.bestScore, 1);
  assert.equal(res.history.length, 1);
  assert.equal(res.history[0].outcome, 'accepted');
  assert.deepEqual([...res.skills.keys()], ['trick']);
  assert.match(await readFile(join(out, 'skills/trick/SKILL.md'), 'utf8'), /name: trick/);
  assert.match(await readFile(join(out, 'skills/trick/PURPOSE.md'), 'utf8'), /Origin: needs-trick/);
  assert.match(await readFile(join(out, 'wiki/skill-impact.md'), 'utf8'), /Accepted/);
  assert.match(await readFile(join(out, 'wiki/index.md'), 'utf8'), /\(wiki\/patterns\/needs-trick\.md\): fails/);
  assert.match(await readFile(join(out, 'wiki/logs.md'), 'utf8'), /found pattern/);
  assert.deepEqual(await readdir(join(out, 'wiki/patterns')), ['needs-trick.md']); // path traversal dropped
  assert.ok(!seen.infer[0].includes('Available Skills')); // baseline ran with no skills
  assert.ok(seen.infer.some((s) => s.includes('USE-TRICK'))); // candidate skills injected into the system prompt
});

test('rejected edit leaves skills untouched but is logged; wiki persists and is patched', async () => {
  const out = await mkdtemp(join(tmpdir(), 'ws-test-'));
  const { llm, seen } = mockLlm(
    [{ action: 'create', name: 'useless', skill_md: skillMd('useless', 'nothing helpful') }],
    [
      undefined as never, // use the default first reply
      {
        update_patterns: [{ name: 'needs-trick.md', edits: [{ op: 'append', content: 'more evidence' }] }],
        update_index: '- [needs-trick](wiki/patterns/needs-trick.md): updated',
        append_log: 'second',
      },
    ],
  );
  const res = await evolve({ tasks, outDir: out, iterations: 2, llm, valRatio: 0.5 });
  assert.equal(res.bestScore, 0);
  assert.equal(res.skills.size, 0);
  assert.ok(res.history.every((h) => h.outcome === 'rejected' || h.outcome === 'invalid'));
  const impact = await readFile(join(out, 'wiki/skill-impact.md'), 'utf8');
  assert.match(impact, /Rejected/);
  assert.match(impact, /\+nothing helpful/); // full rejected content kept for the next proposal
  assert.match(await readFile(join(out, 'wiki/patterns/needs-trick.md'), 'utf8'), /more evidence/);
  assert.match(await readFile(join(out, 'wiki/index.md'), 'utf8'), /updated/);
  assert.ok(seen.wiki[1].includes('needs-trick.md')); // second iteration sees the first iteration's page
});

test('no_action is recorded without touching skills', async () => {
  const out = await mkdtemp(join(tmpdir(), 'ws-test-'));
  const { llm } = mockLlm([{ action: 'no_action' }]);
  const res = await evolve({ tasks, outDir: out, iterations: 1, llm, valRatio: 0.5 });
  assert.equal(res.history[0].outcome, 'no-proposal');
  assert.match(await readFile(join(out, 'wiki/skill-impact.md'), 'utf8'), /no_action/);
});

test('applyProposal validates create and patch', () => {
  const base: SkillSet = new Map([['s', { skillMd: skillMd('s', 'A B A'), purposeMd: '# P\n' }]]);
  const patch = (edits: object[]) => applyProposal(base, { action: 'patch', name: 's', edits } as Proposal, 2);
  const ok = patch([{ op: 'replace', target: 'B', content: 'C' }]);
  assert.ok(ok);
  assert.match(ok.get('s')!.purposeMd, /iter 2: patched/);
  assert.equal(patch([{ op: 'replace', target: 'A', content: 'C' }]), null); // ambiguous match
  assert.equal(patch([{ op: 'replace', target: 'zzz', content: 'C' }]), null); // no match
  assert.equal(patch([{ op: 'replace', target: 'name: s', content: 'name: other' }]), null); // frontmatter broken
  assert.equal(applyProposal(base, { action: 'create', name: 's', skill_md: skillMd('s', 'b') }), null); // exists
  assert.equal(applyProposal(base, { action: 'create', name: 'n', skill_md: skillMd('other', 'b') }), null); // name mismatch
  assert.ok(applyProposal(base, { action: 'create', name: 'n', skill_md: skillMd('n', 'b') }));
});

test('applyEdits supports append / replace / insert_after', () => {
  assert.equal(applyEdits('a\nb', [{ op: 'append', content: 'c' }]), 'a\nb\nc');
  assert.equal(applyEdits('a\nb\n', [{ op: 'insert_after', target: 'a', content: 'x' }]), 'a\nx\nb\n');
  assert.equal(applyEdits('a b a', [{ op: 'replace', target: 'a', content: 'z' }], false), 'z b a'); // lenient: first match
  assert.equal(applyEdits('a b a', [{ op: 'replace', target: 'a', content: 'z' }], true), null);
  assert.equal(applyEdits('a', [], true), null);
});

test('answer extraction, scoring and prompt', () => {
  assert.equal(extractAnswer('x <answer> 42 </answer> y <answer>43</answer>'), '43');
  assert.equal(extractAnswer('x\nANSWER: 42\n'), '42'); // fallback
  assert.equal(extractAnswer('no answer'), null);
  assert.ok(score(' Paris. ', 'paris', 'exact'));
  assert.ok(score('It is Paris', 'paris', 'contains'));
  assert.ok(!score(null, 'x', 'contains'));
  assert.match(buildSystem(new Map(), 'math problems'), /solves math problems.*<answer>/s);
});

test('trace sampling follows the paper: <=5 failing, <=3 passing', () => {
  const mk = (i: number, correct: boolean) => ({ iteration: 1, taskId: `t${i}`, input: '', expected: '', output: '', answer: null, correct });
  const traces = [...Array.from({ length: 9 }, (_, i) => mk(i, false)), ...Array.from({ length: 9 }, (_, i) => mk(20 + i, true))];
  const s = sampleTraces(traces);
  assert.equal(s.filter((t) => !t.correct).length, 5);
  assert.equal(s.filter((t) => t.correct).length, 3);
});

test('unifiedDiff marks changes', () => {
  const d = unifiedDiff('a\nb\nc', 'a\nB\nc', 'f');
  assert.match(d, /-b/);
  assert.match(d, /\+B/);
});
