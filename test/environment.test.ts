import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { evolve } from '../src/evolve.js';
import { sha256 } from '../src/handoff.js';
import { buildSystem, runTask } from '../src/infer.js';
import { commandScorer } from '../src/scorer.js';
import type { Llm, LlmCall, Task } from '../src/types.js';
import { readdir } from 'node:fs/promises';

const skills = new Map([['s', { skillMd: '---\nname: s\ndescription: d\n---\n\nSKILL-BODY\n', purposeMd: '' }]]);

test('agent prompt template: {skill_section} and {task_desc} are filled, the generic prompt is dropped', () => {
  const tpl = 'You solve {task_desc}.\n\n{skill_section}\n\n## Answer\n<answer>x</answer>\n';
  const sys = buildSystem(skills, { template: tpl, taskDesc: 'math' });
  assert.match(sys, /^You solve math\.\n\n## Available Skills/);
  assert.match(sys, /SKILL-BODY/);
  assert.match(sys, /## Answer\n<answer>x<\/answer>$/);
  assert.ok(!sys.includes('Think step by step')); // generic answer format not appended
  assert.equal(buildSystem(new Map(), { template: tpl }), 'You solve the given tasks.\n\n\n\n## Answer\n<answer>x</answer>');
  // a skill body containing "$&" must not be treated as a replacement pattern
  const tricky = new Map([['s', { skillMd: '---\nname: s\ndescription: d\n---\n\ncost $& $1\n', purposeMd: '' }]]);
  assert.match(buildSystem(tricky, { template: '{skill_section}' }), /cost \$& \$1/);
});

test('task workspace: files are copied, {workspace} resolved, the grader sees the agent\'s output files', async () => {
  const src = await mkdtemp(join(tmpdir(), 'ws-src-'));
  await writeFile(join(src, 'nums.txt'), '2\n3\n');
  await mkdir(join(src, 'sub'));
  await writeFile(join(src, 'sub', 'more.txt'), 'x');
  const task: Task = { id: 't', input: 'sum {workspace}/nums.txt', expected: '5', workspace: src };

  let seen: LlmCall | undefined;
  const agent: Llm = async (c) => {
    seen = c;
    // the agent "uses its tools": it reads the input file and writes a result file in its workspace
    const nums = (await readFile(join(c.cwd!, 'nums.txt'), 'utf8')).trim().split('\n').map(Number);
    await writeFile(join(c.cwd!, 'out.txt'), String(nums.reduce((a, b) => a + b, 0)));
    assert.deepEqual((await readdir(c.cwd!)).sort(), ['nums.txt', 'out.txt', 'skills', 'sub']);
    return '<answer>done</answer>';
  };
  const graderDir = await mkdtemp(join(tmpdir(), 'ws-grader-'));
  const grader = join(graderDir, 'g.js');
  await writeFile(grader, `let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);const fs=require('fs');const a=fs.readFileSync(process.env.WIKISKILL_WORKSPACE+'/out.txt','utf8');console.log(JSON.stringify({correct:a===j.expected&&j.workspace===process.env.WIKISKILL_WORKSPACE}))})`);
  const t = await runTask(agent, task, { skills, scorer: 'exact', scoreFn: commandScorer(`node ${grader}`), iteration: 0, agentTools: ['Read', 'Bash(python3 *)'], mcpConfig: '/x/mcp.json', promptTemplate: 'T {skill_section}' });
  assert.equal(t.correct, true); // graded from the file the agent wrote
  assert.equal(seen!.prompt, `sum ${seen!.cwd}/nums.txt`);
  assert.deepEqual(seen!.tools, ['Read', 'Bash(python3 *)']);
  assert.equal(seen!.mcpConfig, '/x/mcp.json');
  assert.match(seen!.system!, /^T ## Available Skills/);
  assert.equal(t.systemPromptSha256, sha256(seen!.system!));
  // the temp workspace is removed afterwards
  await assert.rejects(readFile(join(seen!.cwd!, 'out.txt')));
});

test('commandScorer: no workspace (re-scoring) gives null, and the env var is unset', async () => {
  const d = await mkdtemp(join(tmpdir(), 'ws-g2-'));
  const g = join(d, 'g.js');
  await writeFile(g, `let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(String(j.workspace===null&&!process.env.WIKISKILL_WORKSPACE))})`);
  assert.equal(await commandScorer(`node ${g}`)('a', { id: 'x', input: '', expected: 'a' }, { output: 'o' }), true);
});

test('manifest records the prompt template hash and MCP config', async () => {
  const out = await mkdtemp(join(tmpdir(), 'ws-env-'));
  const tpl = 'P {skill_section}\n<answer>..</answer>';
  const tasks: Task[] = [...[1, 2, 3].map((i) => ({ id: `a${i}`, input: 'q', expected: 'right', split: 'train' as const })), ...[1, 2].map((i) => ({ id: `b${i}`, input: 'q', expected: 'right', split: 'val' as const }))];
  await evolve({
    tasks, outDir: out, iterations: 0, agentPrompt: tpl, agentMcpConfig: '/c/mcp.json',
    llm: async (c) => { assert.equal(c.mcpConfig, '/c/mcp.json'); assert.ok(c.system!.startsWith('P ')); return '<answer>wrong</answer>'; },
  });
  const m = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8'));
  assert.equal(m.options.agent_prompt_sha256, sha256(tpl));
  assert.equal(m.options.agent_mcp_config, '/c/mcp.json');
});
