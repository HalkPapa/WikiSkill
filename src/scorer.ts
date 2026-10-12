import { spawn } from 'node:child_process';
import type { ScoreFn } from './infer.js';

/**
 * Grades answers with an external command, so benchmark-specific graders (spreadsheet diffs, simulators, …) can plug in.
 * The command (run through `sh -c`) gets one JSON object on stdin: {"id","input","expected","answer"} (answer may be
 * null). It must print `true`/`false`, `1`/`0`, or JSON such as {"correct": true}. Errors and timeouts count as wrong.
 * The command runs on your machine with your permissions.
 */
export function commandScorer(cmd: string, opts: { timeoutMs?: number; onError?: (msg: string) => void } = {}): ScoreFn {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  return (answer, task) =>
    new Promise<boolean>((resolve) => {
      const fail = (why: string) => {
        opts.onError?.(`scorer for ${task.id}: ${why}`);
        resolve(false);
      };
      const child = spawn('sh', ['-c', cmd], { stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('error', (e) => {
        clearTimeout(timer);
        fail(e.message);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) return fail(`exit ${code}: ${err.trim().slice(0, 200)}`);
        resolve(parseVerdict(out));
      });
      child.stdin.on('error', () => {}); // the command may exit without reading stdin
      child.stdin.end(JSON.stringify({ id: task.id, input: task.input, expected: task.expected, answer }));
    });
}

export function parseVerdict(out: string): boolean {
  const t = out.trim();
  if (/^(true|1)$/i.test(t)) return true;
  if (/^(false|0|)$/i.test(t)) return false;
  try {
    const v = JSON.parse(t);
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v >= 1;
    if (v && typeof v === 'object') return v.correct === true || (typeof v.score === 'number' && v.score >= 1);
  } catch {
    /* fall through */
  }
  return false;
}
