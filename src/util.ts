import type { LlmReply } from './types.js';

export const replyText = (r: LlmReply): string => (typeof r === 'string' ? r : r.text);
export const replyTranscript = (r: LlmReply): string => (typeof r === 'string' ? r : r.transcript);

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Pulls the JSON object out of an LLM reply (fenced block or outermost braces). */
export function extractJson<T>(text: string): T | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fenced?.[1], text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)];
  for (const c of candidates) {
    if (!c) continue;
    try {
      return JSON.parse(c) as T;
    } catch {
      /* try next */
    }
  }
  return null;
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + `\n…[truncated ${s.length - max} chars]`;
}

/** Line diff showing changed lines with 2 lines of context. */
export function unifiedDiff(a: string, b: string, name: string): string {
  const x = a.split('\n');
  const y = b.split('\n');
  const lcs: number[][] = Array.from({ length: x.length + 1 }, () => new Array(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--)
    for (let j = y.length - 1; j >= 0; j--)
      lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const lines: { tag: ' ' | '-' | '+'; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) lines.push({ tag: ' ', text: x[i++] }), j++;
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) lines.push({ tag: '-', text: x[i++] });
    else lines.push({ tag: '+', text: y[j++] });
  }
  while (i < x.length) lines.push({ tag: '-', text: x[i++] });
  while (j < y.length) lines.push({ tag: '+', text: y[j++] });

  const keep = lines.map((l, k) => l.tag !== ' ' || lines.slice(Math.max(0, k - 2), k + 3).some((m) => m.tag !== ' '));
  const out = [`--- a/${name}`, `+++ b/${name}`];
  let gap = false;
  lines.forEach((l, k) => {
    if (keep[k]) {
      if (gap) out.push('@@ …');
      out.push(l.tag + l.text);
      gap = false;
    } else gap = true;
  });
  return out.join('\n');
}

/** Splits "Read,Bash(python3 *, -m x)" on commas outside parentheses. */
export const splitTools = (s: string) => s.split(/,(?![^()]*\))/).map((t) => t.trim()).filter(Boolean);
