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
export type LlmReply = string | { text: string; transcript: string };
export type Llm = (call: LlmCall) => Promise<LlmReply>;

export type Scorer = 'exact' | 'contains';
