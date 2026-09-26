/** Exponential backoff with full jitter, capped. `attempt` starts at 1. */
export function backoffDelayMs(attempt: number, random: () => number = Math.random): number {
  const base = 500;
  const cap = 30_000;
  const exponential = Math.min(cap, base * 2 ** (attempt - 1));
  return Math.round(exponential / 2 + random() * (exponential / 2));
}

/**
 * Parses a Retry-After header: delta-seconds or an HTTP date. Returns
 * undefined when absent or unparseable; the result is capped at 60 s.
 */
export function parseRetryAfterMs(
  header: string | null,
  now: () => number = Date.now,
): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  let ms: number | undefined;
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    ms = Math.round(Number(trimmed) * 1000);
  } else {
    const at = Date.parse(trimmed);
    if (!Number.isNaN(at)) ms = Math.max(0, at - now());
  }
  return ms === undefined ? undefined : Math.min(ms, 60_000);
}
