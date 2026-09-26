import { describe, expect, it } from 'vitest';
import { at, ids } from '../../../test/fixtures/domain';
import {
  CHANNELS_BY_ORIGIN,
  isIntelligenceSourced,
  LeadOriginSchema,
  SourceAttributionSchema,
} from './attribution';
import { signalDeduplicationKey, SignalSchema } from './signals';

describe('SourceAttribution', () => {
  it('accepts HubSpot marketing sources with campaign and form references', () => {
    const a = SourceAttributionSchema.parse({
      origin: 'hubspot',
      channel: 'demo_request',
      label: 'Demo request',
      campaign: { system: 'hubspot', objectType: 'campaigns', id: 'mis-sept' },
      form: { system: 'hubspot', objectType: 'forms', id: 'f-1' },
    });
    expect(isIntelligenceSourced(a)).toBe(false);
  });

  it('marks Gainsight origins as intelligence-sourced', () => {
    expect(
      isIntelligenceSourced(
        SourceAttributionSchema.parse({ origin: 'gainsight_px', channel: 'product_usage' }),
      ),
    ).toBe(true);
    expect(
      isIntelligenceSourced(
        SourceAttributionSchema.parse({ origin: 'gainsight_cs', channel: 'cs_expansion' }),
      ),
    ).toBe(true);
  });

  it.each([
    ['hubspot', 'product_usage'],
    ['gainsight_px', 'demo_request'],
    ['gainsight_cs', 'lead_score_threshold'],
    ['external_enrichment', 'form_submission'],
  ])('rejects origin %s with channel %s', (origin, channel) => {
    expect(SourceAttributionSchema.safeParse({ origin, channel }).success).toBe(false);
  });

  it('rejects campaign references on non-HubSpot origins', () => {
    expect(
      SourceAttributionSchema.safeParse({
        origin: 'gainsight_px',
        channel: 'product_usage',
        campaign: { system: 'hubspot', objectType: 'campaigns', id: 'x' },
      }).success,
    ).toBe(false);
  });

  it('defines channels for every origin', () => {
    for (const origin of LeadOriginSchema.options) {
      expect(CHANNELS_BY_ORIGIN[origin].length).toBeGreaterThan(0);
    }
  });
});

const base = {
  id: ids.signal,
  tenantId: ids.tenant,
  subject: { personId: ids.person },
  occurredAt: at(0),
  receivedAt: at(1),
  correlationId: ids.correlation,
};

describe('Signals', () => {
  it('parses a marketing signal from HubSpot', () => {
    const s = SignalSchema.parse({
      ...base,
      kind: 'marketing',
      source: { system: 'hubspot', eventId: 'evt-1' },
      channel: 'webinar_registration',
      label: 'MIS webinar September',
    });
    expect(s.kind).toBe('marketing');
    expect(signalDeduplicationKey(s)).toBe(`${ids.tenant}:hubspot:evt-1`);
  });

  it('requires a score for lead-score crossings, and the score must meet the threshold', () => {
    const scored = {
      ...base,
      kind: 'marketing',
      source: { system: 'hubspot', eventId: 'e' },
      channel: 'lead_score_threshold',
    };
    expect(SignalSchema.safeParse({ ...scored, score: { value: 70, threshold: 65 } }).success).toBe(
      true,
    );
    expect(SignalSchema.safeParse(scored).success).toBe(false);
    expect(SignalSchema.safeParse({ ...scored, score: { value: 60, threshold: 65 } }).success).toBe(
      false,
    );
    expect(
      SignalSchema.safeParse({
        ...scored,
        channel: 'demo_request',
        score: { value: 70, threshold: 65 },
      }).success,
    ).toBe(false);
  });

  it('parses a product-usage signal from Gainsight PX with metrics', () => {
    const s = SignalSchema.parse({
      ...base,
      kind: 'product',
      source: { system: 'gainsight_px', eventId: 'px-9' },
      activity: 'feature_usage',
      productKey: 'marketplace',
      metrics: { logins_30d: 14, users_invited: 8 },
    });
    expect(s.kind === 'product' && s.metrics.logins_30d).toBe(14);
  });

  it('parses an account signal from Gainsight CS', () => {
    const s = SignalSchema.parse({
      ...base,
      subject: { companyId: ids.company },
      kind: 'account',
      source: { system: 'gainsight_cs', eventId: 'cs-1' },
      activity: 'expansion_opportunity',
      productKey: 'portal',
    });
    expect(s.kind).toBe('account');
  });

  it.each([
    [
      'marketing signal not from HubSpot',
      {
        kind: 'marketing',
        source: { system: 'gainsight_px', eventId: 'e' },
        channel: 'demo_request',
      },
    ],
    [
      'marketing signal with a product channel',
      { kind: 'marketing', source: { system: 'hubspot', eventId: 'e' }, channel: 'product_usage' },
    ],
    [
      'product signal from HubSpot',
      {
        kind: 'product',
        source: { system: 'hubspot', eventId: 'e' },
        activity: 'login',
        productKey: 'mis',
      },
    ],
    [
      'product signal without a product',
      { kind: 'product', source: { system: 'gainsight_px', eventId: 'e' }, activity: 'login' },
    ],
    [
      'account signal from PX',
      {
        kind: 'account',
        source: { system: 'gainsight_px', eventId: 'e' },
        activity: 'health_change',
        subject: { companyId: ids.company },
      },
    ],
    [
      'account signal without a company',
      {
        kind: 'account',
        source: { system: 'gainsight_cs', eventId: 'e' },
        activity: 'health_change',
      },
    ],
    [
      'non-finite metric',
      {
        kind: 'product',
        source: { system: 'gainsight_px', eventId: 'e' },
        activity: 'login',
        productKey: 'mis',
        metrics: { logins: Infinity },
      },
    ],
    ['unknown kind', { kind: 'social', source: { system: 'hubspot', eventId: 'e' } }],
    [
      'missing event id',
      { kind: 'marketing', source: { system: 'hubspot', eventId: '' }, channel: 'demo_request' },
    ],
  ])('rejects %s', (_label, over) => {
    expect(SignalSchema.safeParse({ ...base, ...over }).success).toBe(false);
  });

  it('rejects a signal about nobody', () => {
    expect(
      SignalSchema.safeParse({
        ...base,
        subject: {},
        kind: 'marketing',
        source: { system: 'hubspot', eventId: 'e' },
        channel: 'demo_request',
      }).success,
    ).toBe(false);
  });

  it('gives duplicate deliveries of one event the same key, per tenant', () => {
    const raw = {
      ...base,
      kind: 'marketing',
      source: { system: 'hubspot', eventId: 'evt-7' },
      channel: 'contact_us',
    };
    const first = SignalSchema.parse(raw);
    const redelivered = SignalSchema.parse({ ...raw, receivedAt: at(30) });
    const otherTenant = SignalSchema.parse({ ...raw, tenantId: ids.otherTenant });
    expect(signalDeduplicationKey(first)).toBe(signalDeduplicationKey(redelivered));
    expect(signalDeduplicationKey(first)).not.toBe(signalDeduplicationKey(otherTenant));
  });
});
