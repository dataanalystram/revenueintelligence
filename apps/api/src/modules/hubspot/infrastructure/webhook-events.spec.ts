import { createHash } from 'node:crypto';
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

  describe('M6 lifecycle identifiers (ADR 0015)', () => {
    it('keeps merge identifiers, still no values', () => {
      const event = webhookEvent({
        subscriptionType: 'object.merge',
        objectTypeId: '0-1',
        objectId: undefined,
        primaryObjectId: 101,
        mergedObjectIds: [102, '103'],
        newObjectId: 104,
        numberOfPropertiesMoved: 7,
        propertyValue: 'secret-value-marker',
      });
      const parsed = parseWebhookBatch(body([event]));
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.events[0]!.merge).toEqual({
        primaryObjectId: '101',
        newObjectId: '104',
        mergedObjectIds: ['102', '103'],
      });
      expect(JSON.stringify(parsed.events)).not.toContain('secret-value-marker');
      expect(JSON.stringify(parsed.events)).not.toContain('numberOfPropertiesMoved');
    });

    it('keeps association identifiers', () => {
      const event = webhookEvent({
        subscriptionType: 'object.associationChange',
        objectId: undefined,
        fromObjectId: 101,
        fromObjectTypeId: '0-1',
        toObjectId: 201,
        toObjectTypeId: '0-2',
        associationTypeId: 1,
        associationCategory: 'HUBSPOT_DEFINED',
        associationRemoved: false,
        isPrimaryAssociation: true,
      });
      const parsed = parseWebhookBatch(body([event]));
      expect(parsed.ok && parsed.events[0]!.association).toEqual({
        fromObjectId: '101',
        fromObjectTypeId: '0-1',
        toObjectId: '201',
        toObjectTypeId: '0-2',
        associationTypeId: 1,
        associationCategory: 'HUBSPOT_DEFINED',
        associationRemoved: false,
        isPrimaryAssociation: true,
      });
    });

    it('delivery keys of M5-style events are unchanged (stored receipts stay de-duplicated)', () => {
      const event = webhookEvent({
        subscriptionType: 'object.propertyChange',
        propertyName: 'email',
      });
      const parsed = parseWebhookBatch(body([event]));
      if (!parsed.ok) throw new Error('parse failed');
      const e = event as {
        portalId: number;
        appId: number;
        subscriptionId: number;
        eventId: number;
        objectTypeId: string;
        objectId: number;
        occurredAt: number;
      };
      const m5Identity = [
        String(e.portalId),
        String(e.appId),
        String(e.subscriptionId),
        String(e.eventId),
        'object.propertyChange',
        e.objectTypeId,
        String(e.objectId),
        'email',
        e.occurredAt,
      ];
      expect(parsed.events[0]!.deliveryKey).toBe(
        createHash('sha256').update(JSON.stringify(m5Identity)).digest('hex'),
      );
    });

    it('two association events differing only by removal have different keys', () => {
      const base = {
        subscriptionType: 'object.associationChange',
        objectId: undefined,
        fromObjectId: 101,
        toObjectId: 201,
      };
      const a = parseWebhookBatch(body([webhookEvent({ ...base, associationRemoved: false })]));
      const b = parseWebhookBatch(body([webhookEvent({ ...base, associationRemoved: true })]));
      if (!a.ok || !b.ok) throw new Error('parse failed');
      expect(a.events[0]!.deliveryKey).not.toBe(b.events[0]!.deliveryKey);
    });
  });
});
