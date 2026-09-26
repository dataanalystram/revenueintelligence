import { describe, expect, it } from 'vitest';
import {
  ExternalRefListSchema,
  ExternalRefSchema,
  externalRefKey,
  findExternalRef,
  withExternalRef,
  type ExternalRef,
} from './external-ref';

const hsLead: ExternalRef = { system: 'hubspot', objectType: 'leads', id: '123' };
const sugarLead: ExternalRef = { system: 'sugar', objectType: 'Leads', id: 'abc-9876' };

describe('ExternalRef', () => {
  it('builds a stable key', () => {
    expect(externalRefKey(hsLead)).toBe('hubspot:leads:123');
  });

  it.each([
    { ...hsLead, system: 'salesforce' },
    { ...hsLead, id: '' },
    { ...hsLead, objectType: '  ' },
  ])('rejects invalid refs %j', (ref) => {
    expect(ExternalRefSchema.safeParse(ref).success).toBe(false);
  });

  it('lists reject exact duplicates but allow several systems', () => {
    expect(ExternalRefListSchema.safeParse([hsLead, sugarLead]).success).toBe(true);
    expect(ExternalRefListSchema.safeParse([hsLead, { ...hsLead }]).success).toBe(false);
  });

  it('withExternalRef is idempotent and returns the same list when nothing changes', () => {
    const once = withExternalRef([hsLead], sugarLead);
    expect(once).toEqual([hsLead, sugarLead]);
    expect(withExternalRef(once, { ...sugarLead })).toBe(once);
  });

  it('finds a reference by system and object type', () => {
    expect(findExternalRef([hsLead, sugarLead], 'sugar', 'Leads')).toBe(sugarLead);
    expect(findExternalRef([hsLead], 'sugar', 'Leads')).toBeUndefined();
  });
});
