import type { Split, Task } from './types.js';

export interface MakeTasksOptions {
  /** Records of the source dataset (parsed JSON objects). */
  records: Record<string, unknown>[];
  /** Field holding the task id (default "id"). Ids are made unique-checked, not rewritten. */
  idField?: string;
  /** Template for the agent's input; `{field}` or `{a.b}` is replaced by the record's value (arrays: one item per line). */
  inputTemplate: string;
  /** Field (or template) holding the expected answer. */
  expected: string;
  /** Where the split comes from: exactly one of the following. */
  splitField?: string;
  splits?: { train?: string[]; val?: string[]; test?: string[] };
  /** Not faithful to the paper: a seeded random split with these sizes. */
  random?: { train: number; val: number; test: number; seed: number };
}

const get = (obj: unknown, path: string): unknown => path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
const show = (v: unknown): string => (Array.isArray(v) ? v.map(show).join('\n') : v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** Replaces {a.b} placeholders; a placeholder naming a missing field is an error (a silent blank would corrupt the task). */
export function fill(template: string, record: unknown, where: string): string {
  return template.replace(/\{([\w.]+)\}/g, (_, path: string) => {
    const v = get(record, path);
    if (v === undefined || v === null) throw new Error(`${where}: field "${path}" is missing`);
    return show(v);
  });
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeTasks(o: MakeTasksOptions): { tasks: Task[]; counts: Record<Split, number>; warnings: string[] } {
  const idField = o.idField ?? 'id';
  const modes = [o.splitField !== undefined, o.splits !== undefined, o.random !== undefined].filter(Boolean).length;
  if (modes !== 1) throw new Error('give exactly one way to split: --split-field, --splits or --random-split');
  const warnings: string[] = [];
  const ids = o.records.map((r, i) => {
    const id = get(r, idField);
    if (id === undefined || id === null || String(id) === '') throw new Error(`record ${i + 1}: no "${idField}" field`);
    return String(id);
  });
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup !== undefined) throw new Error(`duplicate task id "${dup}"`);

  let splitOf: (id: string, i: number) => Split | undefined;
  if (o.splitField !== undefined) {
    splitOf = (_id, i) => {
      const v = String(get(o.records[i], o.splitField!));
      if (!['train', 'val', 'test'].includes(v)) throw new Error(`record ${i + 1}: ${o.splitField} must be train, val or test (got "${v}")`);
      return v as Split;
    };
  } else if (o.splits) {
    const map = new Map<string, Split>();
    for (const sp of ['train', 'val', 'test'] as const)
      for (const id of o.splits[sp] ?? []) {
        if (map.has(String(id))) throw new Error(`task "${id}" is in two splits of the splits file`);
        map.set(String(id), sp);
      }
    const unknown = [...map.keys()].filter((id) => !ids.includes(id));
    if (unknown.length) throw new Error(`the splits file lists ids that the dataset does not have: ${unknown.slice(0, 5).join(', ')}`);
    splitOf = (id) => map.get(id); // tasks outside the listed splits are left out
  } else {
    const r = o.random!;
    if (r.train + r.val + r.test > ids.length) throw new Error(`asked for ${r.train + r.val + r.test} tasks but the dataset has ${ids.length}`);
    warnings.push('random split: this is NOT the split used in the paper, so results cannot be called a reproduction');
    const order = ids.map((_, i) => i);
    const rng = mulberry32(r.seed);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    const assigned = new Map<number, Split>();
    order.slice(0, r.train).forEach((i) => assigned.set(i, 'train'));
    order.slice(r.train, r.train + r.val).forEach((i) => assigned.set(i, 'val'));
    order.slice(r.train + r.val, r.train + r.val + r.test).forEach((i) => assigned.set(i, 'test'));
    splitOf = (_id, i) => assigned.get(i);
  }

  const counts: Record<Split, number> = { train: 0, val: 0, test: 0 };
  const tasks: Task[] = [];
  o.records.forEach((rec, i) => {
    const split = splitOf(ids[i], i);
    if (!split) return;
    const where = `record ${i + 1} (${ids[i]})`;
    const expected = o.expected.includes('{') ? fill(o.expected, rec, where) : show(get(rec, o.expected));
    if (expected === '') throw new Error(`${where}: no expected answer in "${o.expected}"`);
    tasks.push({ id: ids[i], input: fill(o.inputTemplate, rec, where), expected, split });
    counts[split]++;
  });
  return { tasks, counts, warnings };
}
