import { describe, expect, it } from 'vitest';
import { webhookEvent } from '../../../../test/support/hubspot-webhooks';
import { WEBHOOK_MAX_EVENTS, parseWebhookBatch } from './webhook-events';

const body = (value: unknown) => Buffer.from(JSON.stringify(value));

describe('HubSpot webhook payload (ADR 0011)', () => {
  it('keeps identifiers only: property values and unknown fields never survive parsing', () => {
    const event = webhookEvent({
      subscriptionType: 'object.propertyChange',
      propertyName: 'email',
      propertyValue: 'secret-value-marker@example.com',
    });
    const parsed = parseWebhookBatch(body([event]));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(JSON.stringify(parsed.events)).not.toContain('secret-value-marker');
    expect(JSON.stringify(parsed.events)).not.toContain('userId');
    expect(parsed.events[0]).toMatchObject({
      eventId: String(event.eventId),
      accountId: '5005',
      appId: '22222',
      subscriptionType: 'object.propertyChange',
      objectTypeId: '0-1',
      propertyName: 'email',
      changeSource: 'CRM_UI',
      attemptNumber: 0,
    });
    expect(Object.keys(parsed.events[0]!).sort()).toEqual([
      'accountId',
      'appId',
      'attemptNumber',
      'changeSource',
      'deliveryKey',
      'eventId',
      'objectId',
      'objectTypeId',
      'occurredAt',
      'propertyName',
      'subscriptionId',
      'subscriptionType',
    ]);
  });

  it('accepts legacy subscription types and eventType instead of subscriptionType', () => {
    const legacy = webhookEvent({ subscriptionType: 'contact.creation', objectTypeId: undefined });
    const generic = webhookEvent({ subscriptionType: undefined, eventType: 'object.creation' });
    const parsed = parseWebhookBatch(body([legacy, generic]));
    expect(parsed.ok && parsed.events.map((e) => e.subscriptionType)).toEqual([
      'contact.creation',
      'object.creation',
    ]);
  });

  it('the delivery key is the same for every attempt of an event and differs between events', () => {
    const first = webhookEvent();
    const retry = { ...first, attemptNumber: 3 };
    const other = { ...first, eventId: Number(first.eventId) + 1 };
    const parsed = parseWebhookBatch(body([first, retry, other]));
    if (!parsed.ok) throw new Error(parsed.issues);
    const [a, b, c] = parsed.events.map((e) => e.deliveryKey);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toBe(a);
    expect(c).not.toBe(a);
  });

  it('refuses malformed batches without echoing their content', () => {
    const cases: unknown[] = [
      {},
      [],
      Array.from({ length: WEBHOOK_MAX_EVENTS + 1 }, () => webhookEvent()),
      [webhookEvent({ portalId: 'drop table' })],
      [webhookEvent({ eventId: 2 ** 60 })], // would be rounded: refused, never mis-stored
      [webhookEvent({ appId: undefined })],
      [webhookEvent({ attemptNumber: -1 })],
      [webhookEvent({ subscriptionType: undefined })],
      [webhookEvent({ subscriptionType: 'secret value' })],
    ];
    for (const value of cases) {
      const parsed = parseWebhookBatch(body(value));
      expect(parsed.ok, JSON.stringify(value).slice(0, 80)).toBe(false);
      if (!parsed.ok) expect(parsed.issues).not.toContain('drop table');
    }
    expect(parseWebhookBatch(Buffer.from('not json'))).toEqual({
      ok: false,
      issues: 'body is not JSON',
    });
  });

  it('drops optional metadata in an unexpected format instead of storing it', () => {
    const parsed = parseWebhookBatch(
      body([
        webhookEvent({ propertyName: 'has spaces', changeSource: 'free text', objectTypeId: 'x' }),
      ]),
    );
    if (!parsed.ok) throw new Error(parsed.issues);
    expect(parsed.events[0]).toMatchObject({
      propertyName: undefined,
      changeSource: undefined,
      objectTypeId: undefined,
    });
  });
});
