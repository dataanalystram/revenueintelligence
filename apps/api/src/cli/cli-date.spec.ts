import { describe, expect, it } from 'vitest';
import { GovernanceError } from '../modules/governance';
import { cliDate } from './cli-date';

describe('cliDate (review n6)', () => {
  it('passes an absent flag through', () => {
    expect(cliDate(undefined, '--starts-at')).toBeUndefined();
  });

  it('reads a bare date as UTC midnight and honours an explicit zone', () => {
    expect(cliDate('2026-01-01', '--starts-at')!.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(cliDate('2026-01-01T10:00:00Z', '--starts-at')!.toISOString()).toBe(
      '2026-01-01T10:00:00.000Z',
    );
    expect(cliDate('2026-01-01T10:00+01:00', '--ends-at')!.toISOString()).toBe(
      '2026-01-01T09:00:00.000Z',
    );
  });

  it.each([
    '2026-01-01T10:00',
    '2026-01-01T10:00:00',
    '2026-01-01 10:00Z',
    '01/02/2026',
    'soon',
    '2026-13-01',
  ])('refuses %s as validation_failed', (value) => {
    let error: unknown;
    try {
      cliDate(value, '--ends-at');
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(GovernanceError);
    expect((error as GovernanceError).code).toBe('validation_failed');
    expect((error as GovernanceError).message).toContain('--ends-at');
  });
});
