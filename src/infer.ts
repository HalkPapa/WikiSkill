import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from './handoff.js';
import { writeSkillDirs } from './store.js';
import type { Llm, Scorer, SkillSet, Task, Trace } from './types.js';
import { replyText, replyTranscript } from './util.js';

export interface PromptOptions {
  taskDesc?: string;
  /** The agent has tools and a workspace: skills are available as files under skills/<name>/. */
  hasWorkspace?: boolean;
  /** Ablation: the agent may read the wiki under wiki/ (the paper's default is that it may not). */
  wikiAccess?: boolean;
  /** Prompt template with `{skill_section}` (and optionally `{task_desc}`), e.g. the paper's Appendix E.1 prompts. */
  template?: string;
}

/** Inference-agent system prompt, shaped like the paper's Appendix E.1 (`{skill_section}` + answer format). */
export function buildSystem(skills: SkillSet, o: PromptOptions | string = {}): string {
  const opts: PromptOptions = typeof o === 'string' ? { taskDesc: o } : o;
  const skillSection =
    skills.size === 0
      ? ''
      : '## Available Skills\n\nThese skills contain guidance learned from earlier attempts. Apply a skill whenever its conditions match.\n\n' +
        [...skills.entries()]
          .map(([name, f]) => {
            const extra = Object.keys(f.files ?? {});
            const where = opts.hasWorkspace && extra.length ? `\n\nBundled files (in skills/${name}/): ${extra.join(', ')}` : '';
            return `### Skill: ${name}\n\n${f.skillMd.trim()}${where}`;
          })
          .join('\n\n');
  const wiki = opts.wikiAccess
    ? '## Knowledge Base\n\nA wiki of patterns observed in earlier attempts is in wiki/ (start with wiki/index.md). Read the pages relevant to the task before answering.'
    : '';
  if (opts.template !== undefined) {
    const section = [skillSection, wiki].filter(Boolean).join('\n\n');
    return opts.template
      .replaceAll('{skill_section}', () => section)
      .replaceAll('{task_desc}', () => opts.taskDesc ?? 'the given tasks')
      .trim();
  }
  return [
    `You are an expert agent that solves ${opts.taskDesc ?? 'the given tasks'}.`,
    skillSection,
    wiki,
    '## Task\n\nYou will receive one task. Solve it carefully.',
    '## Answer Format\n\nThink step by step, then provide your final answer inside <answer>...</answer> tags. ' +
      'Inside the tags, output only the final answer (exact value only, no explanation).\n' +
      'Example: <answer>42</answer>',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function extractAnswer(output: string): string | null {
  const tagged = [...output.matchAll(/<answer>([\s\S]*?)<\/answer>/gi)].pop();
  if (tagged) return tagged[1].trim();
  const line = [...output.matchAll(/^\s*ANSWER:\s*(.*)$/gim)].pop();
  return line ? line[1].trim() : null;
}

/** The reply part of a stored execution log: everything after the last `[final] ` marker, else the whole text. */
export function finalPart(output: string): string {
  const marker = '[final] ';
  const i = output.lastIndexOf(`\n${marker}`);
  if (i >= 0) return output.slice(i + 1 + marker.length);
  return output.startsWith(marker) ? output.slice(marker.length) : output;
}

/**
 * The answer as extracted at run time, recomputed from a stored log: the final reply first, then the whole log;
 * in each, the last `<answer>…</answer>`, else the last line starting with `ANSWER:`. Logs without markers
 * (e.g. from an external AI) are treated as one final reply.
 */
export const answerFromOutput = (output: string): string | null => extractAnswer(finalPart(output)) ?? extractAnswer(output);

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.。]$/, '');

export function score(answer: string | null, expected: string, scorer: Scorer): boolean {
  if (answer === null) return false;
  return scorer === 'exact' ? norm(answer) === norm(expected) : norm(answer).includes(norm(expected));
}

/** Custom correctness check (e.g. a benchmark-specific grader). Overrides the built-in `scorer` when given. */
export type ScoreFn = (
  answer: string | null,
  task: Task,
  /** `output`: the agent's execution log. `workspace`: its working directory, still present while grading. */
  extra?: { output: string; workspace?: string },
) => boolean | Promise<boolean>;

export interface Rollout {
  skills: SkillSet;
  scorer: Scorer;
  scoreFn?: ScoreFn;
  iteration: number;
  taskDesc?: string;
  /** Environment tools for the agent, e.g. ["Read", "Bash(python3 *)"]. Default: none. */
  agentTools?: string[];
  /** Ablation: directory (a run's wiki/) copied into the agent's workspace and readable by it. */
  wikiDir?: string;
  /** Replaces the generic system prompt (see PromptOptions.template). */
  promptTemplate?: string;
  /** MCP config file for the agent's tools. */
  mcpConfig?: string;
  /** Called with the system prompt text and its SHA-256 for every rollout (to archive the exact prompts). */
  onPrompt?: (sha256: string, text: string) => void | Promise<void>;
}

/**
 * Runs one task with the skills injected into the system prompt. By default the agent has no tools and
 * cannot see the wiki. The workspace is a fresh temp dir holding the task's own files (`task.workspace`) and
 * skills/<name>/ (incl. bundled files); it is removed after grading.
 */
export async function runTask(llm: Llm, task: Task, r: Rollout): Promise<Trace> {
  const cwd = await mkdtemp(join(tmpdir(), 'wikiskill-infer-'));
  try {
    const tools = [...new Set([...(r.agentTools ?? []), ...(r.wikiDir ? ['Read'] : [])])];
    if (task.workspace) await cp(task.workspace, cwd, { recursive: true });
    if (tools.length > 0) await writeSkillDirs(r.skills, join(cwd, 'skills'));
    if (r.wikiDir) await cp(r.wikiDir, join(cwd, 'wiki'), { recursive: true });
    let text: string;
    let transcript: string;
    let model: string | undefined;
    const system = buildSystem(r.skills, { taskDesc: r.taskDesc, hasWorkspace: tools.length > 0, wikiAccess: !!r.wikiDir, template: r.promptTemplate });
    const promptSha = sha256(system);
    await r.onPrompt?.(promptSha, system);
    try {
      const reply = await llm({
        role: 'infer',
        system,
        prompt: task.input.replaceAll('{workspace}', cwd),
        tools,
        cwd,
        mcpConfig: r.mcpConfig,
      });
      text = replyText(reply);
      transcript = replyTranscript(reply);
      model = typeof reply === 'string' ? undefined : reply.model;
    } catch (e) {
      text = transcript = `[agent error] ${(e as Error).message}`;
    }
    const answer = extractAnswer(text) ?? extractAnswer(transcript);
    return {
      iteration: r.iteration,
      taskId: task.id,
      input: task.input,
      expected: task.expected,
      output: transcript,
      answer,
      correct: r.scoreFn ? await r.scoreFn(answer, task, { output: transcript, workspace: cwd }) : score(answer, task.expected, r.scorer),
      systemPromptSha256: promptSha,
      ...(model ? { model } : {}),
    };
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}
