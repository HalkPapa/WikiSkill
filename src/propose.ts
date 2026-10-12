import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Llm, SkillSet, Trace } from './types.js';
import type { Store } from './store.js';
import { applyEdits, type EditOp } from './patch.js';
import { extractJson, replyText, replyTranscript } from './util.js';

/**
 * Skill Proposer system prompt, adapted from the paper's Appendix E.3. Differences: `read_file` is Claude Code's
 * Read tool, `finish` is the final JSON reply, traces live at raw/iter-NN/<task_id>.json, skill names are kebab-case
 * (Claude Code skills), the prompt says to read the current SKILL.md before patching, SKILL.md must start with
 * frontmatter, and a skill may bundle extra files via "resources". With `useWiki: false` the wiki steps are removed
 * (the paper's "proposer without wiki" ablation).
 */
const system = (taskDesc: string, useWiki: boolean) => `You are a Skill Proposer Agent for an LLM agent that solves ${taskDesc}. Your job is to explore ${useWiki ? 'the wiki knowledge base and ' : ''}execution traces, diagnose root causes of failures, and propose a skill change (create or patch).

## Tools Available
1. The Read tool (read_file) -- Read ${useWiki ? 'a wiki file, ' : ''}a skill, or an execution trace. Paths are relative to the workspace root.
2. finish -- when you are done, reply with ONLY the final proposal as a JSON object (no other text).

## Workflow
${
  useWiki
    ? `1. Start by reading wiki/index.md to understand what patterns exist
2. Read wiki/skill-impact.md to see what was tried before (includes full content of rejected proposals -- DO NOT repeat rejected approaches)
3. Read specific pattern pages that seem relevant to the current failures
4. Read execution traces for failed tasks (raw/iter-NN/<task_id>.json, the iteration is given below) to understand root causes
5. Decide: create (new skill) or patch (edit existing skill at skills/<name>/SKILL.md -- read it first), or no_action
6. If proposing a change, finish with the full proposal`
    : `(No wiki is available in this setup.)
1. Read execution traces for failed tasks (raw/iter-NN/<task_id>.json, the iteration is given below) to understand root causes
2. Decide: create (new skill) or patch (edit existing skill at skills/<name>/SKILL.md -- read it first), or no_action
3. If proposing a change, finish with the full proposal`
}

## finish Proposal Format
For creating a new skill:
- "action": "create"
- "name": skill directory name (lowercase kebab-case, e.g. break-repetition-loop)
- "skill_md": full SKILL.md content. It MUST start with a YAML frontmatter block ("---", "name: <the same name>", "description: <one line: when to use>", "---"), followed by When to Apply + When NOT to Apply + Instructions
- "purpose_md": full PURPOSE.md content with Origin + Patterns Addressed + Evolution History
- optional "resources": [{"path": "scripts/check.py", "content": "..."}] -- extra files bundled in the skill directory (scripts, references)
For patching an existing skill:
- "action": "patch"
- "name": existing skill directory name
- "edits": list of patch operations:
  - {"op": "append", "content": "text to add at end"}
  - {"op": "replace", "target": "exact text to find", "content": "replacement"}
  - {"op": "insert_after", "target": "exact text to find", "content": "text to insert after"}
- optional "resources": files to add or replace in the skill directory
Each "replace" target must be a short, specific section that occurs exactly once -- not the entire file. If you need to change most of the file, use "action": "create" with a NEW name instead.
Optionally add "rationale": one or two sentences on why this change should help (kept in the audit trail).
If no action is needed, finish with: {"action": "no_action"}

## Rules
1. ${useWiki ? "Read the wiki FIRST -- don't propose something that was already tried and rejected. skill-impact.md contains full content of rejected proposals." : 'Check the current skills first so you do not duplicate them.'}
2. Focus on action patterns and concrete strategies; keep skills general (never hard-code single task answers).
3. Keep skills concise and actionable.
4. You MUST read at least 4 execution traces (or all of them if fewer failed) before proposing a skill change. Target your exploration based on the trace summary.
5. Prefer patching existing skills over creating new ones when the existing skill is partially correct.`;

export interface Resource {
  path: string;
  content: string;
}

export type Proposal =
  | { action: 'create'; name: string; skill_md: string; purpose_md?: string; resources?: Resource[]; rationale?: string }
  | { action: 'patch'; name: string; edits: EditOp[]; resources?: Resource[]; rationale?: string }
  | { action: 'no_action' };

const NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const RESOURCE_PATH = /^(?!.*\.\.)(?!\/)[\w][\w./-]*$/;

export function validResources(res: unknown): res is Resource[] {
  return (
    Array.isArray(res) &&
    res.length <= 20 &&
    res.every(
      (r) =>
        r && typeof r.path === 'string' && typeof r.content === 'string' && RESOURCE_PATH.test(r.path) &&
        !['skill.md', 'purpose.md'].includes(r.path.toLowerCase()),
    )
  );
}

