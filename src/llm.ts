import { spawn } from 'node:child_process';
import type { Llm, LlmCall, LlmReply, Role } from './types.js';

export interface ClaudeCliOptions {
  model?: string;
  bin?: string;
  timeoutMs?: number;
}

/** "Bash(python3 *)" → "Bash"; `--tools` takes tool names, `--allowedTools` takes the full specs. */
const toolName = (spec: string) => spec.replace(/\(.*$/, '');

/** Claude Code adds account context (e.g. the user's email) to every session; keep it out of stored traces. */
const redact = (s: string) => s.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]');

const clip = (s: string, n = 4000) => (s.length > n ? s.slice(0, n) + `…[+${s.length - n} chars]` : s);

/** Renders `claude --output-format stream-json` events as a readable transcript and extracts the final text. */
export function parseStream(stdout: string): { text: string; transcript: string } {
  const lines: string[] = [];
  let text = '';
  for (const raw of stdout.split('\n')) {
    if (!raw.trim()) continue;
    let ev: any;
    try {
      ev = JSON.parse(raw);
    } catch {
      continue;
    }
    if (ev.type === 'assistant') {
      for (const b of ev.message?.content ?? []) {
        if (b.type === 'thinking' && b.thinking) lines.push(`[thinking] ${clip(b.thinking)}`);
        else if (b.type === 'text' && b.text) lines.push(`[assistant] ${b.text}`);
        else if (b.type === 'tool_use') lines.push(`[tool_use] ${b.name} ${clip(JSON.stringify(b.input), 1000)}`);
      }
    } else if (ev.type === 'user') {
      for (const b of ev.message?.content ?? []) {
        if (b.type === 'tool_result') {
          const c = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
          lines.push(`[tool_result] ${clip(c)}`);
        }
      }
    } else if (ev.type === 'result' && typeof ev.result === 'string') text = ev.result;
  }
  if (text.trim()) lines.push(`[final] ${text.trim()}`);
  return { text: text.trim(), transcript: redact(lines.join('\n')) };
}

/** Roles whose full execution log is recorded (reasoning + tool calls) instead of just the final reply. */
const STREAMED: Role[] = ['infer', 'propose'];

/** Runs each call as a one-shot `claude -p` subprocess (uses the existing Claude Code login). */
export function claudeCli(opts: ClaudeCliOptions = {}): Llm {
  const bin = opts.bin ?? 'claude';
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  return (call: LlmCall) =>
    new Promise<LlmReply>((resolve, reject) => {
      const tools = call.tools ?? [];
      const stream = STREAMED.includes(call.role);
      const args = [
        '-p',
        '--output-format', stream ? 'stream-json' : 'text',
        ...(stream ? ['--verbose'] : []),
        '--no-session-persistence',
        '--disable-slash-commands',
        '--strict-mcp-config', // only the MCP servers given by --mcp-config, never the user's own
        '--setting-sources', 'project',
        // `--tools` lists built-in tools only; MCP tools are enabled through --allowedTools (and --mcp-config).
        '--tools', [...new Set(tools.map(toolName).filter((n) => !n.startsWith('mcp__')))].join(','),
      ];
      if (call.mcpConfig) args.push('--mcp-config', call.mcpConfig);
      if (tools.length > 0) args.push('--allowedTools', ...tools);
      if (call.system) args.push('--system-prompt', call.system);
      if (opts.model) args.push('--model', opts.model);

      const child = spawn(bin, args, { cwd: call.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) return reject(new Error(`claude exited with ${code}: ${err.trim().slice(0, 500)}`));
        if (!stream) return resolve(out.trim());
        const parsed = parseStream(out);
        resolve({ text: parsed.text, transcript: parsed.transcript || parsed.text });
      });
      child.stdin.end(call.prompt);
    });
}

export interface OpenAiCompatibleOptions {
  baseUrl: string; // e.g. http://localhost:8000/v1 (vLLM)
  model: string;
  apiKey?: string;
  temperature?: number;
  timeoutMs?: number;
}

/** Text-only chat backend for OpenAI-compatible servers such as vLLM (used for open-weight inference models). */
export function openAiCompatible(o: OpenAiCompatibleOptions): Llm {
  return async (call: LlmCall) => {
    if ((call.tools ?? []).length > 0) throw new Error('the OpenAI-compatible backend does not support tools');
    const messages = [...(call.system ? [{ role: 'system', content: call.system }] : []), { role: 'user', content: call.prompt }];
    const res = await fetch(`${o.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(o.apiKey ? { authorization: `Bearer ${o.apiKey}` } : {}) },
      body: JSON.stringify({ model: o.model, messages, temperature: o.temperature ?? 0 }),
      signal: AbortSignal.timeout(o.timeoutMs ?? 10 * 60_000),
    });
    if (!res.ok) throw new Error(`chat/completions ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return (body.choices?.[0]?.message?.content ?? '').trim();
  };
}

/** Uses `inference` for the task-solving agent and `meta` (needs tools) for the wiki maintainer and skill proposer. */
export function routeLlm(inference: Llm, meta: Llm): Llm {
  return (call) => (call.role === 'infer' ? inference(call) : meta(call));
}

/**
 * The agent runs in a throw-away working directory, so MCP config paths must not be relative to it. Returns a copy
 * of the config in which `{configdir}` (the directory holding the original file) is expanded in every server's
 * command, args, env values and url, plus the original file's absolute path and SHA-256.
 */
export async function resolveMcpConfig(file: string): Promise<{ path: string; source: string; sha256: string }> {
  const { mkdtemp, readFile, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { dirname, join, resolve } = await import('node:path');
  const { createHash } = await import('node:crypto');
  const source = resolve(file);
  const text = await readFile(source, 'utf8');
  const dir = dirname(source);
  const expand = (v: unknown): unknown =>
    typeof v === 'string' ? v.replaceAll('{configdir}', dir) : Array.isArray(v) ? v.map(expand) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expand(x)])) : v;
  const config = expand(JSON.parse(text));
  const out = join(await mkdtemp(join(tmpdir(), 'wikiskill-mcp-')), 'mcp.json');
  await writeFile(out, JSON.stringify(config, null, 2));
  return { path: out, source, sha256: createHash('sha256').update(text).digest('hex') };
}
