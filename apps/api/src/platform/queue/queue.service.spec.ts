import { describe, expect, it } from 'vitest';
import { BACKOFF_BASE_MS, BACKOFF_CAP_MS, retryDelayMs } from './queue.service';

describe('retryDelayMs (ADR 0013)', () => {
  const mid = () => 0.5; // no jitter

  it('grows exponentially from 5 s and caps at 10 min', () => {
    expect(retryDelayMs(1, undefined, mid)).toBe(BACKOFF_BASE_MS);
    expect(retryDelayMs(2, undefined, mid)).toBe(10_000);
    expect(retryDelayMs(3, undefined, mid)).toBe(20_000);
    expect(retryDelayMs(7, undefined, mid)).toBe(320_000);
    expect(retryDelayMs(8, undefined, mid)).toBe(BACKOFF_CAP_MS);
    expect(retryDelayMs(30, undefined, mid)).toBe(BACKOFF_CAP_MS);
  });

  it('applies ±20 % jitter', () => {
    expect(retryDelayMs(2, undefined, () => 0)).toBe(8_000);
    expect(retryDelayMs(2, undefined, () => 1)).toBe(12_000);
  });

  it('never retries sooner than a Retry-After hint', () => {
    expect(retryDelayMs(1, { retryAfterMs: 42_000 }, mid)).toBe(42_000);
    expect(retryDelayMs(3, { retryAfterMs: 1_000 }, mid)).toBe(20_000);
  });
});
