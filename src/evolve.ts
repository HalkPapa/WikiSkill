import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import type { Llm, Scorer, SkillSet, Task, Trace } from './types.js';
import { Store } from './store.js';
import { runTask, type ScoreFn } from './infer.js';
import { maintainWiki } from './wiki.js';
import { applyProposal, propose } from './propose.js';
import { pairedBootstrap, type BootstrapResult } from './stats.js';
import { mapLimit, unifiedDiff } from './util.js';

export interface EvolveOptions {
  tasks: Task[];
  outDir: string;
  iterations: number;
  llm: Llm;
  scorer?: Scorer;
  /** Custom grader; overrides `scorer`. */
  scoreFn?: ScoreFn;
  concurrency?: number;
  /** Share of tasks without an explicit split that become validation / test tasks. */
  valRatio?: number;
  testRatio?: number;
  /** Max training tasks rolled out per iteration (default: all). */
  trainSample?: number;
  /** Phrase completing "an agent that solves …" in the agent prompts. */
  taskDesc?: string;
  /** Environment tools for the inference agent, e.g. ["Read", "Bash(python3 *)"]. Default: none. */
  agentTools?: string[];
  /** Ablation (paper §5.1): hide the wiki from the Skill Proposer. Default true = proposer sees it. */
  proposerSeesWiki?: boolean;
  /** Ablation (paper §5.1): let the inference agent read the wiki. Default false, as in the paper. */
  inferenceSeesWiki?: boolean;
  /** Continue a previous run in outDir (load its skills, wiki and iteration numbering). */
  resume?: boolean;
  /** Delete a previous run in outDir and start from S0 = ∅ and an empty wiki. */
  force?: boolean;
  log?: (msg: string) => void;
}

export interface TestResult {
  ids: string[];
  /** Per-task correctness (0/1) with no skills and with the evolved skills. */
  baseline: number[];
  evolved: number[];
  baselineAccuracy: number;
  evolvedAccuracy: number;
  /** Paired bootstrap, evolved vs. no skills. */
  bootstrap: BootstrapResult;
}

export interface EvolveResult {
  skills: SkillSet;
  baselineVal: number;
  bestScore: number;
  history: { iteration: number; outcome: 'accepted' | 'rejected' | 'invalid' | 'no-proposal'; valScore: number }[];
  test?: TestResult;
}

