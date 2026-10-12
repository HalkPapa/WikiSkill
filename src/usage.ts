/** Spending meter for the claude CLI calls: totals, per role, and an optional hard cap. */
export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BudgetExceededError';
  }
}

export interface Usage {
  calls: number;
  usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
}

const empty = (): Usage => ({ calls: 0, usd: 0, input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0 });

export interface CallUsage {
  costUsd?: number;
  input?: number;
  output?: number;
  cacheCreation?: number;
  cacheRead?: number;
}

/**
 * Accumulates what each call reported. `maxUsd` stops the run before the next call once the total reaches it; calls
 * already in flight (up to --concurrency of them) still finish, so the final total can exceed the cap slightly.
 * Costs are the CLI's own figures (list prices); they are not necessarily what a subscription plan bills.
 */
export class UsageMeter {
  readonly total: Usage = empty();
  readonly byRole: Record<string, Usage> = {};
  constructor(readonly maxUsd?: number) {}

  assertWithin() {
    if (this.maxUsd !== undefined && this.total.usd >= this.maxUsd)
      throw new BudgetExceededError(
        `spending cap of $${this.maxUsd.toFixed(2)} reached ($${this.total.usd.toFixed(2)} after ${this.total.calls} calls); ` +
          `continue with --resume and a higher --max-cost`,
      );
  }

  add(role: string, u: CallUsage) {
    for (const t of [this.total, (this.byRole[role] ??= empty())]) {
      t.calls += 1;
      t.usd += u.costUsd ?? 0;
      t.input_tokens += u.input ?? 0;
      t.output_tokens += u.output ?? 0;
      t.cache_creation_tokens += u.cacheCreation ?? 0;
      t.cache_read_tokens += u.cacheRead ?? 0;
    }
  }

  snapshot() {
    const round = (u: Usage) => ({ ...u, usd: Math.round(u.usd * 10000) / 10000 });
    return { ...round(this.total), max_usd: this.maxUsd ?? null, by_role: Object.fromEntries(Object.entries(this.byRole).map(([k, v]) => [k, round(v)])) };
  }
}
