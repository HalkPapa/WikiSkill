export type Split = 'train' | 'val' | 'test';

export interface Task {
  id: string;
  input: string;
  expected: string;
  split?: Split;
  /**
   * Directory whose contents are copied into the agent's working directory before the run (input files for
   * spreadsheet or document tasks). `{workspace}` in `input` is replaced by that directory's absolute path.
   * In tasks.jsonl it is a path relative to the tasks file.
   */
  workspace?: string;
}

export interface SkillFiles {
  skillMd: string;
  purposeMd: string;
  /** Extra files bundled with the skill (scripts, references), keyed by path relative to the skill directory. */
  files?: Record<string, string>;
}
export type SkillSet = Map<string, SkillFiles>;

export interface Trace {
  iteration: number;
  taskId: string;
  input: string;
  expected: string;
  /** Full execution log: reasoning, tool calls and tool outputs when available, then the final reply. */
  output: string;
  answer: string | null;
  correct: boolean;
  /** SHA-256 of the system prompt the agent saw (see results/prompts/). */
  systemPromptSha256?: string;
  /** Resolved model id that produced the reply (e.g. claude-haiku-4-5-20251001), when known. */
  model?: string;
  /** Cost in USD of the agent call, as reported by the CLI (list price; not necessarily what is billed). */
  costUsd?: number;
  /** Set when the agent call itself failed (timeout, rate limit, crash): the verdict is not a real answer. */
  error?: string;
}

export type Role = 'infer' | 'wiki' | 'propose';

export interface LlmCall {
  role: Role;
  system?: string;
  prompt: string;
  /** Claude Code tool specs the call may use, e.g. "Read", "Bash(python3 *)" (empty = none). */
  tools?: string[];
  /** Working directory; tools can only see files under it. */
  cwd?: string;
  /** MCP server config file (benchmark environments such as a search API or a simulator exposed as tools). */
  mcpConfig?: string;
}
/** A reply is the final text, or the final text plus the full execution transcript. */
export type LlmReply = string | { text: string; transcript: string; /** Resolved model id reported by the CLI. */ model?: string; /** Cost in USD as reported by the CLI for this call. */ cost?: number };
export type Llm = (call: LlmCall) => Promise<LlmReply>;

export type Scorer = 'exact' | 'contains';
