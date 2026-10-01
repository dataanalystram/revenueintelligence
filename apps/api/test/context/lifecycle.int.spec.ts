import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TenantContext } from '../../src/modules/tenancy';
import { startContextHarness, type ContextHarness } from '../support/context';

/**
 * M6 lifecycle events (ADR 0014 §5, ADR 0015): deletion → tombstone (history
 * kept), restore → reactivate, merge → lineage, association change → source
 * relationship context only. Read-back decides presence, so event order does
 * not matter.
 */
describe('context lifecycle: deletion, restore, merge, association change', () => {
  let c: ContextHarness;
  let t: TenantContext;

  beforeAll(async () => {
    c = await startContextHarness();
    t = await c.tenant('life', 1001);
  });
  afterAll(async () => {
    await c?.close();
  });

  const ev = (over: Record<string, unknown>) => c.event(1001, over);
  const deliverAndWait = async (over: Record<string, unknown>) => {
    const [k] = await c.deliver(t, [ev(over)]);
    return c.waitForReceipt(t, k!);
  };
  const ref = async (table: 'person' | 'company', id: string) =>
    (
      await c.sql(
        `SELECT * FROM ${table}_external_refs WHERE tenant_id = $1 AND system = 'hubspot' AND external_id = $2`,
        [t.tenantId, id],
      )
    )[0];
  const person = async (id: string) =>
    (await c.sql('SELECT * FROM persons WHERE tenant_id = $1 AND id = $2', [t.tenantId, id]))[0]!;
  const create = (objectId: number, objectTypeId = '0-1') =>
    deliverAndWait({ subscriptionType: 'object.creation', objectTypeId, objectId });

  describe('deletion and restore', () => {
    it('deletion tombstones the reference and makes the record inactive; nothing is erased', async () => {
      await create(101);
      const before = await ref('person', '101');
      const backup = c.fake.requests.length; // eslint-disable-line @typescript-eslint/no-unused-vars
      c.fake.removeRecord('contacts', '101');
      const r = await deliverAndWait({
        subscriptionType: 'object.deletion',
        objectTypeId: '0-1',
        objectId: 101,
      });
      expect(r.processing_status).toBe('processed');
      const after = await ref('person', '101');
      expect(after).toMatchObject({ state: 'deleted', person_id: before!.person_id });
      expect(after!.deleted_at).toBeInstanceOf(Date);
      const p = await person(before!.person_id as string);
      expect(p.record_state).toBe('inactive');
      expect(p.primary_email).toBe('person1@school1.example'); // history kept, not hard-deleted
      const [last] = await c.sql(
        'SELECT change_type, changed_fields FROM tenant_context_changes WHERE tenant_id = $1 AND entity_id = $2 ORDER BY ingested_at DESC LIMIT 1',
        [t.tenantId, before!.person_id],
      );
      expect(last).toEqual({
        change_type: 'state_changed',
        changed_fields: ['refState', 'recordState'],
      });
    });

    it('restore reactivates the verified source record (read-back after the tombstone)', async () => {
      c.fake.upsertRecord('contacts', {
        id: '101',
        properties: {
          email: 'Person1@School1.example',
          firstname: 'First1',
          lastname: 'Last1',
          jobtitle: 'Head of IT',
        },
      });
      const r = await deliverAndWait({
        subscriptionType: 'object.restore',
        objectTypeId: '0-1',
        objectId: 101,
      });
      expect(r.processing_status).toBe('processed');
      const after = await ref('person', '101');
      expect(after).toMatchObject({ state: 'active', deleted_at: null });
      expect((await person(after!.person_id as string)).record_state).toBe('active');
    });

    it('a deletion receipt processed after the record came back changes nothing (read-back decides)', async () => {
      const r = await deliverAndWait({
        subscriptionType: 'object.deletion',
        objectTypeId: '0-1',
        objectId: 101,
      });
      expect(r.processing_status).toBe('processed');
      expect((await ref('person', '101'))!.state).toBe('active');
    });
  });

  describe('merge', () => {
    it('merging two contacts keeps lineage: the merged reference and record point to the survivor', async () => {
      await create(102);
      await create(103);
      const survivor = await ref('person', '102');
      const loser = await ref('person', '103');
      expect(loser!.person_id).not.toBe(survivor!.person_id);
      c.fake.removeRecord('contacts', '103');
      const r = await deliverAndWait({
        subscriptionType: 'object.merge',
        objectTypeId: '0-1',
        objectId: undefined,
        primaryObjectId: 102,
        mergedObjectIds: [103],
        numberOfPropertiesMoved: 2,
      });
      expect(r.processing_status).toBe('processed');
      const merged = await ref('person', '103');
      expect(merged).toMatchObject({
        state: 'merged',
        merged_into_external_id: '102',
        person_id: survivor!.person_id,
      });
      const old = await person(loser!.person_id as string);
      expect(old).toMatchObject({ record_state: 'merged', merged_into_id: survivor!.person_id });
      const lineage = await c.sql(
        "SELECT entity_id, change_type, changed_fields, source_record_id FROM tenant_context_changes WHERE tenant_id = $1 AND change_type = 'merged' ORDER BY ingested_at",
        [t.tenantId],
      );
      expect(lineage).toEqual(
        expect.arrayContaining([
          {
            entity_id: loser!.person_id,
            change_type: 'merged',
            changed_fields: ['recordState', 'mergedIntoId'],
            source_record_id: '103',
          },
          {
            entity_id: survivor!.person_id,
            change_type: 'merged',
            changed_fields: ['mergedFrom'],
            source_record_id: '103',
          },
        ]),
      );
    });

    it('replaying the same merge changes nothing', async () => {
      const before = await c.operations.stateHash(t);
      const r = await deliverAndWait({
        subscriptionType: 'object.merge',
        objectTypeId: '0-1',
        objectId: undefined,
        primaryObjectId: 102,
        mergedObjectIds: [103],
        eventId: 999_001,
      });
      expect(r.processing_status).toBe('processed');
      expect((await c.operations.stateHash(t)).hash).toBe(before.hash);
    });

    it('a merge that creates a new record (newObjectId) folds both old records into the new one', async () => {
      await create(104);
      await create(105);
      c.fake.upsertRecord('contacts', {
        id: '106',
        properties: {
          email: 'merged@school.example',
          firstname: 'New',
          lastname: null,
          jobtitle: null,
        },
      });
      c.fake.removeRecord('contacts', '104');
      c.fake.removeRecord('contacts', '105');
      const r = await deliverAndWait({
        subscriptionType: 'object.merge',
        objectTypeId: '0-1',
        objectId: undefined,
        primaryObjectId: 104,
        mergedObjectIds: [105],
        newObjectId: 106,
      });
      expect(r.processing_status).toBe('processed');
      const survivor = await ref('person', '106');
      for (const id of ['104', '105']) {
        expect(await ref('person', id)).toMatchObject({
          state: 'merged',
          merged_into_external_id: '106',
          person_id: survivor!.person_id,
        });
      }
    });

    it('never merges canonical records across systems automatically: a conflict is recorded', async () => {
      c.fake.upsertRecord('contacts', {
        id: '107',
        properties: { email: null, firstname: 'X', lastname: null, jobtitle: null },
      });
      c.fake.upsertRecord('contacts', {
        id: '108',
        properties: { email: null, firstname: 'Y', lastname: null, jobtitle: null },
      });
      await create(107);
      await create(108);
      const loser = await ref('person', '108');
      // The loser also carries a reference from another system (future connector).
      await c.sql(
        "INSERT INTO person_external_refs (tenant_id, system, object_type, external_id, person_id) VALUES ($1, 'sugar', 'Contacts', 'sugar-1', $2)",
        [t.tenantId, loser!.person_id],
      );
      c.fake.removeRecord('contacts', '108');
      await deliverAndWait({
        subscriptionType: 'object.merge',
        objectTypeId: '0-1',
        objectId: undefined,
        primaryObjectId: 107,
        mergedObjectIds: [108],
      });
      expect(await ref('person', '108')).toMatchObject({
        state: 'merged',
        merged_into_external_id: '107',
        person_id: loser!.person_id,
      });
      expect((await person(loser!.person_id as string)).record_state).toBe('active');
      const conflicts = await c.sql(
        "SELECT external_refs FROM tenant_identity_conflicts WHERE tenant_id = $1 AND kind = 'merge_across_systems'",
        [t.tenantId],
      );
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]!.external_refs).toEqual(
        expect.arrayContaining(['sugar:Contacts:sugar-1', 'hubspot:contacts:108']),
      );
    });

    it('company merges move the people of the merged company to the survivor', async () => {
      await create(202, '0-2');
      await create(203, '0-2');
      c.fake.upsertRecord('contacts', {
        id: '109',
        properties: { email: null, firstname: 'Z', lastname: null, jobtitle: null },
      });
      c.fake.setAssociations('contacts', 'companies', [
        ...sampleLinks(),
        {
          fromType: 'contacts',
          fromId: '109',
          toType: 'companies',
          toId: '203',
          typeId: 1,
          category: 'HUBSPOT_DEFINED',
          label: 'Primary',
        },
      ]);
      await create(109);
      const company203 = await ref('company', '203');
      const p109 = await ref('person', '109');
      expect((await person(p109!.person_id as string)).company_id).toBe(company203!.company_id);
      c.fake.removeRecord('companies', '203');
      await deliverAndWait({
        subscriptionType: 'object.merge',
        objectTypeId: '0-2',
        objectId: undefined,
        primaryObjectId: 202,
        mergedObjectIds: [203],
      });
      const company202 = await ref('company', '202');
      expect((await person(p109!.person_id as string)).company_id).toBe(company202!.company_id);
      const [old] = await c.sql(
        'SELECT record_state, merged_into_id FROM companies WHERE id = $1',
        [company203!.company_id],
      );
      expect(old).toEqual({ record_state: 'merged', merged_into_id: company202!.company_id });
    });
  });

  describe('association changes (source relationship context only)', () => {
    it('adding and removing a primary company link updates the relationship and the person, nothing else', async () => {
      c.fake.upsertRecord('contacts', {
        id: '110',
        properties: { email: null, firstname: 'Assoc', lastname: null, jobtitle: null },
      });
      await create(110);
      const p = await ref('person', '110');
      expect((await person(p!.person_id as string)).company_id).toBeNull();
      c.fake.setAssociations('contacts', 'companies', [
        ...sampleLinks(),
        {
          fromType: 'contacts',
          fromId: '110',
          toType: 'companies',
          toId: '201',
          typeId: 1,
          category: 'HUBSPOT_DEFINED',
          label: 'Primary',
        },
      ]);
      const added = await deliverAndWait({
        subscriptionType: 'object.associationChange',
        objectId: undefined,
        objectTypeId: undefined,
        fromObjectId: 110,
        fromObjectTypeId: '0-1',
        toObjectId: 201,
        toObjectTypeId: '0-2',
        associationTypeId: 1,
        associationRemoved: false,
        isPrimaryAssociation: true,
      });
      expect(added.processing_status).toBe('processed');
      await c.until(async () => (await person(p!.person_id as string)).company_id !== null);
      expect((await person(p!.person_id as string)).company_id).toBe(
        (await ref('company', '201'))!.company_id,
      );

      c.fake.setAssociations('contacts', 'companies', sampleLinks());
      await deliverAndWait({
        subscriptionType: 'object.associationChange',
        objectId: undefined,
        objectTypeId: undefined,
        fromObjectId: 201,
        fromObjectTypeId: '0-2',
        toObjectId: 110,
        toObjectTypeId: '0-1',
        associationTypeId: 2,
        associationRemoved: true,
      });
      expect((await person(p!.person_id as string)).company_id).toBeNull();
      const [rel] = await c.sql(
        "SELECT state FROM tenant_source_relationships WHERE tenant_id = $1 AND from_external_id = '110'",
        [t.tenantId],
      );
      expect(rel!.state).toBe('removed');
    });

    it('associations with other object types (e.g. deals) are irrelevant to context', async () => {
      const r = await deliverAndWait({
        subscriptionType: 'object.associationChange',
        objectId: undefined,
        objectTypeId: undefined,
        fromObjectId: 101,
        fromObjectTypeId: '0-1',
        toObjectId: 555,
        toObjectTypeId: '0-3',
      });
      expect(r).toMatchObject({
        processing_status: 'irrelevant',
        processing_reason: 'association_out_of_scope',
      });
    });
  });

  function sampleLinks() {
    return ['101', '102', '103'].map((id, i) => ({
      fromType: 'contacts',
      fromId: id,
      toType: 'companies',
      toId: String(201 + i),
      typeId: 1,
      category: 'HUBSPOT_DEFINED' as const,
      label: 'Primary',
    }));
  }
});
