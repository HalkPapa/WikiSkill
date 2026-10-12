import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { evolve, type EvolveOptions, type EvolveResult } from './evolve.js';
import { SCHEMA_VERSION, snakeKeys } from './handoff.js';
import { pairedBootstrap, type BootstrapResult } from './stats.js';

export interface ExperimentOptions extends EvolveOptions {
  /** Independent full evolution runs (the paper averages 3). With runs > 1 each run gets <outDir>/run-N/. */
  runs?: number;
}

export interface ExperimentResult {
  runs: EvolveResult[];
  meanBaselineVal: number;
  meanBestVal: number;
  test?: {
    meanBaselineAccuracy: number;
    meanEvolvedAccuracy: number;
    /** Per-task scores averaged over runs, then compared with a paired bootstrap (1,000 resamples). */
    bootstrap: BootstrapResult;
  };
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export async function runExperiment(o: ExperimentOptions): Promise<ExperimentResult> {
  const n = Math.max(1, o.runs ?? 1);
  const runs: EvolveResult[] = [];
  for (let r = 1; r <= n; r++) {
    o.log?.(n > 1 ? `=== run ${r}/${n} ===` : 'run');
    runs.push(await evolve({ ...o, runLabel: `run-${r}`, outDir: n > 1 ? join(o.outDir, `run-${r}`) : o.outDir }));
  }
  const result: ExperimentResult = {
    runs,
    meanBaselineVal: mean(runs.map((r) => r.baselineVal)),
    meanBestVal: mean(runs.map((r) => r.bestScore)),
  };
  const tests = runs.map((r) => r.test).filter((t): t is NonNullable<typeof t> => !!t);
  if (tests.length === runs.length && tests.length > 0) {
    const perTask = (pick: 'baseline' | 'evolved') => tests[0].ids.map((_, i) => mean(tests.map((t) => t[pick][i])));
    const evolved = perTask('evolved');
    const baseline = perTask('baseline');
    result.test = {
      meanBaselineAccuracy: mean(baseline),
      meanEvolvedAccuracy: mean(evolved),
      bootstrap: pairedBootstrap(evolved, baseline),
    };
  }
  if (n > 1) {
    await mkdir(o.outDir, { recursive: true });
    await writeFile(
      join(o.outDir, 'report.json'),
      JSON.stringify(
        {
          schema_version: SCHEMA_VERSION,
          runs: n,
          run_dirs: runs.map((_, i) => `run-${i + 1}`),
          ...(snakeKeys({ meanBaselineVal: result.meanBaselineVal, meanBestVal: result.meanBestVal, test: result.test }) as object),
        },
        null,
        2,
      ) + '\n',
    );
  }
  return result;
}
