import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AccountStructureReadModel,
  PersonAffiliationWriter,
  type OperatorAffiliationAdd,
} from '../../src/modules/context';
import { sourceSyncActor } from '../../src/modules/domain';
import {
  CanonicalAdoptionService,
  IntegrityVerificationService,
} from '../../src/modules/governance';
import type { TenantContext } from '../../src/modules/tenancy';
import {
  affiliationsOf,
  asApp,
  auditOf,
  companies,
  contact,
  hs,
  historyOf,
  ingest,
  ingestMeta,
  issuesOf,
  link,
  observeCompany,
  observePerson,
  personIdOf,
  structureChangesOf,
} from '../support/account-structure';
import { startContextHarness, type ContextHarness } from '../support/context';
import { authz } from '../support/security';

const REASON = 'account_review';
const D = (iso: string) => new Date(iso);

/**
 * M10C Person–Account affiliation (plan §3, §4, §5, §6, §19) on real
 * PostgreSQL as the application role with forced RLS: projection of company
 * links and the `person.affiliation` statement through the single writer
 * (V9), operator entry, the table's constraints by raw SQL (V10), the company
 * and person merge participants (V8, affiliations), cross-tenant refusal by
 * raw SQL (V11, affiliations), the affiliation read model with the derived
 * primary flag (V12), privacy of history, issues, audit and logs (V13) and the
 * 0.3 gate (V15, affiliations).
 */
