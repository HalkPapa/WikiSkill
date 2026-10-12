import { spawn } from 'node:child_process';
import type { ScoreFn } from './infer.js';

/**
 * Grades answers with an external command, so benchmark-specific graders (spreadsheet diffs, simulators, …) can plug in.
 * The command (run through `sh -c`, in the current directory) gets one JSON object on stdin:
 * {"id","input","expected","answer","output","workspace"} (answer may be null; output is the agent's full execution
 * log; workspace is the agent's working directory with the files it wrote, also exported as $WIKISKILL_WORKSPACE — null
 * when re-scoring stored predictions, where it no longer exists). It must print one of: `true`/`false`, `1`/`0`, or JSON
 * `{"correct": true|false}` / `{"score": <number>}` (score >= 1 is correct). Anything else, a non-zero exit, a missing
 * command or a timeout is reported through `onError` and the answer counts as wrong. The command runs on your machine
 * with your permissions.
 */
export function commandScorer(cmd: string, opts: { timeoutMs?: number; onError?: (msg: string) => void } = {}): ScoreFn {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  return (answer, task, extra) =>
    new Promise<boolean>((resolve) => {
      let settled = false;
      const fail = (why: string) => {
        if (settled) return;
        settled = true;
        opts.onError?.(`scorer for ${task.id}: ${why}`);
        resolve(false);
      };
      // Own process group, so a timeout also stops children of the shell (e.g. `sleep`), which would keep the pipes open.
      const child = spawn('sh', ['-c', cmd], {
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...(extra?.workspace ? { WIKISKILL_WORKSPACE: extra.workspace } : {}) },
      });
      let out = '';
      let err = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          process.kill(-child.pid!, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }, timeoutMs);
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('error', (e) => {
        clearTimeout(timer);
        fail(e.message);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) return fail(`timed out after ${timeoutMs / 1000} s`);
        if (code !== 0) return fail(`exit ${code}: ${err.trim().slice(0, 200)}`);
        const verdict = parseVerdict(out);
        if (verdict === null) return fail(`unrecognized grader output ${JSON.stringify(out.trim().slice(0, 60))}`);
        if (!settled) {
          settled = true;
          resolve(verdict);
        }
      });
      child.stdin.on('error', () => {}); // the command may exit without reading stdin
      child.stdin.end(JSON.stringify({ id: task.id, input: task.input, expected: task.expected, answer, output: extra?.output ?? null, workspace: extra?.workspace ?? null }));
    });
}

/** true / false for the documented formats; null if the output is not one of them. */
export function parseVerdict(out: string): boolean | null {
  const t = out.trim();
  if (/^(true|1)$/i.test(t)) return true;
  if (/^(false|0)$/i.test(t)) return false;
  try {
    const v = JSON.parse(t);
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if (typeof v.correct === 'boolean') return v.correct;
      if (typeof v.score === 'number') return v.score >= 1;
    }
  } catch {
    /* not JSON */
  }
  return null;
}
