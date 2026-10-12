import { cp, mkdir, readdir, readFile, rm, stat, writeFile, appendFile } from 'node:fs/promises';
import { dirname, join, normalize, sep } from 'node:path';
import type { SkillSet, Trace } from './types.js';

export class Store {
  constructor(readonly root: string) {}

  path(...p: string[]) {
    return join(this.root, ...p);
  }

  async init() {
    for (const d of ['raw', 'wiki/patterns', 'skills']) await mkdir(this.path(d), { recursive: true });
    for (const f of ['wiki/index.md', 'wiki/logs.md', 'wiki/skill-impact.md']) {
      await writeFile(this.path(f), '', { flag: 'a' });
    }
  }

  async writeTrace(t: Trace) {
    const dir = this.path('raw', `iter-${String(t.iteration).padStart(2, '0')}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${t.taskId.replace(/[^\w.-]/g, '_')}.json`), JSON.stringify(t, null, 2));
  }

  async readWiki(): Promise<Map<string, string>> {
    const dir = this.path('wiki', 'patterns');
    const pages = new Map<string, string>();
    for (const f of (await readdir(dir)).filter((f) => f.endsWith('.md')).sort())
      pages.set(`patterns/${f}`, await readFile(join(dir, f), 'utf8'));
    return pages;
  }

  /** Writes wiki/patterns/<name>; rejects names that are not a plain `*.md` file name. */
  async writePattern(name: string, content: string): Promise<boolean> {
    if (typeof name !== 'string' || !/^[\w][\w.-]*\.md$/.test(name)) return false;
    await mkdir(this.path('wiki', 'patterns'), { recursive: true });
    await writeFile(this.path('wiki', 'patterns', name), content.endsWith('\n') ? content : content + '\n');
    return true;
  }

  async writeIndex(content: string) {
    await writeFile(this.path('wiki', 'index.md'), content.endsWith('\n') ? content : content + '\n');
  }

  /** Fallback when the maintainer returns no index: one line per page, first `# Title` and `> summary`. */
  async rebuildIndex() {
    const lines = ['# Wiki index', ''];
    for (const [p, c] of await this.readWiki()) {
      const name = p.replace(/^patterns\//, '');
      const summary = c.match(/^>\s*(.+)$/m)?.[1] ?? c.match(/^#\s+(.+)$/m)?.[1] ?? '';
      lines.push(`- [${name.replace(/\.md$/, '')}](wiki/${p}): ${summary}`);
    }
    await this.writeIndex(lines.join('\n'));
  }

  readWikiFile(name: 'index.md' | 'logs.md' | 'skill-impact.md') {
    return readFile(this.path('wiki', name), 'utf8');
  }
  appendLog(text: string) {
    return appendFile(this.path('wiki', 'logs.md'), text.trim() + '\n\n');
  }
  appendImpact(text: string) {
    return appendFile(this.path('wiki', 'skill-impact.md'), text.trim() + '\n\n');
  }

  async writeSkills(skills: SkillSet) {
    await writeSkillDirs(skills, this.path('skills'));
  }

  async readSkills(): Promise<SkillSet> {
    const skills: SkillSet = new Map();
    const root = this.path('skills');
    for (const e of await readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (!e.isDirectory()) continue;
      const files = await readTree(join(root, e.name));
      const { 'SKILL.md': skillMd, 'PURPOSE.md': purposeMd, ...rest } = files;
      if (skillMd === undefined) continue;
      skills.set(e.name, { skillMd, purposeMd: purposeMd ?? '', ...(Object.keys(rest).length ? { files: rest } : {}) });
    }
    return skills;
  }

  /** Highest `raw/iter-NN` number present (0 if none), so a resumed run continues the numbering. */
  async lastIteration(): Promise<number> {
    const names = await readdir(this.path('raw')).catch(() => [] as string[]);
    return Math.max(0, ...names.map((n) => Number(n.match(/^iter-(\d+)$/)?.[1] ?? 0)));
  }

  /** True if a previous run left traces, wiki pages, skills or audit records here. */
  async hasData(): Promise<boolean> {
    const nonEmpty = async (p: string) => (await readdir(this.path(p)).catch(() => [])).length > 0;
    const sized = async (p: string) => (await stat(this.path(p)).catch(() => ({ size: 0 }))).size > 0;
    return (
      (await nonEmpty('raw')) ||
      (await nonEmpty('wiki/patterns')) ||
      (await nonEmpty('skills')) ||
      (await sized('wiki/skill-impact.md')) ||
      (await sized('wiki/logs.md'))
    );
  }

  /** Deletes raw/, wiki/ and skills/ (a fresh run starts with S0 = ∅ and an empty wiki). */
  async reset() {
    for (const d of ['raw', 'wiki', 'skills']) await rm(this.path(d), { recursive: true, force: true });
  }

  /** Copies a layer directory (e.g. 'wiki', 'raw', 'skills') into another workspace. */
  async copyInto(layer: 'wiki' | 'raw' | 'skills', destRoot: string) {
    await cp(this.path(layer), join(destRoot, layer), { recursive: true });
  }
}

async function readTree(dir: string, prefix = ''): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) Object.assign(out, await readTree(join(dir, e.name), rel));
    else if (e.isFile()) out[rel] = await readFile(join(dir, e.name), 'utf8');
  }
  return out;
}

/** Writes skills/<name>/{SKILL.md,PURPOSE.md,...bundled files} under `dir`, replacing what was there. */
export async function writeSkillDirs(skills: SkillSet, dir: string) {
  await rm(dir, { recursive: true, force: true });
  for (const [name, f] of skills) {
    await mkdir(join(dir, name), { recursive: true });
    await writeFile(join(dir, name, 'SKILL.md'), f.skillMd);
    await writeFile(join(dir, name, 'PURPOSE.md'), f.purposeMd);
    for (const [rel, content] of Object.entries(f.files ?? {})) {
      await mkdir(dirname(join(dir, name, rel)), { recursive: true });
      await writeFile(join(dir, name, rel), content);
    }
  }
}
