import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import type { Llm, LlmCall, LlmReply, Role } from './types.js';
import { UsageMeter, type CallUsage } from './usage.js';

export interface ClaudeCliOptions {
  model?: string;
  /** Records each call's cost and tokens, and stops the run when its cap is reached. */
  meter?: UsageMeter;
  bin?: string;
  timeoutMs?: number;
}

/** "Bash(python3 *)" → "Bash"; `--tools` takes tool names, `--allowedTools` takes the full specs. */
const toolName = (spec: string) => spec.replace(/\(.*$/, '');

/** Claude Code adds account context (e.g. the user's email) to every session; keep it out of stored traces. */
const redact = (s: string) => s.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]');

const clip = (s: string, n = 4000) => (s.length > n ? s.slice(0, n) + `…[+${s.length - n} chars]` : s);

/** Cost and token counts from a CLI result object (stream-json `result` event or the json output). */
export function usageOf(ev: any): CallUsage {
  const u = ev?.usage ?? {};
  return {
    costUsd: typeof ev?.total_cost_usd === 'number' ? ev.total_cost_usd : undefined,
    input: u.input_tokens,
    output: u.output_tokens,
    cacheCreation: u.cache_creation_input_tokens,
    cacheRead: u.cache_read_input_tokens,
  };
}

/** Renders `claude --output-format stream-json` events as a readable transcript and extracts the final text. */
export function parseStream(stdout: string): { text: string; transcript: string; model?: string; usage?: CallUsage } {
  const lines: string[] = [];
  let text = '';
  let model: string | undefined;
  let usage: CallUsage | undefined;
  for (const raw of stdout.split('\n')) {
    if (!raw.trim()) continue;
    let ev: any;
    try {
      ev = JSON.parse(raw);
    } catch {
      continue;
    }
    if (ev.type === 'system' && ev.subtype === 'init' && typeof ev.model === 'string') model = ev.model;
    else if (ev.type === 'assistant') {
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
    } else if (ev.type === 'result') {
      if (typeof ev.result === 'string') text = ev.result;
      usage = usageOf(ev);
    }
  }
  if (text.trim()) lines.push(`[final] ${text.trim()}`);
  return { text: text.trim(), transcript: redact(lines.join('\n')), ...(model ? { model } : {}), ...(usage ? { usage } : {}) };
}

/** Roles whose full execution log is recorded (reasoning + tool calls) instead of just the final reply. */
const STREAMED: Role[] = ['infer', 'propose'];

/** Runs each call as a one-shot `claude -p` subprocess (uses the existing Claude Code login). */
export function claudeCli(opts: ClaudeCliOptions = {}): Llm {
  const bin = opts.bin ?? 'claude';
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  return (call: LlmCall) =>
    new Promise<LlmReply>((resolve, reject) => {
      try {
        opts.meter?.assertWithin(); // a spending cap stops the run before the next paid call
      } catch (e) {
        return reject(e);
      }
      const tools = call.tools ?? [];
      const stream = STREAMED.includes(call.role);
      const args = [
        '-p',
        '--output-format', stream ? 'stream-json' : 'json',
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
        if (!stream) {
          // --output-format json: one result object (or, with some CLI versions, an array of events)
          let result: any;
          try {
            const j = JSON.parse(out);
            result = Array.isArray(j) ? j.find((e) => e?.type === 'result') : j;
          } catch {
            result = undefined;
          }
          if (!result || typeof result.result !== 'string') return reject(new Error(`unreadable claude output: ${out.trim().slice(0, 200)}`));
          const usage = usageOf(result);
          opts.meter?.add(call.role, usage);
          return resolve({ text: result.result.trim(), transcript: result.result.trim(), cost: usage.costUsd });
        }
        const parsed = parseStream(out);
        opts.meter?.add(call.role, parsed.usage ?? {});
        resolve({ text: parsed.text, transcript: parsed.transcript || parsed.text, model: parsed.model, cost: parsed.usage?.costUsd });
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
  const tmp = await mkdtemp(join(tmpdir(), 'wikiskill-mcp-'));
  const out = join(tmp, 'mcp.json');
  await writeFile(out, JSON.stringify(config, null, 2));
  process.on('exit', () => rmSync(tmp, { recursive: true, force: true })); // the expanded copy may hold env values
  return { path: out, source, sha256: createHash('sha256').update(text).digest('hex') };
}
