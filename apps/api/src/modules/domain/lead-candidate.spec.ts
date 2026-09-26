import { describe, expect, it } from 'vitest';
import { at, ids } from '../../../test/fixtures/domain';
import {
  attachSignal,
  discard,
  equivalenceKey,
  isCandidateActive,
  LeadCandidateSchema,
  markConverted,
  markNeedsReview,
  suppress,
  type LeadCandidateInput,
} from './lead-candidate';
import { ProductKeySchema } from './product';
import { DomainError } from './shared/errors';

const candidate = (over: Partial<LeadCandidateInput> = {}) =>
  LeadCandidateSchema.parse({
    id: ids.candidate,
    tenantId: ids.tenant,
    personId: ids.person,
    companyId: ids.company,
    productKey: 'marketplace',
    source: { origin: 'gainsight_px', channel: 'product_usage', label: 'High Marketplace usage' },
    signalIds: [ids.signal],
    status: 'open',
    correlationId: ids.correlation,
    createdAt: at(0),
    updatedAt: at(0),
    ...over,
  });

describe('LeadCandidate', () => {
  it('attaches new signals and ignores repeats', () => {
    const c = attachSignal(candidate(), ids.signal2, at(5));
    expect(c.signalIds).toEqual([ids.signal, ids.signal2]);
    expect(c.updatedAt).toEqual(at(5));
    expect(attachSignal(c, ids.signal2, at(9))).toBe(c);
  });

  it('moves through its lifecycle: open → needs_review → converted', () => {
    const review = markNeedsReview(candidate(), at(1));
    expect(review.status).toBe('needs_review');
    expect(isCandidateActive(review)).toBe(true);

    const converted = markConverted(review, ids.lead, at(2));
    expect(converted).toMatchObject({ status: 'converted', leadId: ids.lead });
    expect(isCandidateActive(converted)).toBe(false);
  });

  it('records why a candidate was suppressed', () => {
    const s = suppress(candidate(), 'duplicate_open_lead', at(1));
    expect(s).toMatchObject({ status: 'suppressed', suppressionReason: 'duplicate_open_lead' });
  });

  it('repeating the same final transition is idempotent', () => {
    const converted = markConverted(candidate(), ids.lead, at(1));
    expect(markConverted(converted, ids.lead, at(2))).toBe(converted);
    const suppressed = suppress(candidate(), 'not_a_buyer', at(1));
    expect(suppress(suppressed, 'not_a_buyer', at(2))).toBe(suppressed);
    const discarded = discard(candidate(), at(1));
    expect(discard(discarded, at(2))).toBe(discarded);
  });

  it.each([
    [
      'attach a signal to',
      (c: ReturnType<typeof candidate>) => attachSignal(c, ids.signal2, at(3)),
    ],
    [
      'convert to a different lead',
      (c: ReturnType<typeof candidate>) => markConverted(c, ids.lead2, at(3)),
    ],
    ['suppress', (c: ReturnType<typeof candidate>) => suppress(c, 'insufficient_signal', at(3))],
    ['review', (c: ReturnType<typeof candidate>) => markNeedsReview(c, at(3))],
    ['discard', (c: ReturnType<typeof candidate>) => discard(c, at(3))],
  ])('refuses to %s a closed candidate', (_label, action) => {
    const closed = markConverted(candidate(), ids.lead, at(1));
    expect(() => action(closed)).toThrow(DomainError);
  });

  it.each<[string, Partial<LeadCandidateInput>]>([
    ['no signals', { signalIds: [] }],
    ['duplicate signals', { signalIds: [ids.signal, ids.signal] }],
    ['converted without lead', { status: 'converted' }],
    ['lead id while open', { leadId: ids.lead }],
    ['suppressed without reason', { status: 'suppressed' }],
    ['reason while open', { suppressionReason: 'not_a_buyer' }],
  ])('rejects %s', (_label, over) => {
    expect(() => candidate(over)).toThrow();
  });

  it('builds equivalence keys that distinguish person, company and product', () => {
    const marketplace = ProductKeySchema.parse('marketplace');
    const portal = ProductKeySchema.parse('portal');
    const key = (over: object) =>
      equivalenceKey({
        tenantId: ids.tenant,
        personId: ids.person,
        companyId: ids.company,
        productKey: marketplace,
        ...over,
      });

    expect(key({})).toBe(key({}));
    expect(key({})).not.toBe(key({ productKey: portal }));
    expect(key({})).not.toBe(key({ personId: ids.otherPerson }));
    expect(key({})).not.toBe(key({ companyId: undefined }));
    expect(key({})).not.toBe(key({ tenantId: ids.otherTenant }));
    expect(key({ productKey: undefined })).toContain('|-');
  });
});