describe('M10C person–account affiliations', () => {
  let c: ContextHarness;

  beforeAll(async () => {
    c = await startContextHarness();
  });
  afterAll(async () => {
    await c?.close();
  });
  afterEach(() => vi.restoreAllMocks());

  const writer = () => c.app.get(PersonAffiliationWriter);
  const readModel = () => c.app.get(AccountStructureReadModel);
  const adoption = () => c.app.get(CanonicalAdoptionService);
  const integrity = () => c.app.get(IntegrityVerificationService);

  const add = async (
    t: TenantContext,
    input: Omit<OperatorAffiliationAdd, 'reason'> & { reason?: string },
  ) => writer().add(await authz(t, 'canonical.human_entry'), { reason: REASON, ...input });
  const end = async (t: TenantContext, affiliationId: string, endsAt?: Date) =>
    writer().end(await authz(t, 'canonical.human_entry'), {
      affiliationId,
      reason: REASON,
      ...(endsAt ? { endsAt } : {}),
    });
  const mergeOf = async (
    t: TenantContext,
    kind: 'company' | 'person',
    survivor: string,
    merged: string[],
  ) =>
    c.ingestion.ingestMerge(
      await authz(t, 'canonical.source_sync'),
      {
        kind,
        survivor: kind === 'company' ? hs(survivor) : contact(survivor),
        merged: merged.map(kind === 'company' ? hs : contact),
        observedAt: new Date(),
      },
      ingestMeta(),
    );
  const companyIdOfPerson = async (t: TenantContext, personId: string) =>
    (
      await c.sql<{ company_id: string | null }>(
        `SELECT company_id::text FROM persons WHERE tenant_id = $1 AND id = $2`,
        [t.tenantId, personId],
      )
    )[0]!.company_id;
  const tombstone = async (t: TenantContext, kind: 'company' | 'person', id: string) =>
    ingest(c, t, {
      kind,
      presence: 'absent',
      ref: kind === 'company' ? hs(id) : contact(id),
      observedAt: new Date(),
    });

  describe('V9: projection of source statements (single writer)', () => {
    it('company links → active affiliations; authoritative removal ends; absence never ends; renewal is a new row; primary derived', async () => {
      const t = await c.tenant('afflinks', 1001);
      const ids = await companies(c, t, ['901', '902']);
      const first = await observePerson(c, t, '9001', { links: [link('901', true), link('902')] });
      const person = first.entityId!;
      let rows = await affiliationsOf(c, t, person);
      expect(
        rows.map((r) => [r.company_id, r.status, r.origin, r.role_codes, r.end_reason]),
      ).toEqual(
        expect.arrayContaining([
          [ids['901'], 'active', 'source_provided', [], null],
          [ids['902'], 'active', 'source_provided', [], null],
        ]),
      );
      expect(rows).toHaveLength(2);
      // persons.company_id stays the single primary account (unchanged M6 behaviour).
      expect(await companyIdOfPerson(t, person)).toBe(ids['901']);
      // One `created` record per row; value-free history (personal fields, Q15).
      const created = await structureChangesOf(c, t, 'person_affiliation');
      expect(
        created.map((ch) => [ch.change_type, ch.cause, ch.origin, ch.canonical_version]),
      ).toEqual([
        ['created', 'webhook', 'source_provided', '0.3'],
        ['created', 'webhook', 'source_provided', '0.3'],
      ]);
      expect(created.every((ch) => ch.source_record_id === '9001')).toBe(true);
      const history = await historyOf(c, t, 'person_affiliation');
      expect(history.map((h) => [h.field, h.values_recorded, h.old_value, h.new_value])).toEqual([
        ['status', false, null, null],
        ['status', false, null, null],
      ]);

      // Authoritative removal (the link became `removed` in this observation) ends the row.
      const removedAt = new Date();
      await observePerson(c, t, '9001', { links: [link('901', true)], observedAt: removedAt });
      rows = await affiliationsOf(c, t, person);
      const ended = rows.find((r) => r.company_id === ids['902'])!;
      expect(ended).toMatchObject({ status: 'ended', end_reason: 'source_removed', ends_at: null });
      expect(ended.ended_at!.getTime()).toBe(removedAt.getTime());
      expect((await structureChangesOf(c, t, 'person_affiliation', ended.id)).at(-1)).toMatchObject(
        {
          change_type: 'state_changed',
          changed_fields: ['status'],
        },
      );

      // Associations not read, a tombstoned person or company: nothing ends.
      await observePerson(c, t, '9001', { jobTitle: 'Head of Learning' });
      await tombstone(t, 'company', '901');
      await tombstone(t, 'person', '9001');
      expect(
        (await affiliationsOf(c, t, person))
          .filter((r) => r.status === 'active')
          .map((r) => r.company_id),
      ).toEqual([ids['901']]);

      // Renewed: the link is stated again → a new row; the ended period is kept.
      await observePerson(c, t, '9001', { links: [link('901', true), link('902')] });
      rows = await affiliationsOf(c, t, person);
      const for902 = rows.filter((r) => r.company_id === ids['902']);
      expect(for902.map((r) => r.status)).toEqual(['ended', 'active']);
      expect(new Set(for902.map((r) => r.id)).size).toBe(2);

      // Derived primary (never stored): read model and view agree with persons.company_id.
      const view = await readModel().affiliations(await authz(t, 'data.account_structure.read'), {
        personId: person,
        activeOnly: true,
      });
      expect(view.map((v) => [v.companyId, v.isPrimary]).sort()).toEqual(
        [
          [ids['901'], true],
          [ids['902'], false],
        ].sort(),
      );
      const fromView = await asApp(
        c,
        t,
        async (db) =>
          (
            await db.query<{ company_id: string; is_primary: boolean }>(
              `SELECT company_id::text, is_primary FROM person_affiliation_index
              WHERE person_id = $1 AND status = 'active' ORDER BY company_id`,
              [person],
            )
          ).rows,
      );
      expect(fromView.map((r) => [r.company_id, r.is_primary]).sort()).toEqual(
        view.map((v) => [v.companyId, v.isPrimary]).sort(),
      );
    });

    it('person.affiliation: role codes and period; update; a stated end ends the row; a past period creates nothing', async () => {
      const t = await c.tenant('affstate', 1001);
      const ids = await companies(c, t, ['911', '912']);
      const person = (await observePerson(c, t, '9101')).entityId!;
      const starts = D('2026-01-01T00:00:00Z');
      const future = new Date(Date.now() + 365 * 86_400_000);
      await observePerson(c, t, '9101', {
        affiliations: [
          {
            company: hs('911'),
            roleCodes: ['decision_maker', 'champion'],
            startsAt: starts,
            endsAt: future,
          },
        ],
      });
      let [row] = await affiliationsOf(c, t, person);
      expect(row).toMatchObject({
        company_id: ids['911'],
        status: 'active',
        origin: 'source_provided',
        role_codes: ['champion', 'decision_maker'],
      });
      expect(row!.starts_at!.getTime()).toBe(starts.getTime());
      expect(row!.ends_at!.getTime()).toBe(future.getTime());
      expect(
        (await historyOf(c, t, 'person_affiliation', row!.id)).map((h) => [
          h.field,
          h.values_recorded,
        ]),
      ).toEqual(
        expect.arrayContaining([
          ['status', false],
          ['role_codes', false],
          ['starts_at', false],
          ['ends_at', false],
        ]),
      );
      // Same statement: unchanged. New role codes: one `updated` record.
      await observePerson(c, t, '9101', {
        affiliations: [
          {
            company: hs('911'),
            roleCodes: ['champion', 'decision_maker'],
            startsAt: starts,
            endsAt: future,
          },
        ],
      });
      await observePerson(c, t, '9101', {
        affiliations: [
          { company: hs('911'), roleCodes: ['champion'], startsAt: starts, endsAt: future },
        ],
      });
      const changes = await structureChangesOf(c, t, 'person_affiliation', row!.id);
      expect(changes.map((ch) => [ch.change_type, ch.changed_fields])).toEqual([
        ['created', ['status', 'roleCodes', 'startsAt', 'endsAt']],
        ['updated', ['roleCodes']],
      ]);
      expect((await affiliationsOf(c, t, person))[0]!.role_codes).toEqual(['champion']);
      // A stated end at or before the observation ends the row (source_end_date, ends_at stated).
      const endedOn = D('2026-06-30T00:00:00Z');
      await observePerson(c, t, '9101', {
        affiliations: [
          { company: hs('911'), roleCodes: ['champion'], startsAt: starts, endsAt: endedOn },
        ],
      });
      [row] = await affiliationsOf(c, t, person);
      expect(row).toMatchObject({ status: 'ended', end_reason: 'source_end_date' });
      expect(row!.ends_at!.getTime()).toBe(endedOn.getTime());
      // A past period with no active row creates nothing.
      await observePerson(c, t, '9101', {
        affiliations: [{ company: hs('912'), roleCodes: [], endsAt: endedOn }],
      });
      expect((await affiliationsOf(c, t, person)).map((r) => r.company_id)).toEqual([ids['911']]);
      // An empty statement removes a stated affiliation (authoritative removal).
      await observePerson(c, t, '9101', {
        affiliations: [{ company: hs('912'), roleCodes: ['user'] }],
      });
      await observePerson(c, t, '9101', { affiliations: [] });
      const r912 = (await affiliationsOf(c, t, person)).find((r) => r.company_id === ids['912'])!;
      expect(r912).toMatchObject({ status: 'ended', end_reason: 'source_removed' });
    });

    it('an unknown company is an open issue and the affiliation arrives with the company; nothing is inferred from email', async () => {
      const t = await c.tenant('affunres', 1001);
      const person = (await observePerson(c, t, '9201', { links: [link('929', true)] })).entityId!;
      expect(await affiliationsOf(c, t, person)).toEqual([]);
      expect(await issuesOf(c, t)).toEqual([
        {
          kind: 'affiliation_endpoint_unresolved',
          entity_kind: 'person',
          state: 'open',
          canonical_ids: [person],
          external_refs: ['hubspot:companies:929', 'hubspot:contacts:9201'],
        },
      ]);
      const company = (await observeCompany(c, t, '929')).entityId!;
      expect((await affiliationsOf(c, t, person)).map((r) => [r.company_id, r.status])).toEqual([
        [company, 'active'],
      ]);
      expect((await issuesOf(c, t)).map((i) => i.state)).toEqual(['resolved']);
      // Same email domain as a company, no link: no affiliation.
      await ingest(c, t, {
        kind: 'company',
        presence: 'present',
        ref: hs('930'),
        observedAt: new Date(),
        fields: { name: 'Domain School', domain: 'domainschool.example' },
      });
      const other = (await observePerson(c, t, '9202', { email: 'teacher@domainschool.example' }))
        .entityId!;
      expect(await affiliationsOf(c, t, other)).toEqual([]);
    });

    it('a human row is never changed or ended by a source; operator add / end are audited once each', async () => {
      const t = await c.tenant('affhuman', 1001);
      const ids = await companies(c, t, ['941', '942']);
      const person = (await observePerson(c, t, '9401', { links: [link('941', true)] })).entityId!;
      const before = (await auditOf(c, t)).length;
      const added = await add(t, {
        personId: person,
        companyId: ids['941']!,
        roleCodes: ['sponsor'],
        startsAt: D('2026-02-01T00:00:00Z'),
      });
      expect(added).toMatchObject({
        personId: person,
        companyId: ids['941'],
        status: 'active',
        changed: true,
      });
      let rows = await affiliationsOf(c, t, person);
      expect(rows.map((r) => [r.origin, r.status, r.end_reason])).toEqual([
        ['source_provided', 'ended', 'operator'],
        ['human', 'active', null],
      ]);
      const events = await auditOf(c, t);
      expect(events).toHaveLength(before + 1);
      expect(events.at(-1)).toMatchObject({
        action: 'person.affiliation.add',
        outcome: 'allowed',
        capability: 'canonical.human_entry',
        target_kind: 'person_affiliation',
        target_ref: added.affiliationId,
        details: { reason: REASON, changed: true, replacedSourceRow: true },
      });
      // The source removes the link, then states it again with roles: the human row stands.
      await observePerson(c, t, '9401', { links: [] });
      await observePerson(c, t, '9401', {
        links: [link('941', true)],
        affiliations: [{ company: hs('941'), roleCodes: ['user'] }],
      });
      rows = await affiliationsOf(c, t, person);
      expect(rows.map((r) => [r.origin, r.status, r.role_codes])).toEqual([
        ['source_provided', 'ended', []],
        ['human', 'active', ['sponsor']],
      ]);
      // The same operator statement changes nothing; different roles update in place.
      await expect(
        add(t, {
          personId: person,
          companyId: ids['941']!,
          roleCodes: ['sponsor'],
          startsAt: D('2026-02-01T00:00:00Z'),
        }),
      ).resolves.toMatchObject({ affiliationId: added.affiliationId, changed: false });
      await add(t, { personId: person, companyId: ids['941']!, roleCodes: ['sponsor', 'billing'] });
      expect((await affiliationsOf(c, t, person)).at(-1)!.role_codes).toEqual([
        'billing',
        'sponsor',
      ]);
      // End: operator, terminal; ending again is refused.
      await expect(end(t, added.affiliationId, D('2026-09-30T00:00:00Z'))).resolves.toMatchObject({
        status: 'ended',
      });
      const last = (await affiliationsOf(c, t, person)).at(-1)!;
      expect(last).toMatchObject({ status: 'ended', end_reason: 'operator' });
      expect(last.ends_at!.getTime()).toBe(D('2026-09-30T00:00:00Z').getTime());
      await expect(end(t, added.affiliationId)).rejects.toMatchObject({
        code: 'validation_failed',
      });
      expect(
        (await auditOf(c, t))
          .filter((e) => e.action.startsWith('person.affiliation.'))
          .map((e) => [e.action, e.outcome, e.reason_code]),
      ).toEqual([
        ['person.affiliation.add', 'allowed', null],
        ['person.affiliation.add', 'allowed', null],
        ['person.affiliation.add', 'allowed', null],
        ['person.affiliation.end', 'allowed', null],
        ['person.affiliation.end', 'failed', 'validation_failed'],
      ]);
    });

    it('operator entry refuses an invalid period, invalid role codes, a merged endpoint, free-text reasons and other actors', async () => {
      const t = await c.tenant('affopbad', 1001);
      const ids = await companies(c, t, ['951', '952', '953']);
      const person = (await observePerson(c, t, '9501')).entityId!;
      await expect(
        add(t, {
          personId: person,
          companyId: ids['951']!,
          startsAt: D('2026-05-01T00:00:00Z'),
          endsAt: D('2026-04-01T00:00:00Z'),
        }),
      ).rejects.toMatchObject({ code: 'affiliation_period_invalid' });
      await expect(
        add(t, { personId: person, companyId: ids['951']!, roleCodes: ['Decision Maker'] }),
      ).rejects.toMatchObject({ code: 'validation_failed' });
      await mergeOf(t, 'company', '953', ['952']);
      await expect(add(t, { personId: person, companyId: ids['952']! })).rejects.toMatchObject({
        code: 'affiliation_endpoint_not_allowed',
      });
      await expect(
        add(t, { personId: person, companyId: ids['951']!, reason: 'because I said so' }),
      ).rejects.toMatchObject({ code: 'validation_failed' });
      await expect(
        authz(
          t,
          'canonical.human_entry',
          sourceSyncActor(`run:${randomUUID()}`),
          'person.affiliation.add',
        ),
      ).rejects.toMatchObject({ name: 'AuthorizationDeniedError' });
      expect(
        (await auditOf(c, t))
          .filter((e) => e.action === 'person.affiliation.add')
          .map((e) => [e.outcome, e.reason_code]),
      ).toEqual([
        ['failed', 'affiliation_period_invalid'],
        ['failed', 'validation_failed'],
        ['failed', 'affiliation_endpoint_not_allowed'],
        ['failed', 'validation_failed'],
        ['denied', 'capability_not_granted'],
      ]);
      expect(await affiliationsOf(c, t, person)).toEqual([]);
    });
  });

  describe('V10: affiliation constraints (raw SQL as the app role)', () => {
    async function fixture(prefix: string) {
      const t = await c.tenant(prefix, 1001);
      const ids = await companies(c, t, ['1001']);
      const p1 = (await observePerson(c, t, '10001')).entityId!;
      const p2 = (await observePerson(c, t, '10002')).entityId!;
      return { t, company: ids['1001']!, p1, p2 };
    }
    const insert = `INSERT INTO tenant_person_affiliations (tenant_id, person_id, company_id, origin)
                    VALUES ($1, $2, $3, 'source_provided') RETURNING id::text`;

    it('one active row per pair; ended periods kept; the entity index is maintained', async () => {
      const { t, company, p1 } = await fixture('affcons1');
      await asApp(c, t, async (db) => {
        const { rows } = await db.query<{ id: string }>(insert, [t.tenantId, p1, company]);
        const indexed = await db.query(
          `SELECT 1 FROM tenant_entity_index WHERE kind = 'person_affiliation' AND entity_id = $1`,
          [rows[0]!.id],
        );
        expect(indexed.rowCount).toBe(1);
        await expect(db.query(insert, [t.tenantId, p1, company])).rejects.toMatchObject({
          code: '23505',
          message: 'affiliation_active_exists',
        });
      });
      await asApp(c, t, async (db) => {
        const { rows } = await db.query<{ id: string }>(insert, [t.tenantId, p1, company]);
        await db.query(
          `UPDATE tenant_person_affiliations SET status = 'ended', ended_at = now(), end_reason = 'operator' WHERE id = $1`,
          [rows[0]!.id],
        );
        // A renewed affiliation is a new row next to the ended one.
        await expect(db.query(insert, [t.tenantId, p1, company])).resolves.toMatchObject({
          rowCount: 1,
        });
      });
    });

    it.each([
      [
        'period',
        `starts_at, ends_at`,
        `'2026-02-01', '2026-01-01'`,
        'tenant_person_affiliations_period_valid',
      ],
      [
        'role-code pattern',
        `role_codes`,
        `'{Champion}'`,
        'tenant_person_affiliations_role_codes_valid',
      ],
      ['empty role code', `role_codes`, `'{""}'`, 'tenant_person_affiliations_role_codes_valid'],
      [
        'eleven role codes',
        `role_codes`,
        `'{a,b,c,d,e,f,g,h,i,j,k}'`,
        'tenant_person_affiliations_role_codes_valid',
      ],
      ['NULL role codes', `role_codes`, `NULL`, 'tenant_person_affiliations_role_codes_valid'],
      ['ended_at while active', `ended_at`, `now()`, 'tenant_person_affiliations_ended_at'],
      [
        'end reason while active',
        `end_reason`,
        `'operator'`,
        'tenant_person_affiliations_end_reason',
      ],
      [
        'unknown status',
        `status, ended_at, end_reason`,
        `'inferred', now(), 'operator'`,
        'tenant_person_affiliations_status_valid',
      ],
      [
        'unknown end reason',
        `status, ended_at, end_reason`,
        `'ended', now(), 'email_bounced'`,
        'tenant_person_affiliations_end_reason_valid',
      ],
      [
        'merged without target',
        `status, ended_at, end_reason`,
        `'merged', now(), 'person_merged'`,
        'tenant_person_affiliations_merged_target',
      ],
      [
        'field-hash format',
        `field_hash`,
        `'not-a-hash'`,
        'tenant_person_affiliations_field_hash_format',
      ],
    ])('the %s CHECK refuses', async (_label, columns, values, constraint) => {
      const { t, company, p1 } = await fixture(
        `affchk${String(_label)
          .replace(/[^a-z]/g, '')
          .slice(0, 10)}`,
      );
      await asApp(c, t, async (db) => {
        await expect(
          db.query(
            `INSERT INTO tenant_person_affiliations (tenant_id, person_id, company_id, origin, ${columns})
             VALUES ($1, $2, $3, 'source_provided', ${values})`,
            [t.tenantId, p1, company],
          ),
        ).rejects.toMatchObject({ code: '23514', constraint });
      });
    });

    it('ended / merged rows are terminal; endpoints and origin are immutable; the app role cannot delete', async () => {
      const { t, company, p1, p2 } = await fixture('affcons2');
      await asApp(c, t, async (db) => {
        const { rows } = await db.query<{ id: string }>(insert, [t.tenantId, p1, company]);
        await db.query(
          `UPDATE tenant_person_affiliations SET status = 'ended', ended_at = now(), end_reason = 'operator' WHERE id = $1`,
          [rows[0]!.id],
        );
        await expect(
          db.query(
            `UPDATE tenant_person_affiliations SET status = 'active', ended_at = NULL, end_reason = NULL WHERE id = $1`,
            [rows[0]!.id],
          ),
        ).rejects.toMatchObject({ code: '23514', message: 'affiliation_terminal' });
      });
      await asApp(c, t, async (db) => {
        const { rows } = await db.query<{ id: string }>(insert, [t.tenantId, p1, company]);
        await db.query(
          `UPDATE tenant_person_affiliations SET status = 'ended', ended_at = now(), end_reason = 'operator' WHERE id = $1`,
          [rows[0]!.id],
        );
        await expect(
          db.query(`UPDATE tenant_person_affiliations SET role_codes = '{late}' WHERE id = $1`, [
            rows[0]!.id,
          ]),
        ).rejects.toMatchObject({ message: 'affiliation_terminal' });
      });
      for (const change of [
        `person_id = '${p2}'`,
        `company_id = gen_random_uuid()`,
        `origin = 'human'`,
      ]) {
        await asApp(c, t, async (db) => {
          const { rows } = await db.query<{ id: string }>(insert, [t.tenantId, p1, company]);
          await expect(
            db.query(`UPDATE tenant_person_affiliations SET ${change} WHERE id = $1`, [
              rows[0]!.id,
            ]),
          ).rejects.toMatchObject({ message: 'affiliation_identity_immutable' });
        });
      }
      await asApp(c, t, async (db) => {
        await db.query(insert, [t.tenantId, p1, company]);
        await expect(db.query(`DELETE FROM tenant_person_affiliations`)).rejects.toMatchObject({
          code: '42501',
        });
      });
    });
  });

  describe('V8: merge participants (affiliations)', () => {
    it('company merge: a loser row ends `merged` into the survivor row (reused or created); no active row stays on the loser', async () => {
      const t = await c.tenant('affmrgc', 1001);
      const ids = await companies(c, t, ['1101', '1102']);
      const [loser, survivor] = [ids['1101']!, ids['1102']!];
      const p = (await observePerson(c, t, '11001', { links: [link('1101', true), link('1102')] }))
        .entityId!;
      const q = (
        await observePerson(c, t, '11002', {
          affiliations: [
            { company: hs('1101'), roleCodes: ['champion'], startsAt: D('2026-03-01T00:00:00Z') },
          ],
        })
      ).entityId!;
      const pSurvivorRow = (await affiliationsOf(c, t, p)).find((r) => r.company_id === survivor)!;
      await mergeOf(t, 'company', '1102', ['1101']);
      const pRows = await affiliationsOf(c, t, p);
      expect(pRows.find((r) => r.company_id === loser)).toMatchObject({
        status: 'merged',
        end_reason: 'company_merged',
        merged_into_id: pSurvivorRow.id,
      });
      const qRows = await affiliationsOf(c, t, q);
      const qNew = qRows.find((r) => r.company_id === survivor)!;
      expect(qNew).toMatchObject({
        status: 'active',
        origin: 'source_provided',
        role_codes: ['champion'],
      });
      expect(qNew.starts_at!.getTime()).toBe(D('2026-03-01T00:00:00Z').getTime());
      expect(qRows.find((r) => r.company_id === loser)).toMatchObject({
        status: 'merged',
        end_reason: 'company_merged',
        merged_into_id: qNew.id,
      });
      expect(
        (await affiliationsOf(c, t)).filter((r) => r.company_id === loser && r.status === 'active'),
      ).toEqual([]);
      const loserRow = qRows.find((r) => r.company_id === loser)!;
      expect(
        (await structureChangesOf(c, t, 'person_affiliation', loserRow.id)).at(-1),
      ).toMatchObject({
        change_type: 'merged',
        source_record_id: '1101',
      });
      const report = await integrity().verify(t);
      expect(report.findings.filter((f) => f.check.startsWith('affiliation_'))).toEqual([]);
    });

    it('person merge (new port): each loser-person row ends `merged` into the survivor-person row', async () => {
      const t = await c.tenant('affmrgp', 1001);
      const ids = await companies(c, t, ['1111', '1112']);
      const p1 = (await observePerson(c, t, '11101', { links: [link('1111', true)] })).entityId!;
      const p2 = (await observePerson(c, t, '11102', { links: [link('1111', true), link('1112')] }))
        .entityId!;
      const p1Row = (await affiliationsOf(c, t, p1))[0]!;
      await mergeOf(t, 'person', '11101', ['11102']);
      const survivorRows = await affiliationsOf(c, t, p1);
      expect(survivorRows.map((r) => [r.company_id, r.status]).sort()).toEqual(
        [
          [ids['1111'], 'active'],
          [ids['1112'], 'active'],
        ].sort(),
      );
      const newRow = survivorRows.find((r) => r.company_id === ids['1112'])!;
      const loserRows = await affiliationsOf(c, t, p2);
      expect(
        loserRows.map((r) => [r.company_id, r.status, r.end_reason, r.merged_into_id]).sort(),
      ).toEqual(
        [
          [ids['1111'], 'merged', 'person_merged', p1Row.id],
          [ids['1112'], 'merged', 'person_merged', newRow.id],
        ].sort(),
      );
      const report = await integrity().verify(t);
      expect(report.findings.filter((f) => f.check.startsWith('affiliation_'))).toEqual([]);
      expect(await personIdOf(c, t, '11102')).toBe(p1);
    });
  });

  describe('V11: cross-tenant affiliation is impossible (raw SQL as the app role)', () => {
    it('tenant A cannot reference tenant B people or companies, write B rows, read them or forge index rows', async () => {
      const a = await c.tenant('affxa', 1001);
      const b = await c.tenant('affxb', 2002);
      const ca = (await companies(c, a, ['1201']))['1201']!;
      const pa = (await observePerson(c, a, '12001')).entityId!;
      const cb = (await companies(c, b, ['1201']))['1201']!;
      const pb = (await observePerson(c, b, '12001', { links: [link('1201', true)] })).entityId!;
      const [bRow] = await affiliationsOf(c, b, pb);
      const insert = `INSERT INTO tenant_person_affiliations (tenant_id, person_id, company_id, origin)
                      VALUES ($1, $2, $3, 'source_provided')`;
      for (const [person, company] of [
        [pb, ca],
        [pa, cb],
      ] as const) {
        await asApp(c, a, async (db) => {
          await expect(db.query(insert, [a.tenantId, person, company])).rejects.toMatchObject({
            code: '23503',
          });
        });
      }
      await asApp(c, a, async (db) => {
        await expect(db.query(insert, [b.tenantId, pb, cb])).rejects.toMatchObject({
          code: '42501',
        });
      });
      await asApp(c, a, async (db) => {
        expect((await db.query(`SELECT 1 FROM tenant_person_affiliations`)).rowCount).toBe(0);
        expect((await db.query(`SELECT 1 FROM person_affiliation_index`)).rowCount).toBe(0);
        const r = await db.query(
          `UPDATE tenant_person_affiliations SET role_codes = '{forged}' WHERE id = $1`,
          [bRow!.id],
        );
        expect(r.rowCount).toBe(0);
      });
      await asApp(c, a, async (db) => {
        await expect(
          db.query(
            `INSERT INTO tenant_entity_index (tenant_id, kind, entity_id) VALUES ($1, 'person_affiliation', $2)`,
            [a.tenantId, bRow!.id],
          ),
        ).rejects.toMatchObject({ code: '42501' });
      });
      expect((await affiliationsOf(c, b, pb))[0]!.role_codes).toEqual([]);
    });
  });

  describe('V12: affiliation read model', () => {
    it('by person or by company (active only on request), derived primary; one audited read per call; exactly one subject', async () => {
      const t = await c.tenant('affread', 1001);
      const ids = await companies(c, t, ['1301', '1302']);
      const p = (await observePerson(c, t, '13001', { links: [link('1301', true), link('1302')] }))
        .entityId!;
      const q = (await observePerson(c, t, '13002', { links: [link('1302', true)] })).entityId!;
      await observePerson(c, t, '13001', { links: [link('1301', true)] });
      const byPerson = await readModel().affiliations(
        await authz(t, 'data.account_structure.read'),
        {
          personId: p,
        },
      );
      expect(byPerson.map((v) => [v.companyId, v.status, v.isPrimary, v.endReason]).sort()).toEqual(
        [
          [ids['1301'], 'active', true, null],
          [ids['1302'], 'ended', false, 'source_removed'],
        ].sort(),
      );
      const byCompany = await readModel().affiliations(
        await authz(t, 'data.account_structure.read'),
        {
          companyId: ids['1302']!,
          activeOnly: true,
        },
      );
      expect(byCompany.map((v) => [v.personId, v.isPrimary])).toEqual([[q, true]]);
      for (const query of [{}, { personId: p, companyId: ids['1301']! }]) {
        await expect(
          readModel().affiliations(await authz(t, 'data.account_structure.read'), query),
        ).rejects.toMatchObject({ code: 'validation_failed' });
      }
      const reads = await auditOf(c, t, 'account_structure.read');
      expect(reads.map((e) => [e.outcome, e.target_kind, e.target_ref, e.details])).toEqual([
        ['allowed', 'person_affiliation', p, { subject: 'person', affiliations: 2 }],
        ['allowed', 'person_affiliation', ids['1302'], { subject: 'company', affiliations: 1 }],
        ['failed', 'person_affiliation', null, {}],
        ['failed', 'person_affiliation', null, {}],
      ]);
    });
  });

  describe('V13: privacy', () => {
    it('no name, email or role label in history, issues, change records, audit details or logs', async () => {
      const t = await c.tenant('affpriv', 1001);
      const logged: string[] = [];
      for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
        vi.spyOn(Logger.prototype, level).mockImplementation(((...args: unknown[]) => {
          for (const a of args) {
            try {
              logged.push(typeof a === 'string' ? a : JSON.stringify(a));
            } catch {
              logged.push(String(a));
            }
          }
        }) as never);
      }
      const PROBES = [
        'privacy.probe@school.example',
        'Probeforename',
        'Probesurname',
        'Chief Probe Officer',
      ];
      const ids = await companies(c, t, ['1401', '1402', '1403']);
      const p = (
        await observePerson(c, t, '14001', {
          email: PROBES[0],
          firstName: PROBES[1],
          lastName: PROBES[2],
          jobTitle: PROBES[3],
          links: [link('1401', true), link('1402'), link('1499')],
          affiliations: [
            { company: hs('1403'), roleCodes: ['champion'], startsAt: D('2026-01-01T00:00:00Z') },
          ],
        })
      ).entityId!;
      await observePerson(c, t, '14001', {
        email: PROBES[0],
        firstName: PROBES[1],
        lastName: PROBES[2],
        jobTitle: PROBES[3],
        links: [link('1401', true)],
        affiliations: [
          {
            company: hs('1403'),
            roleCodes: ['champion', 'user'],
            endsAt: D('2026-02-01T00:00:00Z'),
          },
        ],
      });
      const added = await add(t, { personId: p, companyId: ids['1402']!, roleCodes: ['sponsor'] });
      await end(t, added.affiliationId);
      await readModel().affiliations(await authz(t, 'data.account_structure.read'), {
        personId: p,
      });
      await mergeOf(t, 'company', '1401', ['1403']);

      const history = await historyOf(c, t, 'person_affiliation');
      expect(history.length).toBeGreaterThan(4);
      expect(
        history.every((h) => !h.values_recorded && h.old_value === null && h.new_value === null),
      ).toBe(true);
      const scanned = [
        JSON.stringify(history),
        JSON.stringify(await issuesOf(c, t)),
        JSON.stringify(
          await c.sql(
            `SELECT row_to_json(x) AS r FROM tenant_context_changes x WHERE tenant_id = $1 AND entity_kind = 'person_affiliation'`,
            [t.tenantId],
          ),
        ),
        JSON.stringify(
          await c.sql(`SELECT details FROM tenant_audit_events WHERE tenant_id = $1`, [t.tenantId]),
        ),
        JSON.stringify(
          await c.sql(
            `SELECT row_to_json(x) AS r FROM tenant_person_affiliations x WHERE tenant_id = $1`,
            [t.tenantId],
          ),
        ),
        ...logged,
      ].join('\n');
      expect((await issuesOf(c, t)).length).toBeGreaterThan(0);
      for (const probe of PROBES) expect(scanned, probe).not.toContain(probe);
    });
  });

  describe('V15: the 0.3 gate (affiliations)', () => {
    it('below 0.3 no affiliation is projected (persons.company_id unchanged) and operator entry is refused', async () => {
      const t = await c.tenant('affgate', 1001);
      await adoption().adopt(await authz(t, 'config.canonical.adopt'), {
        target: '0.2',
        expectedCurrent: '0.3',
      });
      const ids = await companies(c, t, ['1501', '1502']);
      const p = (await observePerson(c, t, '15001', { links: [link('1501', true), link('1502')] }))
        .entityId!;
      expect(await affiliationsOf(c, t, p)).toEqual([]);
      expect(await companyIdOfPerson(t, p)).toBe(ids['1501']);
      expect(await structureChangesOf(c, t, 'person_affiliation')).toEqual([]);
      await expect(add(t, { personId: p, companyId: ids['1501']! })).rejects.toMatchObject({
        code: 'canonical_version_too_low',
      });
      expect(
        (await auditOf(c, t, 'person.affiliation.add')).map((e) => [e.outcome, e.reason_code]),
      ).toEqual([['failed', 'canonical_version_too_low']]);
      // After adoption the next authoritative observation projects the links (no backfill needed).
      await adoption().adopt(await authz(t, 'config.canonical.adopt'), {
        target: '0.3',
        expectedCurrent: '0.2',
      });
      await observePerson(c, t, '15001', { links: [link('1501', true), link('1502')] });
      expect((await affiliationsOf(c, t, p)).map((r) => r.status)).toEqual(['active', 'active']);
    });
  });
});
