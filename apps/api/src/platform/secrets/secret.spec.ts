import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { Secret } from './secret';

describe('Secret', () => {
  const secret = new Secret('s3cr3t-value');

  it('reveals the underlying value only on explicit request', () => {
    expect(secret.reveal()).toBe('s3cr3t-value');
  });

  it('is redacted when stringified, serialised or inspected', () => {
    expect(String(secret)).toBe('[REDACTED]');
    // eslint-disable-next-line @typescript-eslint/restrict-template-expressions -- asserting template-literal behaviour
    expect(`${secret}`).toBe('[REDACTED]');
    expect(JSON.stringify({ secret })).toBe('{"secret":"[REDACTED]"}');
    expect(inspect(secret)).toBe('Secret([REDACTED])');
    expect(inspect({ nested: { secret } })).not.toContain('s3cr3t-value');
  });
});
