/** Deterministic PRNG so bootstrap results are reproducible. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface BootstrapResult {
  meanA: number;
  meanB: number;
  meanDiff: number;
  /** One-sided p-value for "A is better than B": share of bootstrap samples where mean(A-B) <= 0. */
  p: number;
  significant: boolean;
}

/**
 * Paired bootstrap as in the paper (Appendix C): resample task instances with replacement `iterations` times
 * (default 1,000) and compare the two methods' per-task scores on the same resample. Significant if p < 0.05.
 */
export function pairedBootstrap(a: number[], b: number[], iterations = 1000, seed = 1): BootstrapResult {
  if (a.length !== b.length || a.length === 0) throw new Error('paired scores must have equal, non-zero length');
  const n = a.length;
  const diff = a.map((x, i) => x - b[i]);
  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const rng = mulberry32(seed);
  let notBetter = 0;
  for (let it = 0; it < iterations; it++) {
    let sum = 0;
    for (let j = 0; j < n; j++) sum += diff[Math.floor(rng() * n)];
    if (sum / n <= 0) notBetter++;
  }
  const p = notBetter / iterations;
  return { meanA: mean(a), meanB: mean(b), meanDiff: mean(diff), p, significant: p < 0.05 };
}
