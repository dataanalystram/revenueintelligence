import { describe, expect, it } from 'vitest';
import { extensionNarrowings, type ExtensionEntryDraft } from '.';

const money = (constraints?: Record<string, unknown>): ExtensionEntryDraft => ({
  key: 'arr',
  status: 'active',
  sensitivity: 'confidential',
  categories: ['financial'],
  definition: {
    kind: 'field',
    key: 'arr',
    target: 'account',
    value_type: 'money',
    ...(constraints ? { constraints } : {}),
  },
});
const stored = (d: ExtensionEntryDraft) => ({
  key: d.key,
  definition: d.definition,
  sensitivity: d.sensitivity,
  categories: d.categories,
});

/**
 * M10D phase 3a-2 finding: fixing (or changing) a money field's currency is a
 * narrowing — stored values in another currency would no longer parse — so it
 * is probed at publish like the other X5 constraints (plan §2.5).
 */
describe('extensionNarrowings: fixed currency (R-X5)', () => {
  it('adding or changing a fixed currency is a narrowing; keeping or dropping it is not', () => {
    expect(extensionNarrowings([stored(money())], [money({ currency: 'EUR' })])).toEqual([
      { key: 'arr', check: 'currency', currency: 'EUR' },
    ]);
    expect(
      extensionNarrowings([stored(money({ currency: 'EUR' }))], [money({ currency: 'USD' })]),
    ).toEqual([{ key: 'arr', check: 'currency', currency: 'USD' }]);
    expect(
      extensionNarrowings([stored(money({ currency: 'EUR' }))], [money({ currency: 'EUR' })]),
    ).toEqual([]);
    expect(extensionNarrowings([stored(money({ currency: 'EUR' }))], [money()])).toEqual([]);
  });
});
