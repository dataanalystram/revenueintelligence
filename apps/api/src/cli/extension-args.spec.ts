import { describe, expect, it } from 'vitest';
import { EXTENSION_CLI_COMMANDS, limitOf, parseAssignments } from './extension-args';

describe('extension CLI arguments (M10D plan §8)', () => {
  it('lists every operator command of the plan', () => {
    expect(EXTENSION_CLI_COMMANDS).toEqual([
      'registry show',
      'values show',
      'value set',
      'value clear',
      'value release',
      'records list',
      'records show',
      'record create',
      'record update',
      'record retire',
      'record reactivate',
      'relationship add',
      'relationship end',
    ]);
  });

  it('parses --set field=value (the value may contain =) and --clear field', () => {
    expect(parseAssignments(['tier=gold', 'note=a=b'], ['old'])).toEqual({
      tier: 'gold',
      note: 'a=b',
      old: null,
    });
    expect(parseAssignments(undefined)).toEqual({});
  });

  it('refuses a malformed or repeated field (no silent last-wins)', () => {
    expect(() => parseAssignments(['tier'])).toThrow(/field>=<value/);
    expect(() => parseAssignments(['=x'])).toThrow();
    expect(() => parseAssignments(['Tier=x'])).toThrow(/invalid or repeated/);
    expect(() => parseAssignments(['tier=a', 'tier=b'])).toThrow(/invalid or repeated/);
    expect(() => parseAssignments(['tier=a'], ['tier'])).toThrow(/invalid or repeated/);
  });

  it('--limit is a positive integer', () => {
    expect(limitOf(undefined)).toBeUndefined();
    expect(limitOf('25')).toBe(25);
    expect(() => limitOf('0')).toThrow();
    expect(() => limitOf('2.5')).toThrow();
  });
});
