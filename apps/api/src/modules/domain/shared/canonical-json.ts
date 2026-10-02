import { createHash } from 'node:crypto';

/**
 * Deterministic JSON: object keys sorted, `undefined` members dropped, dates as
 * ISO-8601 (UTC). Two equal values always serialise to the same string, so
 * their hash is stable across processes and runs.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalise(value));
}

/** SHA-256 (hex) of the canonical JSON of a value. */
export function canonicalHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function normalise(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalise);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const member = (value as Record<string, unknown>)[key];
      if (member !== undefined) out[key] = normalise(member);
    }
    return out;
  }
  return value;
}
