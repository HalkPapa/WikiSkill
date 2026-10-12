import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import type { Llm, Scorer, SkillSet, Task, Trace } from './types.js';
import { Store } from './store.js';
import { runTask, type ScoreFn } from './infer.js';
import { maintainWiki } from './wiki.js';
import { applyProposal, propose } from './propose.js';
import { pairedBootstrap, type BootstrapResult } from './stats.js';
import { SCHEMA_VERSION, predictionRow, sha256, skillsDigest, snakeKeys } from './handoff.js';
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
  /** Replaces the generic agent system prompt; must contain `{skill_section}` (e.g. benchmarks/prompts/*.txt). */
  agentPrompt?: string;
  /** MCP config file exposing the benchmark environment to the agent as tools. */
  agentMcpConfig?: string;
  /**
   * Ablation (paper §5.1, Table 3): with `false` the Skill Proposer has no wiki access and, as in the paper, the
   * Wiki Maintainer is removed too, so no knowledge accumulates across iterations. Default true.
   */
  proposerSeesWiki?: boolean;
  /** Ablation (paper §5.1): the inference agent may read the wiki during *training* rollouts. Default false. */
  inferenceSeesWiki?: boolean;
  /** Continue a previous run in outDir (load its skills, wiki and iteration numbering). */
  resume?: boolean;
  /** Delete a previous run in outDir and start from S0 = ∅ and an empty wiki. */
  force?: boolean;
  /** Label stored in every prediction row and the manifest (default "run-1"). */
  runLabel?: string;
  /** Free-form facts about the environment (tool version, models, task file hash, …) copied into manifest.json. */
  runInfo?: Record<string, unknown>;
  /** Name of the scorer written to prediction rows ("exact", "contains" or "custom"). */
  scorerLabel?: string;
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
  const run = o.runLabel ?? 'run-1';
  const scorerLabel = o.scorerLabel ?? (o.scoreFn ? 'custom' : o.scorer ?? 'exact');
  const startedAt = new Date().toISOString();
  if (await store.hasData()) {
    if (o.force) await store.reset();
    else if (!o.resume)
      throw new Error(`${o.outDir} already holds a run (raw/, wiki/ or skills/). Use --resume to continue it or --force to start over.`);
  }
  await store.init();
  const { train, val, test } = splitTasks(o.tasks, o.valRatio ?? 0.4, o.testRatio ?? 0);
  if (train.length === 0 || val.length === 0) throw new Error('need at least one train and one validation task');
  log(`train=${train.length} val=${val.length} test=${test.length}`);
  await store.writeJson('splits.json', {
    schema_version: SCHEMA_VERSION,
    train: train.map((t) => t.id),
    val: val.map((t) => t.id),
    test: test.map((t) => t.id),
  });

  const manifest = (status: 'running' | 'completed' | 'failed', skills: SkillSet, extra: object = {}) => ({
    schema_version: SCHEMA_VERSION,
    status,
    run,
    started_at: startedAt,
    ...(status === 'running' ? {} : { finished_at: new Date().toISOString() }),
    ...extra,
    environment: o.runInfo ?? {},
    options: {
      iterations: o.iterations,
      scorer: scorerLabel,
      val_ratio: o.valRatio ?? 0.4,
      test_ratio: o.testRatio ?? 0,
      train_sample: o.trainSample ?? null,
      concurrency: o.concurrency ?? 4,
      task_desc: o.taskDesc ?? null,
      agent_tools: o.agentTools ?? [],
      agent_prompt_sha256: o.agentPrompt === undefined ? null : sha256(o.agentPrompt),
      uses_mcp: o.agentMcpConfig !== undefined,
      proposer_sees_wiki: o.proposerSeesWiki ?? true,
      inference_sees_wiki: o.inferenceSeesWiki ?? false,
      wiki_maintainer_enabled: o.proposerSeesWiki ?? true,
      resume: !!o.resume,
    },
    split_sizes: { train: train.length, val: val.length, test: test.length },
    skills: { names: [...skills.keys()], ...skillsDigest(skills) },
    answer_format: 'The agent ends its reply with <answer>…</answer>; the text inside the tags is the answer.',
    guarantees: {
      test_split_used_during_evolution: false,
      wiki_hidden_from_task_agent: !o.inferenceSeesWiki,
    },
    files: {
      predictions: 'results/predictions.jsonl',
      prompts: 'results/prompts/<system_prompt_sha256>.txt',
      splits: 'splits.json',
      report: 'report.json',
      skills: 'skills/',
      traces: 'raw/',
      wiki: 'wiki/',
    },
  });
  await store.writeJson('manifest.json', manifest('running', new Map()));

  const seenPrompts = new Set<string>();
  const rollouts = async (
    tasks: Task[],
    skills: SkillSet,
    iteration: number,
    tag?: { split: 'val' | 'test'; condition: string },
    /** Training rollouts only: the wiki ablation gives the agent wiki access during these, not during evaluation. */
    wikiDir?: string,
  ): Promise<Trace[]> => {
    const traces = await mapLimit(tasks, o.concurrency ?? 4, (t) =>
      runTask(o.llm, t, {
        skills,
        scorer: o.scorer ?? 'exact',
        scoreFn: o.scoreFn,
        iteration,
        taskDesc: o.taskDesc,
        agentTools: o.agentTools,
        promptTemplate: o.agentPrompt,
        mcpConfig: o.agentMcpConfig,
        wikiDir,
        onPrompt: async (sha, text) => {
          if (seenPrompts.has(sha)) return;
          seenPrompts.add(sha);
          await store.writePrompt(sha, text);
        },
      }),
    );
    if (tag) await store.appendPredictions(traces.map((t) => predictionRow(t, { run, scorer: scorerLabel, ...tag })));
    return traces;
  };
  const validate = async (skills: SkillSet, iteration: number, condition: string) =>
    mean((await rollouts(val, skills, iteration, { split: 'val', condition })).map((t) => (t.correct ? 1 : 0)));

  try {
    let skills: SkillSet = o.resume ? await store.readSkills() : new Map();
    const offset = o.resume ? await store.lastIteration() : 0;
    if (o.resume) await store.dropPredictions((r) => r.split === 'test' || (r.split === 'val' && (r.condition === 'no-skills' || r.condition === 'resumed-skills')));
    const baselineVal = await validate(new Map(), 0, 'no-skills');
    let best = skills.size === 0 ? baselineVal : await validate(skills, offset, 'resumed-skills');
    log(`baseline val=${baselineVal.toFixed(3)}${skills.size ? `, resumed val=${best.toFixed(3)} (${skills.size} skill(s), after iter ${offset})` : ''}`);
    const history: EvolveResult['history'] = [];

    for (let k = offset + 1; k <= offset + o.iterations && best < 1; k++) {
      const batch = o.trainSample ? train.slice(0, o.trainSample) : train;
      const traces = await rollouts(batch, skills, k, undefined, o.inferenceSeesWiki ? store.path('wiki') : undefined);
      for (const t of traces) await store.writeTrace(t);
      log(`iter ${k}: train ${traces.filter((t) => t.correct).length}/${traces.length}`);

      if (o.proposerSeesWiki ?? true) log(`iter ${k}: wiki ${await maintainWiki(o.llm, store, traces, k)}`);
      else log(`iter ${k}: wiki maintainer removed (proposer-no-wiki ablation)`);

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
      const score = await validate(candidate, k, `candidate:${proposal.name}@iter${k}`);
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
      const base = (await rollouts(test, new Map(), 0, { split: 'test', condition: 'no-skills' })).map((t) => (t.correct ? 1 : 0));
      const evo = (await rollouts(test, skills, 0, { split: 'test', condition: 'evolved' })).map((t) => (t.correct ? 1 : 0));
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
    await store.writeJson('report.json', {
      schema_version: SCHEMA_VERSION,
      run,
      ...(snakeKeys({ baselineVal, bestVal: best, skills: [...skills.keys()], history, test: testResult }) as object),
    });
    await store.writeJson('manifest.json', manifest('completed', skills));
    return result;
  } catch (e) {
    await store.writeJson('manifest.json', manifest('failed', new Map(), { error: (e as Error).message }));
    throw e;
  }
}
