import { describe, expect, it } from 'vitest';
import { MappingDraftValidationStampSchema } from './source-mapping-profiles';

describe('MappingDraftValidationStampSchema (M10A2 review m8)', () => {
  const ack = { findingId: '00000000-0000-4000-8000-000000000001', reasonCode: 'not_applicable' };

  it('accepts the stamp validateDraft writes', () => {
    expect(
      MappingDraftValidationStampSchema.safeParse({
        contentHash: 'abc',
        warnings: { w: 2 },
        acknowledgements: [],
      }).success,
    ).toBe(true);
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['a missing content hash', { warnings: {} }],
    ['an empty content hash', { contentHash: '' }],
    ['a non-string content hash', { contentHash: 42 }],
    ['malformed acknowledgements', { contentHash: 'abc', acknowledgements: [{ findingId: 'x' }] }],
    ['acknowledgements that are not a list', { contentHash: 'abc', acknowledgements: ack }],
  ])('fails closed on %s', (_, stamp) => {
    expect(MappingDraftValidationStampSchema.safeParse(stamp).success).toBe(false);
  });
});
