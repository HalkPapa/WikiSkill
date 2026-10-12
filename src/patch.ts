/** Patch operations shared by the Wiki Maintainer and the Skill Proposer (paper, Appendix E.2 / E.3). */
export type EditOp =
  | { op: 'append'; content: string }
  | { op: 'replace'; target: string; content: string }
  | { op: 'insert_after'; target: string; content: string };

/**
 * Applies the edits in order. `target` must be an exact substring; with `strict` it must also occur
 * exactly once. Returns null if any edit is malformed or does not apply.
 */
export function applyEdits(text: string, edits: EditOp[], strict = true): string | null {
  if (!Array.isArray(edits) || edits.length === 0) return null;
  let out = text;
  for (const e of edits) {
    if (!e || typeof e.content !== 'string') return null;
    if (e.op === 'append') {
      out = (out.endsWith('\n') || out === '' ? out : out + '\n') + e.content;
      continue;
    }
    if ((e.op !== 'replace' && e.op !== 'insert_after') || typeof e.target !== 'string' || !e.target) return null;
    const occurrences = out.split(e.target).length - 1;
    if (occurrences === 0 || (strict && occurrences > 1)) return null;
    const i = out.indexOf(e.target);
    const end = i + e.target.length;
    if (e.op === 'replace') out = out.slice(0, i) + e.content + out.slice(end);
    else {
      const sep = e.content.startsWith('\n') || e.target.endsWith('\n') ? '' : '\n';
      out = out.slice(0, end) + sep + e.content + out.slice(end);
    }
  }
  return out;
}
