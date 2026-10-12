import type { Llm, Trace } from './types.js';
import type { Store } from './store.js';
import { applyEdits, type EditOp } from './patch.js';
import { extractJson, replyText, truncate } from './util.js';

/** Wiki Maintainer system prompt, adapted from the paper's Appendix E.2 (file names match this repo: logs.md). */
const SYSTEM = `You are a Wiki Maintainer Agent for an LLM skill evolution system. Your job is to maintain a structured knowledge base (wiki) that documents patterns observed during agent execution -- both successes and failures. You must perform DEEP ANALYSIS of execution logs to identify root causes, not just surface-level symptoms.

## Wiki Structure
The wiki is organized as:
- wiki/index.md -- Concise catalog of known patterns (one line per pattern)
- wiki/logs.md -- Chronological evolution log (iterations, scores, accept/reject)
- wiki/skill-impact.md -- Record of which skills were tried and their outcomes (written by the harness, read-only for you)
- wiki/patterns/ -- One page per pattern with detailed evidence and analysis

## Your Input
1. Execution traces from the latest iteration -- full agent outputs with the task, the expected answer, and what the agent answered
2. The current wiki context (index, log, pattern pages)

## Your Output (Incremental Edit Mode)
Return a JSON object (and nothing else) with these keys:
- "create_patterns": list of {"name": "pattern-name.md", "content": "..."} -- new patterns (full content)
- "update_patterns": list of {"name": "existing-pattern.md", "edits": [...]} -- patch existing patterns
- "update_index": full updated content of index.md (always provide the complete index)
- "append_log": "brief summary of this iteration's findings and actions"
"update_index" and "append_log" are REQUIRED. Always provide them, even if there are no new patterns. For "update_index", always provide the complete updated index content including all existing entries plus any new ones.

### Patch Operations (for update_patterns only)
Each entry uses an "edits" list of patch operations:
- {"op": "append", "content": "text to add at end"}
- {"op": "replace", "target": "exact text to find", "content": "replacement text"}
- {"op": "insert_after", "target": "exact text to find", "content": "text to insert after"}
Rules: 1. "target" must be an EXACT substring of the existing content. 2. Use "append" to add new evidence, "replace" to fix or refine existing text. 3. Use "insert_after" to add entries after a specific line. 4. Keep each edit minimal. 5. For NEW patterns (create_patterns), use full "content".

## Analysis Guidelines
### Deep Trace Analysis (CRITICAL)
1. Read the agent's actual reasoning and answer -- what did it do?
2. Compare successful vs failed tasks -- what did successful tasks do differently?
3. Identify ACTION PATTERNS and strategies, not just error messages.
4. Check whether the agent followed any active skills, and whether the skill guidance was helpful or not.

### Pattern Documentation Rules
1. Each pattern page should document: what the pattern is (description); root cause analysis (WHY it happens, not just WHAT happens); exact evidence from the traces (task ids, what the agent did right/wrong); known solutions or workarounds (concrete action patterns).
2. Capture BOTH failure patterns (what went wrong and how to avoid it) and success patterns (strategies that consistently lead to task completion).
3. Do NOT create duplicate patterns -- update existing ones with new evidence.
4. Be concise. Pattern pages should be 10-30 lines, not essays.
5. Only create patterns for meaningful, generalizable observations.

### Index Description Quality (CRITICAL)
The index.md entries are the MOST IMPORTANT part of the wiki because they determine whether other agents will read the full pattern pages. Each index entry MUST follow this format:
- [pattern-name](wiki/patterns/pattern-name.md): PROBLEM + ROOT CAUSE + FIX in one or two sentences.
The description must be specific enough that an agent can judge relevance without reading the full page.`;

/** Paper (Appendix C): up to 8 traces per iteration, at most 5 failing and 3 passing, each log capped at 15,000 chars. */
export const MAX_FAIL = 5;
export const MAX_PASS = 3;
export const LOG_CHAR_CAP = 15_000;

const fmt = (t: Trace) =>
  truncate(
    `### ${t.taskId} — ${t.correct ? 'PASS' : 'FAIL'}\nTask: ${t.input}\nExpected: ${t.expected}\nAgent answer: ${t.answer ?? '(none)'}\nAgent output:\n${t.output}`,
    LOG_CHAR_CAP,
  );

export function sampleTraces(traces: Trace[], maxFail = MAX_FAIL, maxPass = MAX_PASS) {
  return [...traces.filter((t) => !t.correct).slice(0, maxFail), ...traces.filter((t) => t.correct).slice(0, maxPass)];
}

interface WikiReply {
  create_patterns?: { name: string; content: string }[];
  update_patterns?: { name: string; edits: EditOp[] }[];
  update_index?: string;
  append_log?: string;
}

/** Folds sampled traces into wiki/patterns. The wiki is never rolled back. */
export async function maintainWiki(llm: Llm, store: Store, traces: Trace[], iteration: number): Promise<string> {
  const sample = sampleTraces(traces);
  if (sample.length === 0) return 'no traces';
  const pages = await store.readWiki();
  const context = [
    `## wiki/index.md\n${(await store.readWikiFile('index.md')) || '(empty)'}`,
    `## wiki/logs.md (latest)\n${(await store.readWikiFile('logs.md')).slice(-4000) || '(empty)'}`,
    ...[...pages.entries()].map(([p, c]) => `## wiki/${p}\n${truncate(c, 6000)}`),
  ].join('\n\n');
  const reply = replyText(await llm({
    role: 'wiki',
    system: SYSTEM,
    prompt: `# Current wiki\n${context}\n\n# Execution traces (iteration ${iteration})\n${sample.map(fmt).join('\n\n')}`,
    tools: [],
  }));
  const parsed = extractJson<WikiReply>(reply);
  if (!parsed) {
    await store.appendLog(`## iter ${iteration}\nWiki maintainer returned unparseable output; wiki unchanged.`);
    return 'unparseable';
  }
  let created = 0;
  let updated = 0;
  let failed = 0;
  for (const p of parsed.create_patterns ?? []) {
    if (typeof p?.content === 'string' && (await store.writePattern(p.name, p.content))) created++;
    else failed++;
  }
  for (const u of parsed.update_patterns ?? []) {
    const current = typeof u?.name === 'string' ? pages.get(`patterns/${u.name}`) : undefined;
    const next = current === undefined ? null : applyEdits(current, u.edits, false);
    if (next !== null && (await store.writePattern(u.name, next))) updated++;
    else failed++;
  }
  if (typeof parsed.update_index === 'string' && parsed.update_index.trim()) await store.writeIndex(parsed.update_index);
  else await store.rebuildIndex();
  const summary = `${created} created, ${updated} updated${failed ? `, ${failed} invalid op(s) skipped` : ''}`;
  const note = (parsed.append_log ?? '').trim();
  await store.appendLog(/^#/.test(note) ? note : `## iter ${iteration}\n${note}`);
  return summary;
}
