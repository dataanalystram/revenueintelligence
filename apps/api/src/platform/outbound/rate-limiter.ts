/**
 * Sliding-window limiter: at most `limit` acquisitions per `windowMs` per key
 * (key = tenant). Keeps each tenant under the source API burst limit and stops one
 * tenant's traffic from delaying another's.
 *
 * In-process only: with several worker replicas each gets its own budget.
 * M6 runs one worker process per environment with bounded job concurrency; a
 * shared (Redis-backed) limiter is needed before scaling workers out
 * (technical-debt item 7).
 */
export class SlidingWindowRateLimiter {
  private readonly history = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs = 10_000,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
  ) {}

  /** Resolves when a request may be made for `key`, and records it. */
  async acquire(key: string): Promise<void> {
    for (;;) {
      const now = this.now();
      const recent = (this.history.get(key) ?? []).filter((t) => now - t < this.windowMs);
      if (recent.length < this.limit) {
        recent.push(now);
        this.history.set(key, recent);
        return;
      }
      this.history.set(key, recent);
      await this.sleep(this.windowMs - (now - recent[0]!) + 1);
    }
  }

  /** Requests currently counted in the window for `key` (for diagnostics and tests). */
  inWindow(key: string): number {
    const now = this.now();
    return (this.history.get(key) ?? []).filter((t) => now - t < this.windowMs).length;
  }
}