export function splitTasks(tasks: Task[], valRatio: number, testRatio = 0): { train: Task[]; val: Task[]; test: Task[] } {
  const hash = (t: Task) => createHash('sha1').update(t.id).digest('hex');
  const unassigned = tasks.filter((t) => !t.split).sort((a, b) => hash(a).localeCompare(hash(b)));
  const nTest = Math.round(unassigned.length * testRatio);
  const rest = unassigned.slice(nTest);
  const nVal = Math.min(Math.max(1, Math.round(rest.length * valRatio)), Math.max(0, rest.length - 1));
  const of = (s: string) => tasks.filter((t) => t.split === s);
  return {
    train: [...of('train'), ...rest.slice(nVal)],
    val: [...of('val'), ...rest.slice(0, nVal)],
    test: [...of('test'), ...unassigned.slice(0, nTest)],
  };
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export async function evolve(o: EvolveOptions): Promise<EvolveResult> {
  const log = o.log ?? (() => {});
  const store = new Store(o.outDir);
  if (await store.hasData()) {
    if (o.force) await store.reset();
    else if (!o.resume)
      throw new Error(`${o.outDir} already holds a run (raw/, wiki/ or skills/). Use --resume to continue it or --force to start over.`);
  }
  await store.init();
  const { train, val, test } = splitTasks(o.tasks, o.valRatio ?? 0.4, o.testRatio ?? 0);
  if (train.length === 0 || val.length === 0) throw new Error('need at least one train and one validation task');
  log(`train=${train.length} val=${val.length} test=${test.length}`);

  const rollouts = (tasks: Task[], skills: SkillSet, iteration: number): Promise<Trace[]> =>
    mapLimit(tasks, o.concurrency ?? 4, (t) =>
      runTask(o.llm, t, {
        skills,
        scorer: o.scorer ?? 'exact',
        scoreFn: o.scoreFn,
        iteration,
        taskDesc: o.taskDesc,
        agentTools: o.agentTools,
        wikiDir: o.inferenceSeesWiki ? store.path('wiki') : undefined,
      }),
    );
  const validate = async (skills: SkillSet, iteration: number) =>
    mean((await rollouts(val, skills, iteration)).map((t) => (t.correct ? 1 : 0)));

  let skills: SkillSet = o.resume ? await store.readSkills() : new Map();
  const offset = o.resume ? await store.lastIteration() : 0;
  const baselineVal = await validate(new Map(), 0);
  let best = skills.size === 0 ? baselineVal : await validate(skills, offset);
  log(`baseline val=${baselineVal.toFixed(3)}${skills.size ? `, resumed val=${best.toFixed(3)} (${skills.size} skill(s), after iter ${offset})` : ''}`);
  const history: EvolveResult['history'] = [];

  for (let k = offset + 1; k <= offset + o.iterations && best < 1; k++) {
    const batch = o.trainSample ? train.slice(0, o.trainSample) : train;
    const traces = await rollouts(batch, skills, k);
    for (const t of traces) await store.writeTrace(t);
    log(`iter ${k}: train ${traces.filter((t) => t.correct).length}/${traces.length}`);

    log(`iter ${k}: wiki ${await maintainWiki(o.llm, store, traces, k)}`);

    const proposal = await propose(o.llm, store, skills, traces, k, {
      taskDesc: o.taskDesc,
      useWiki: o.proposerSeesWiki ?? true,
      log: (m) => log(`iter ${k}: ${m}`),
    });
    if (!proposal || proposal.action === 'no_action') {
      history.push({ iteration: k, outcome: 'no-proposal', valScore: best });
      await store.appendImpact(`## iter ${k}\n${proposal ? 'Proposer chose no_action.' : 'No valid proposal (unparseable reply).'}`);
      log(`iter ${k}: ${proposal ? 'no_action' : 'no valid proposal'}`);
      continue;
    }
    const candidate = applyProposal(skills, proposal, k);
    const before = skills.get(proposal.name)?.skillMd ?? '';
    if (!candidate) {
      history.push({ iteration: k, outcome: 'invalid', valScore: best });
      await store.appendImpact(
        `## iter ${k} — Rejected (invalid edit)\nTarget: ${proposal.name} (${proposal.action})\n` +
          `\`\`\`json\n${JSON.stringify(proposal, null, 2)}\n\`\`\``,
      );
      log(`iter ${k}: invalid ${proposal.action} ${proposal.name}`);
      continue;
    }
    const diff = unifiedDiff(before, candidate.get(proposal.name)!.skillMd, `skills/${proposal.name}/SKILL.md`);
    const resources = (proposal.resources ?? []).map((r) => r.path);
    const score = await validate(candidate, k);
    const accepted = score > best; // strict improvement only
    await store.appendImpact(
      `## iter ${k} — ${accepted ? 'Accepted' : 'Rejected'}\nTarget: ${proposal.name} (${proposal.action})\n` +
        `Rationale: ${proposal.rationale ?? ''}\nValidation: ${score.toFixed(3)} (best before: ${best.toFixed(3)})\n` +
        (resources.length ? `Resources: ${resources.join(', ')}\n` : '') +
        `\n\`\`\`diff\n${diff}\n\`\`\``,
    );
    log(`iter ${k}: ${proposal.action} ${proposal.name} val=${score.toFixed(3)} → ${accepted ? 'accepted' : 'rejected'}`);
    history.push({ iteration: k, outcome: accepted ? 'accepted' : 'rejected', valScore: score });
    if (accepted) {
      skills = candidate;
      best = score;
      await store.writeSkills(skills);
    }
  }

  let testResult: TestResult | undefined;
  if (test.length > 0) {
    const base = (await rollouts(test, new Map(), 0)).map((t) => (t.correct ? 1 : 0));
    const evo = (await rollouts(test, skills, 0)).map((t) => (t.correct ? 1 : 0));
    testResult = {
      ids: test.map((t) => t.id),
      baseline: base,
      evolved: evo,
      baselineAccuracy: mean(base),
      evolvedAccuracy: mean(evo),
      bootstrap: pairedBootstrap(evo, base),
    };
    log(`test: no skills ${testResult.baselineAccuracy.toFixed(3)} → evolved ${testResult.evolvedAccuracy.toFixed(3)} (p=${testResult.bootstrap.p.toFixed(3)})`);
  }
  const result: EvolveResult = { skills, baselineVal, bestScore: best, history, test: testResult };
  await writeFile(
    store.path('report.json'),
    JSON.stringify({ baselineVal, bestVal: best, skills: [...skills.keys()], history, test: testResult }, null, 2),
  );
  return result;
}