export interface ProposeOptions {
  taskDesc?: string;
  /** Ablation: false hides the wiki from the proposer (default true). */
  useWiki?: boolean;
  /** Called with notes such as an unmet read requirement. */
  log?: (msg: string) => void;
}

/** Distinct raw/iter-NN trace files the proposer opened with the Read tool, per the execution transcript. */
export function countTraceReads(transcript: string): number {
  const seen = new Set<string>();
  for (const m of transcript.matchAll(/\[tool_use\] Read [^\n]*?(raw\/iter-\d+\/[\w.-]+\.json)/g)) seen.add(m[1]);
  return seen.size;
}

export async function propose(
  llm: Llm,
  store: Store,
  skills: SkillSet,
  traces: Trace[],
  iteration: number,
  o: ProposeOptions = {},
): Promise<Proposal | null> {
  const useWiki = o.useWiki ?? true;
  const failures = traces.filter((t) => !t.correct);
  const pass = traces.length - failures.length;
  const summary = failures
    .map((t) => `- ${t.taskId}: predicted ${JSON.stringify(t.answer)}, truth ${JSON.stringify(t.expected)}`)
    .join('\n');
  const prompt = [
    `# Iteration ${iteration}: traces are in raw/iter-${String(iteration).padStart(2, '0')}/<task_id>.json`,
    `# Current skills\n${[...skills.keys()].map((n) => `skills/${n}/SKILL.md`).join('\n') || '(none)'}`,
    `# Training outcome: ${pass}/${traces.length} passed\n${summary || '(all passed)'}`,
  ].join('\n\n');

  // Without the wiki the proposer works in a copy holding only raw/ and skills/.
  const hidden = useWiki ? undefined : await mkdtemp(join(tmpdir(), 'wikiskill-propose-'));
  try {
    if (hidden) {
      await store.copyInto('raw', hidden);
      await store.copyInto('skills', hidden);
    }
    const call = (extra = '') =>
      llm({ role: 'propose', system: system(o.taskDesc ?? 'the given tasks', useWiki), prompt: prompt + extra, tools: ['Read'], cwd: hidden ?? store.root });

    let reply = await call();
    const need = Math.min(4, failures.length);
    const reads = countTraceReads(replyTranscript(reply));
    const hasTranscript = typeof reply !== 'string';
    const p0 = extractJson<Proposal>(replyText(reply));
    if (hasTranscript && p0 && p0.action !== 'no_action' && reads < need) {
      o.log?.(`proposer read ${reads}/${need} required traces; asking once more`);
      reply = await call(`\n\nREMINDER: your previous attempt opened only ${reads} trace file(s). Read at least ${need} failing traces under raw/iter-${String(iteration).padStart(2, '0')}/ before you finish.`);
    }
    const p = extractJson<Proposal>(replyText(reply));
    if (!p) return null;
    if (p.action === 'no_action') return p;
    if ((p.action !== 'create' && p.action !== 'patch') || !NAME.test(p.name ?? '')) return null;
    if (p.resources !== undefined && !validResources(p.resources)) return null;
    return p;
  } finally {
    if (hidden) await rm(hidden, { recursive: true, force: true });
  }
}

const frontmatter = (name: string) => new RegExp(`^---\\nname:\\s*${name}[ \\t]*\\n(?:[\\s\\S]*?\\n)?description:\\s*\\S[\\s\\S]*?\\n---\\n`);

const toRecord = (res: Resource[] | undefined) => Object.fromEntries((res ?? []).map((r) => [r.path, r.content]));

/** Applies a proposal to a copy of the skill set. Returns null if it is invalid. */
export function applyProposal(skills: SkillSet, p: Proposal, iteration = 0): SkillSet | null {
  if (p.action === 'no_action') return null;
  const next: SkillSet = new Map(skills);
  const prev = skills.get(p.name);
  if (p.action === 'create') {
    if (prev || typeof p.skill_md !== 'string' || !frontmatter(p.name).test(p.skill_md)) return null;
    const purposeMd = typeof p.purpose_md === 'string' && p.purpose_md.trim() ? p.purpose_md : `# Purpose: ${p.name}\n`;
    const files = toRecord(p.resources);
    next.set(p.name, {
      skillMd: p.skill_md.endsWith('\n') ? p.skill_md : p.skill_md + '\n',
      purposeMd,
      ...(Object.keys(files).length ? { files } : {}),
    });
    return next;
  }
  if (!prev) return null;
  const md = applyEdits(prev.skillMd, p.edits, true); // each target must match exactly once
  if (md === null || !frontmatter(p.name).test(md)) return null; // frontmatter intact
  const note = `- iter ${iteration}: patched${p.rationale ? ` — ${p.rationale.replace(/\s+/g, ' ')}` : ''}`;
  const files = { ...(prev.files ?? {}), ...toRecord(p.resources) };
  next.set(p.name, {
    skillMd: md,
    purposeMd: `${prev.purposeMd.trimEnd()}\n${note}\n`,
    ...(Object.keys(files).length ? { files } : {}),
  });
  return next;
}
