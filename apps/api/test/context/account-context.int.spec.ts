import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ExtensionValueWriter } from '../../src/modules/extension';
import { TenantDatabase, type TenantContext } from '../../src/modules/tenancy';
import {
  asApp,
  auditOf,
  companies,
  contact,
  hs,
  ingestMeta,
  observePerson,
  personIdOf,
} from '../support/account-structure';
import {
  AC_REASON,
  acChangesOf,
  acChangesOfKind,
  acHistoryOf,
  acIssuesOf as rawIssuesOf,
  acServices,
  contextOf,
  contextProductsOf,
  contextProvenance,
  contextsOf,
  contextTenant,
  defaultContextTypes,
  insertLine,
  lineContextOf,
  membersOf,
  observeContext,
  publishContextTypes,
  setModule,
} from '../support/account-context';
import { startContextHarness, type ContextHarness } from '../support/context';
import { field, publishExtension, sourceProvenance, valuesOf } from '../support/extension';
import { authz } from '../support/security';

/**
 * M10E AccountContext writers, line assignment, merges and reads on real
 * PostgreSQL as the app role (forced RLS), through the real harness app
 * (plan §4, §7, §10, §18 V7–V13, V17–V19, V23, V26, V27): the E3 pressure
 * scenario (one account, one product, two regions), natural-key idempotency,
 * dimension validation, 0..1 context per line with the same-account guard
 * (writer refusal + issue, and the deferred trigger for raw SQL), retirement
 * without cascade, person memberships (add / end / reactivate, never
 * deleted), product memberships (dimension + explicit), the human hold until
 * release (Q14), value history, company / person merges, secret-like and
 * email-like refusals, module disable after use (reads kept, writes
 * refused), and extension values / `extension_ref` dimensions on contexts.
 * Synthetic types, dimensions and values only.
 */
describe('M10E AccountContext (writers, lines, merges, reads)', () => {
  let c: ContextHarness;

  beforeAll(async () => {
    c = await startContextHarness();
  });
  afterAll(async () => {
    await c?.close();
  });

  const s = () => acServices(c);
  const human = (t: TenantContext) => authz(t, 'canonical.human_entry');
  const reader = (t: TenantContext) => authz(t, 'data.account_context.read');
  const db = () => c.app.get(TenantDatabase);
  const merge = async (
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
  /** Source line assignment inside a tenant transaction (the sync path's call). */
  const assignFromSource = async (t: TenantContext, lineId: string, contextId: string | null) => {
    const actx = await authz(t, 'canonical.source_sync');
    return db().transaction(t, (tx) =>
      s().writer.assignLineFromSource(actx, tx, {
        lineId,
        contextId,
        provenance: contextProvenance(`line-${lineId}`),
        issueRefs: [`hubspot:line_items:line-${lineId}`],
      }),
    );
  };
  /** Issues with order-insensitive canonical ids (sorted). */
  const acIssuesOf = async (t: TenantContext, kind: string) =>
    (await rawIssuesOf(c, t, kind)).map((i) => ({
      ...i,
      canonical_ids: [...i.canonical_ids].sort(),
    }));
  const sorted = (ids: string[]) => [...ids].sort();
  const token = `ghp_${'A1b2C3d4E5'.repeat(4)}`;

  describe('V7 / V8 / V9: natural key, idempotency and dimension validation', () => {
    it('V7: the same account and product in two regions are two contexts with distinct natural keys', async () => {
      const t = await contextTenant(c, 'acpress');
      const account = (await companies(c, t, ['7001']))['7001']!;
      const emea = await observeContext(c, t, {
        companyId: account,
        record: 'rel-emea',
        dimensions: { product: 'core', region: 'emea' },
        name: 'Core EMEA',
      });
      const amer = await observeContext(c, t, {
        companyId: account,
        record: 'rel-amer',
        dimensions: { product: 'core', region: 'amer' },
        name: 'Core AMER',
      });
      const other = await observeContext(c, t, {
        companyId: account,
        record: 'rel-analytics-emea',
        dimensions: { product: 'analytics', region: 'emea' },
        name: 'Analytics EMEA',
      });
      expect([emea.status, amer.status, other.status]).toEqual(['created', 'created', 'created']);
      const rows = await contextsOf(c, t, account);
      expect(rows).toHaveLength(3);
      expect(new Set(rows.map((r) => r.natural_key_hash)).size).toBe(3);
      for (const r of rows) {
        expect(r.natural_key_hash).toMatch(/^[0-9a-f]{64}$/);
        expect(r).toMatchObject({
          company_id: account,
          type_key: 'product_region',
          status: 'active',
          record_state: 'active',
        });
      }
      expect(rows.map((r) => r.dimensions)).toEqual([
        { product: 'core', region: 'emea' },
        { product: 'core', region: 'amer' },
        { product: 'analytics', region: 'emea' },
      ]);
      // Product-dimension memberships follow the product dimension (origin `dimension`).
      expect(await contextProductsOf(c, t)).toEqual(
        expect.arrayContaining([
          { context_id: emea.contextId, product_key: 'core', origin: 'dimension' },
          { context_id: amer.contextId, product_key: 'core', origin: 'dimension' },
          { context_id: other.contextId, product_key: 'analytics', origin: 'dimension' },
        ]),
      );
      expect(await contextProductsOf(c, t)).toHaveLength(3);
      // One `created` change record each; a source reference of kind account_context each.
      const created = await acChangesOf(c, t, emea.contextId!);
      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({
        entity_kind: 'account_context',
        change_type: 'created',
        source_system: 'hubspot',
        source_object_type: 'relationships',
        canonical_version: '0.5',
      });
      const refs = await c.sql<{ entity_id: string; external_id: string }>(
        `SELECT entity_id::text, external_id FROM tenant_source_references
          WHERE tenant_id = $1 AND entity_kind = 'account_context' ORDER BY external_id`,
        [t.tenantId],
      );
      expect(refs.map((r) => [r.external_id, r.entity_id])).toEqual([
        ['rel-amer', amer.contextId],
        ['rel-analytics-emea', other.contextId],
        ['rel-emea', emea.contextId],
      ]);
      // The database refuses a second active context with the same natural key (guard trigger).
      const [row] = rows;
      await expect(
        asApp(c, t, (db) =>
          db.query(
            `INSERT INTO tenant_account_contexts (tenant_id, company_id, context_type_id, natural_key_hash, dimensions, name)
             SELECT tenant_id, company_id, context_type_id, natural_key_hash, dimensions, 'dup'
               FROM tenant_account_contexts WHERE id = $1`,
            [row!.id],
          ),
        ),
      ).rejects.toThrow(/account_context_natural_key_exists/);
    });

    it('V8: a re-sync updates, never duplicates — by reference and by natural key; dimensions are immutable per reference', async () => {
      const t = await contextTenant(c, 'acidem');
      const account = (await companies(c, t, ['7101']))['7101']!;
      const first = await observeContext(c, t, {
        companyId: account,
        record: 'rel-1',
        dimensions: { product: 'core', region: 'emea' },
        name: 'Desk one',
      });
      expect(first.status).toBe('created');
      // Same observation again: unchanged, no new change record.
      expect(
        await observeContext(c, t, {
          companyId: account,
          record: 'rel-1',
          dimensions: { product: 'core', region: 'emea' },
          name: 'Desk one',
        }),
      ).toEqual({ status: 'unchanged', contextId: first.contextId });
      expect(await acChangesOf(c, t, first.contextId!)).toHaveLength(1);
      // A changed attribute updates the same row.
      expect(
        await observeContext(c, t, {
          companyId: account,
          record: 'rel-1',
          dimensions: { product: 'core', region: 'emea' },
          name: 'Desk one renamed',
        }),
      ).toEqual({ status: 'updated', contextId: first.contextId });
      // A second source record with the same natural key resolves to the same context.
      expect(
        await observeContext(c, t, {
          companyId: account,
          record: 'rel-1-copy',
          dimensions: { region: 'emea', product: 'core' },
          name: 'Desk one renamed',
        }),
      ).toEqual({ status: 'unchanged', contextId: first.contextId });
      // Dimensions of a known reference cannot change (that would be another context).
      expect(
        await observeContext(c, t, {
          companyId: account,
          record: 'rel-1',
          dimensions: { product: 'core', region: 'apac' },
          name: 'Desk one renamed',
        }),
      ).toEqual({ status: 'rejected', reason: 'dimensions_immutable' });
      // Operator write by natural key (account + type + dimensions) updates the same context.
      const written = await s().writer.write(await human(t), {
        account,
        type: 'product_region',
        dimensions: { product: 'core', region: 'emea' },
        ownerRef: 'owner-42',
        reason: AC_REASON,
      });
      expect(written).toMatchObject({
        contextId: first.contextId,
        created: false,
        changed: true,
      });
      // An absent observation is recorded on the reference only: the context stays.
      expect(
        await observeContext(c, t, {
          companyId: account,
          record: 'rel-1',
          dimensions: {},
          presence: 'absent',
        }),
      ).toEqual({ status: 'unchanged', contextId: first.contextId });
      const rows = await contextsOf(c, t);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        name: 'Desk one renamed',
        owner_ref: 'owner-42',
        status: 'active',
      });
    });

    it('V9: missing required, unknown key, unknown code, unknown / retired product and wrong type are refused; nothing is written', async () => {
      const t = await contextTenant(c, 'acdims');
      const account = (await companies(c, t, ['7201']))['7201']!;
      const refused = async (dimensions: Record<string, unknown>, extra = {}) =>
        observeContext(c, t, {
          companyId: account,
          record: `rel-${Object.values(dimensions).join('-')}`,
          dimensions,
          name: 'Refused',
          ...extra,
        });
      expect(await refused({ product: 'core' })).toEqual({
        status: 'rejected',
        reason: 'dimension_required',
      });
      expect(await refused({ product: 'core', region: 'emea', colour: 'red' })).toEqual({
        status: 'rejected',
        reason: 'dimension_unknown',
      });
      expect(await refused({ product: 'core', region: 'latam' })).toEqual({
        status: 'rejected',
        reason: 'code_unknown',
      });
      expect(await refused({ product: 'nosuch', region: 'emea' })).toEqual({
        status: 'rejected',
        reason: 'product_unknown',
      });
      expect(await refused({ product: 'legacy', region: 'emea' })).toEqual({
        status: 'rejected',
        reason: 'product_retired',
      });
      expect(await refused({ product: 42, region: 'emea' })).toEqual({
        status: 'rejected',
        reason: 'dimension_invalid',
      });
      expect(await refused({ product: 'core', region: 'emea', segment: 'x'.repeat(201) })).toEqual({
        status: 'rejected',
        reason: 'dimension_invalid',
      });
      expect(await refused({ region: 'emea' }, { type: 'nosuch_type' })).toEqual({
        status: 'rejected',
        reason: 'type_unknown',
      });
      // A new context needs a name.
      expect(
        await observeContext(c, t, {
          companyId: account,
          record: 'rel-noname',
          dimensions: { product: 'core', region: 'emea' },
        }),
      ).toEqual({ status: 'rejected', reason: 'name_required' });
      // Operator: the refused dimension is named (key and code only).
      await expect(
        s().writer.write(await human(t), {
          account,
          type: 'product_region',
          dimensions: { product: 'core', region: 'latam' },
          name: 'Refused',
          reason: AC_REASON,
        }),
      ).rejects.toMatchObject({
        code: 'validation_failed',
        detail: { dimension: 'region', code: 'code_unknown' },
      });
      expect((await auditOf(c, t, 'account_context.write')).at(-1)).toMatchObject({
        outcome: 'failed',
        reason_code: 'validation_failed',
      });
      expect(await contextsOf(c, t)).toEqual([]);
    });
  });

  describe('V10 / V11: line assignment and retirement', () => {
    it('V10: 0..1 context per line; a line of another account is refused with an issue; the deferred guard refuses raw SQL', async () => {
      const t = await contextTenant(c, 'aclines');
      const ids = await companies(c, t, ['7301', '7302']);
      const [a, b] = [ids['7301']!, ids['7302']!];
      const ctxA = (
        await observeContext(c, t, {
          companyId: a,
          record: 'rel-a',
          dimensions: { product: 'core', region: 'emea' },
          name: 'A EMEA',
        })
      ).contextId!;
      const ctxA2 = (
        await observeContext(c, t, {
          companyId: a,
          record: 'rel-a2',
          dimensions: { product: 'core', region: 'amer' },
          name: 'A AMER',
        })
      ).contextId!;
      const ctxB = (
        await observeContext(c, t, {
          companyId: b,
          record: 'rel-b',
          dimensions: { product: 'core', region: 'emea' },
          name: 'B EMEA',
        })
      ).contextId!;
      const lineA = await insertLine(c, t, a);
      // Operator: assign, re-assign (still one context), unchanged, clear.
      expect(
        await s().writer.assignLine(await human(t), {
          line: lineA,
          context: ctxA,
          reason: AC_REASON,
        }),
      ).toEqual({ lineId: lineA, contextId: ctxA, changed: true });
      expect((await lineContextOf(c, t, lineA)).context_id).toBe(ctxA);
      await s().writer.assignLine(await human(t), {
        line: lineA,
        context: ctxA2,
        reason: AC_REASON,
      });
      expect((await lineContextOf(c, t, lineA)).context_id).toBe(ctxA2);
      expect(
        await s().writer.assignLine(await human(t), {
          line: lineA,
          context: ctxA2,
          reason: AC_REASON,
        }),
      ).toMatchObject({ changed: false });
      // Another account's context: refused (audited), the line keeps its context.
      await expect(
        s().writer.assignLine(await human(t), { line: lineA, context: ctxB, reason: AC_REASON }),
      ).rejects.toMatchObject({ code: 'validation_failed' });
      expect((await auditOf(c, t, 'account_context.line.assign')).at(-1)).toMatchObject({
        outcome: 'failed',
        reason_code: 'validation_failed',
      });
      expect((await lineContextOf(c, t, lineA)).context_id).toBe(ctxA2);
      // Source path: the mismatch opens an issue (identifiers only); a good assignment resolves it.
      expect(await assignFromSource(t, lineA, ctxB)).toBe('company_mismatch');
      expect((await lineContextOf(c, t, lineA)).context_id).toBe(ctxA2);
      expect(await acIssuesOf(t, 'account_context_company_mismatch')).toEqual([
        {
          kind: 'account_context_company_mismatch',
          entity_kind: 'account_context',
          state: 'open',
          canonical_ids: sorted([lineA, ctxB]),
          external_refs: [`hubspot:line_items:line-${lineA}`],
        },
      ]);
      expect(await assignFromSource(t, lineA, ctxA)).toBe('assigned');
      expect((await acIssuesOf(t, 'account_context_company_mismatch'))[0]!.state).not.toBe('open');
      // Clearing: null.
      await s().writer.assignLine(await human(t), {
        line: lineA,
        context: null,
        reason: AC_REASON,
      });
      expect((await lineContextOf(c, t, lineA)).context_id).toBeNull();
      // Raw SQL as the app role: the deferred constraint trigger refuses at commit, both directions.
      await expect(
        asApp(
          c,
          t,
          (db) =>
            db.query(`UPDATE tenant_subscriptions SET context_id = $1 WHERE id = $2`, [
              ctxB,
              lineA,
            ]),
          { commit: true },
        ),
      ).rejects.toThrow(/account_context_company_mismatch/);
      // Moving a context with a line to another account (b has no AMER context): refused at commit.
      await s().writer.assignLine(await human(t), {
        line: lineA,
        context: ctxA2,
        reason: AC_REASON,
      });
      await expect(
        asApp(
          c,
          t,
          (db) =>
            db.query(`UPDATE tenant_account_contexts SET company_id = $1 WHERE id = $2`, [
              b,
              ctxA2,
            ]),
          { commit: true },
        ),
      ).rejects.toThrow(/account_context_company_mismatch/);
      expect(await lineContextOf(c, t, lineA)).toEqual({ context_id: ctxA2, company_id: a });
      expect((await contextOf(c, t, ctxA2)).company_id).toBe(a);
    });

    it('V11: retirement never cascades to the account, lines or members; new assignments, members and products are refused; reactivate restores', async () => {
      const t = await contextTenant(c, 'acretire');
      const account = (await companies(c, t, ['7401']))['7401']!;
      await observePerson(c, t, '7451');
      const person = await personIdOf(c, t, '7451');
      const ctx = (
        await observeContext(c, t, {
          companyId: account,
          record: 'rel-r',
          dimensions: { product: 'core', region: 'emea' },
          name: 'Retiring',
        })
      ).contextId!;
      const line1 = await insertLine(c, t, account);
      const line2 = await insertLine(c, t, account, 'analytics');
      await s().writer.assignLine(await human(t), { line: line1, context: ctx, reason: AC_REASON });
      await s().members.add(await human(t), {
        context: ctx,
        person,
        role: 'csm',
        reason: AC_REASON,
      });
      const [companyBefore] = await c.sql(
        `SELECT name, record_state, updated_at FROM companies WHERE tenant_id = $1 AND id = $2`,
        [t.tenantId, account],
      );
      expect(
        await s().writer.retire(await human(t), { context: ctx, reason: AC_REASON }),
      ).toMatchObject({ contextId: ctx, status: 'retired', changed: true });
      expect((await auditOf(c, t, 'account_context.retire')).at(-1)).toMatchObject({
        outcome: 'allowed',
        target_kind: 'account_context',
        target_ref: ctx,
      });
      // No cascade: the line keeps its context, the member stays active, the account is untouched.
      expect((await lineContextOf(c, t, line1)).context_id).toBe(ctx);
      expect((await membersOf(c, t, ctx)).map((m) => m.status)).toEqual(['active']);
      expect(
        await c.sql(
          `SELECT name, record_state, updated_at FROM companies WHERE tenant_id = $1 AND id = $2`,
          [t.tenantId, account],
        ),
      ).toEqual([companyBefore]);
      expect(await contextOf(c, t, ctx)).toMatchObject({
        status: 'retired',
        record_state: 'active',
      });
      // New assignment / member / explicit product refused.
      await expect(
        s().writer.assignLine(await human(t), { line: line2, context: ctx, reason: AC_REASON }),
      ).rejects.toMatchObject({ code: 'validation_failed' });
      expect(await assignFromSource(t, line2, ctx)).toBe('not_assignable');
      expect((await lineContextOf(c, t, line2)).context_id).toBeNull();
      await expect(
        s().members.add(await human(t), {
          context: ctx,
          person,
          role: 'champion',
          reason: AC_REASON,
        }),
      ).rejects.toMatchObject({ code: 'validation_failed' });
      await expect(
        s().members.addProduct(await human(t), {
          context: ctx,
          product: 'analytics',
          reason: AC_REASON,
        }),
      ).rejects.toMatchObject({ code: 'validation_failed' });
      // The database also refuses a new assignment to a retired context.
      await expect(
        asApp(
          c,
          t,
          (db) =>
            db.query(`UPDATE tenant_subscriptions SET context_id = $1 WHERE id = $2`, [ctx, line2]),
          { commit: true },
        ),
      ).rejects.toThrow(/account_context_not_assignable/);
      // The source cannot un-retire (retired is terminal for the source).
      await observeContext(c, t, {
        companyId: account,
        record: 'rel-r',
        dimensions: { product: 'core', region: 'emea' },
        status: 'active',
      });
      expect((await contextOf(c, t, ctx)).status).toBe('retired');
      // Reactivate (audited as a write): assignment works again.
      expect(
        await s().writer.reactivate(await human(t), { context: ctx, reason: AC_REASON }),
      ).toMatchObject({ status: 'active', changed: true });
      expect((await auditOf(c, t, 'account_context.write')).at(-1)).toMatchObject({
        outcome: 'allowed',
        details: expect.objectContaining({ operation: 'reactivate' }),
      });
      await s().writer.assignLine(await human(t), { line: line2, context: ctx, reason: AC_REASON });
      expect((await lineContextOf(c, t, line2)).context_id).toBe(ctx);
    });
  });

  describe('V12 / V13: person and product memberships', () => {
    it('V12: add / end / re-add (reactivation), role validated, never deleted; change records per membership', async () => {
      const t = await contextTenant(c, 'acmembers');
      const account = (await companies(c, t, ['7501']))['7501']!;
      await observePerson(c, t, '7551');
      const person = await personIdOf(c, t, '7551');
      const ctx = (
        await observeContext(c, t, {
          companyId: account,
          record: 'rel-m',
          dimensions: { product: 'core', region: 'emea' },
          name: 'Members',
        })
      ).contextId!;
      const member = async (op: 'add' | 'end', role = 'csm') =>
        s().members[op](await human(t), { context: ctx, person, role, reason: AC_REASON });
      expect(await member('add')).toMatchObject({ outcome: 'added', changed: true });
      expect(await member('add')).toMatchObject({ outcome: 'unchanged', changed: false });
      // A second role for the same person is its own membership.
      expect(await member('add', 'champion')).toMatchObject({ outcome: 'added' });
      // A role not in the type's member_roles is refused (audited).
      await expect(member('add', 'buyer')).rejects.toMatchObject({ code: 'validation_failed' });
      expect((await auditOf(c, t, 'account_context.member.set')).at(-1)).toMatchObject({
        outcome: 'failed',
        reason_code: 'validation_failed',
      });
      await expect(member('add', 'Not A Code')).rejects.toMatchObject({
        code: 'validation_failed',
      });
      expect(await member('end')).toMatchObject({ outcome: 'ended', changed: true });
      let rows = await membersOf(c, t, ctx);
      const csm = rows.find((r) => r.role_code === 'csm')!;
      expect(csm.status).toBe('ended');
      expect(csm.ended_at).not.toBeNull();
      expect(csm.ended_at!.getTime()).toBeGreaterThanOrEqual(csm.started_at.getTime());
      // Ending again is a no-op (unchanged); re-adding reactivates the same row.
      expect(await member('end')).toMatchObject({ outcome: 'unchanged' });
      expect(await member('add')).toMatchObject({ outcome: 'reactivated', changed: true });
      rows = await membersOf(c, t, ctx);
      expect(rows).toHaveLength(2);
      expect(rows.find((r) => r.role_code === 'csm')).toMatchObject({
        status: 'active',
        ended_at: null,
      });
      // Change records of kind account_context_person: created ×2, ended, reactivated.
      const changes = await acChangesOfKind(c, t, 'account_context_person');
      expect(changes.map((ch) => ch.change_type)).toEqual([
        'created',
        'created',
        'state_changed',
        'state_changed',
      ]);
      expect(changes.every((ch) => ch.origin === 'human')).toBe(true);
      // An unknown person is refused; the app role cannot delete a membership.
      await expect(
        s().members.add(await human(t), {
          context: ctx,
          person: '00000000-0000-4000-8000-000000000001',
          role: 'csm',
          reason: AC_REASON,
        }),
      ).rejects.toMatchObject({ code: 'validation_failed' });
      await expect(
        asApp(c, t, (db) => db.query(`DELETE FROM tenant_account_context_persons`)),
      ).rejects.toThrow(/permission denied/);
      expect(await membersOf(c, t, ctx)).toHaveLength(2);
    });

    it('V13: product memberships from product dimensions and explicit ones only when allow_products (active products)', async () => {
      const t = await contextTenant(c, 'acproducts');
      const account = (await companies(c, t, ['7601']))['7601']!;
      const ctx = (
        await observeContext(c, t, {
          companyId: account,
          record: 'rel-p',
          dimensions: { product: 'core', region: 'emea' },
          name: 'Products',
        })
      ).contextId!;
      const desk = (
        await s().writer.write(await human(t), {
          account,
          type: 'deal_desk',
          dimensions: { region: 'emea' },
          name: 'Desk',
          reason: AC_REASON,
        })
      ).contextId;
      const addProduct = async (context: string, product: string) =>
        s().members.addProduct(await human(t), { context, product, reason: AC_REASON });
      expect(await addProduct(ctx, 'analytics')).toMatchObject({
        outcome: 'product_added',
        changed: true,
      });
      expect(await addProduct(ctx, 'analytics')).toMatchObject({
        outcome: 'product_unchanged',
        changed: false,
      });
      // The dimension product is already a member: explicit add of it changes nothing.
      expect(await addProduct(ctx, 'core')).toMatchObject({ changed: false });
      await expect(addProduct(ctx, 'legacy')).rejects.toMatchObject({ code: 'validation_failed' });
      await expect(addProduct(ctx, 'nosuch')).rejects.toMatchObject({ code: 'validation_failed' });
      // deal_desk does not allow explicit products.
      await expect(addProduct(desk, 'core')).rejects.toMatchObject({ code: 'validation_failed' });
      expect(await contextProductsOf(c, t)).toEqual([
        { context_id: ctx, product_key: 'analytics', origin: 'explicit' },
        { context_id: ctx, product_key: 'core', origin: 'dimension' },
      ]);
      const changes = await acChangesOf(c, t, ctx);
      expect(changes.filter((ch) => ch.changed_fields.includes('products'))).toHaveLength(1);
    });
  });

  describe('V17 / V18: human hold until release; value history', () => {
    it('V17: an operator value is sticky (source disagreement recorded as an issue) until release; then the source applies', async () => {
      const t = await contextTenant(c, 'achold');
      const account = (await companies(c, t, ['7701']))['7701']!;
      const obs = (over: Record<string, unknown>) =>
        observeContext(c, t, {
          companyId: account,
          record: 'rel-h',
          dimensions: { product: 'core', region: 'emea' },
          ...over,
        });
      const ctx = (await obs({ name: 'Source name', ownerRef: 'owner-1' })).contextId!;
      await s().writer.write(await human(t), {
        context: ctx,
        name: 'Operator name',
        reason: AC_REASON,
      });
      // The source disagrees on the held name; the unheld owner applies.
      expect(await obs({ name: 'Source name 2', ownerRef: 'owner-2' })).toEqual({
        status: 'updated',
        contextId: ctx,
        humanOverride: 1,
      });
      expect(await contextOf(c, t, ctx)).toMatchObject({
        name: 'Operator name',
        owner_ref: 'owner-2',
      });
      expect(await acIssuesOf(t, 'account_context_human_override_disagrees')).toEqual([
        {
          kind: 'account_context_human_override_disagrees',
          entity_kind: 'account_context',
          state: 'open',
          canonical_ids: sorted([ctx]),
          external_refs: ['hubspot:relationships:rel-h'],
        },
      ]);
      // Release: values unchanged until the next observation; the issue is resolved.
      expect(
        await s().writer.release(await human(t), { context: ctx, reason: AC_REASON }),
      ).toMatchObject({ contextId: ctx, changed: true, released: 1 });
      expect((await auditOf(c, t, 'account_context.release')).at(-1)).toMatchObject({
        outcome: 'allowed',
        target_ref: ctx,
      });
      expect((await contextOf(c, t, ctx)).name).toBe('Operator name');
      expect((await acIssuesOf(t, 'account_context_human_override_disagrees'))[0]!.state).not.toBe(
        'open',
      );
      const release = (await acChangesOf(c, t, ctx)).at(-1)!;
      expect(release).toMatchObject({ changed_fields: ['humanOverride'], origin: 'human' });
      expect(await obs({ name: 'Source name 3' })).toEqual({ status: 'updated', contextId: ctx });
      expect((await contextOf(c, t, ctx)).name).toBe('Source name 3');
      // A second release with nothing held changes nothing.
      expect(
        await s().writer.release(await human(t), { context: ctx, reason: AC_REASON }),
      ).toMatchObject({ changed: false, released: 0 });
    });

    it('V18: value history on owner_ref / status and on the line context_id (old and new values, actor kind)', async () => {
      const t = await contextTenant(c, 'achist');
      const account = (await companies(c, t, ['7801']))['7801']!;
      const ctx = (
        await observeContext(c, t, {
          companyId: account,
          record: 'rel-v',
          dimensions: { product: 'core', region: 'emea' },
          name: 'History',
          ownerRef: 'owner-a',
        })
      ).contextId!;
      await observeContext(c, t, {
        companyId: account,
        record: 'rel-v',
        dimensions: { product: 'core', region: 'emea' },
        ownerRef: 'owner-b',
        status: 'inactive',
      });
      await s().writer.retire(await human(t), { context: ctx, reason: AC_REASON });
      const h = (await acHistoryOf(c, t, 'account_context', ctx)).map((r) => [
        r.field,
        r.old_value,
        r.new_value,
      ]);
      expect(h).toEqual([
        ['owner_ref', null, 'owner-a'],
        ['status', null, 'active'],
        ['owner_ref', 'owner-a', 'owner-b'],
        ['status', 'active', 'inactive'],
        ['status', 'inactive', 'retired'],
      ]);
      // The name is not a history field.
      expect(
        (await acHistoryOf(c, t, 'account_context', ctx)).some((r) => r.field === 'name'),
      ).toBe(false);
      await s().writer.reactivate(await human(t), { context: ctx, reason: AC_REASON });
      const line = await insertLine(c, t, account);
      await s().writer.assignLine(await human(t), { line, context: ctx, reason: AC_REASON });
      await s().writer.assignLine(await human(t), { line, context: null, reason: AC_REASON });
      const lh = await acHistoryOf(c, t, 'subscription', line);
      expect(lh.map((r) => [r.field, r.old_value, r.new_value, r.actor_kind])).toEqual([
        ['context_id', null, ctx, 'operator'],
        ['context_id', ctx, null, 'operator'],
      ]);
      // Each history row points at the change record of its write.
      const changeIds = new Set((await acChangesOf(c, t, line)).map((ch) => ch.id));
      for (const r of lh) expect(changeIds.has(r.change_id)).toBe(true);
    });
  });

  describe('V19: merges', () => {
    it('company merge: the loser contexts are re-pointed; a natural-key collision merges contexts (members, products, lines move; issue)', async () => {
      const t = await contextTenant(c, 'acmergeco');
      const ids = await companies(c, t, ['7901', '7902']);
      const [loser, survivor] = [ids['7901']!, ids['7902']!];
      await observePerson(c, t, '7951');
      await observePerson(c, t, '7952');
      const [p1, p2] = [await personIdOf(c, t, '7951'), await personIdOf(c, t, '7952')];
      const ctxOf = async (companyId: string, record: string, region: string, product = 'core') =>
        (
          await observeContext(c, t, {
            companyId,
            record,
            dimensions: { product, region },
            name: `${record}`,
          })
        ).contextId!;
      const loserOnly = await ctxOf(loser, 'rel-l-amer', 'amer');
      const loserDup = await ctxOf(loser, 'rel-l-emea', 'emea');
      const survivorDup = await ctxOf(survivor, 'rel-s-emea', 'emea');
      await s().members.addProduct(await human(t), {
        context: loserDup,
        product: 'reporting',
        reason: AC_REASON,
      });
      for (const [context, person, role] of [
        [loserDup, p1, 'csm'],
        [loserDup, p2, 'champion'],
        [survivorDup, p2, 'champion'],
      ] as const) {
        await s().members.add(await human(t), { context, person, role, reason: AC_REASON });
      }
      const lineOnly = await insertLine(c, t, loser);
      const lineDup = await insertLine(c, t, loser);
      await s().writer.assignLine(await human(t), {
        line: lineOnly,
        context: loserOnly,
        reason: AC_REASON,
      });
      await s().writer.assignLine(await human(t), {
        line: lineDup,
        context: loserDup,
        reason: AC_REASON,
      });

      await merge(t, 'company', '7902', ['7901']);

      // Re-pointed: same id, now on the survivor; its line moved with the account.
      expect(await contextOf(c, t, loserOnly)).toMatchObject({
        company_id: survivor,
        record_state: 'active',
      });
      expect(await lineContextOf(c, t, lineOnly)).toEqual({
        context_id: loserOnly,
        company_id: survivor,
      });
      // Collision: the loser context is merged into the survivor's (terminal, kept).
      expect(await contextOf(c, t, loserDup)).toMatchObject({
        record_state: 'merged',
        merged_into_id: survivorDup,
      });
      expect(await lineContextOf(c, t, lineDup)).toEqual({
        context_id: survivorDup,
        company_id: survivor,
      });
      const survivorMembers = (await membersOf(c, t, survivorDup)).map((m) => [
        m.person_id,
        m.role_code,
        m.status,
      ]);
      expect(survivorMembers).toEqual(
        expect.arrayContaining([
          [p1, 'csm', 'active'],
          [p2, 'champion', 'active'],
        ]),
      );
      expect(survivorMembers).toHaveLength(2);
      expect((await membersOf(c, t, loserDup)).every((m) => m.status === 'ended')).toBe(true);
      expect(
        (await contextProductsOf(c, t, survivorDup)).map((p) => [p.product_key, p.origin]),
      ).toEqual([
        ['core', 'dimension'],
        ['reporting', 'explicit'],
      ]);
      expect(await acIssuesOf(t, 'account_context_merge_collision')).toEqual([
        {
          kind: 'account_context_merge_collision',
          entity_kind: 'account_context',
          state: 'open',
          canonical_ids: sorted([loserDup, survivorDup, loser, survivor]),
          external_refs: [],
        },
      ]);
      expect((await acChangesOf(c, t, loserDup)).at(-1)).toMatchObject({
        change_type: 'merged',
        changed_fields: ['recordState', 'mergedIntoId'],
      });
      expect(
        (await acHistoryOf(c, t, 'subscription', lineDup)).map((r) => [r.old_value, r.new_value]),
      ).toContainEqual([loserDup, survivorDup]);
      // The source reference of the merged context resolves to the survivor context on re-sync.
      expect(
        await observeContext(c, t, {
          companyId: survivor,
          record: 'rel-l-emea',
          dimensions: { product: 'core', region: 'emea' },
          name: 'rel-s-emea',
        }),
      ).toMatchObject({ contextId: survivorDup });
      // A merged context is not assignable and its members cannot be written.
      await expect(
        s().writer.write(await human(t), { context: loserDup, name: 'x', reason: AC_REASON }),
      ).rejects.toMatchObject({ code: 'validation_failed' });
    });

    it('person merge: memberships move to the survivor; a duplicate role is ended on the loser', async () => {
      const t = await contextTenant(c, 'acmergep');
      const account = (await companies(c, t, ['8001']))['8001']!;
      await observePerson(c, t, '8051');
      await observePerson(c, t, '8052');
      const [loser, survivor] = [await personIdOf(c, t, '8051'), await personIdOf(c, t, '8052')];
      const ctx = (
        await observeContext(c, t, {
          companyId: account,
          record: 'rel-pm',
          dimensions: { product: 'core', region: 'emea' },
          name: 'Person merge',
        })
      ).contextId!;
      for (const [person, role] of [
        [loser, 'csm'],
        [loser, 'champion'],
        [survivor, 'champion'],
      ] as const) {
        await s().members.add(await human(t), { context: ctx, person, role, reason: AC_REASON });
      }
      await merge(t, 'person', '8052', ['8051']);
      const rows = (await membersOf(c, t, ctx)).map((m) => [m.person_id, m.role_code, m.status]);
      expect(rows).toEqual(
        expect.arrayContaining([
          [survivor, 'csm', 'active'],
          [survivor, 'champion', 'active'],
          [loser, 'csm', 'ended'],
          [loser, 'champion', 'ended'],
        ]),
      );
      expect(rows).toHaveLength(4);
      // The merged person can no longer be added.
      await expect(
        s().members.add(await human(t), {
          context: ctx,
          person: loser,
          role: 'csm',
          reason: AC_REASON,
        }),
      ).rejects.toMatchObject({ code: 'validation_failed' });
    });
  });

  describe('V23: secret-like and email-like values', () => {
    it('refused in name, dimensions and owner_ref (source and operator); email-like owner_ref refused, also by the database', async () => {
      const t = await contextTenant(c, 'acsecret');
      const account = (await companies(c, t, ['8101']))['8101']!;
      const obs = (over: Record<string, unknown>, record = 'rel-s') =>
        observeContext(c, t, {
          companyId: account,
          record,
          dimensions: { product: 'core', region: 'emea' },
          name: 'Clean',
          ...over,
        });
      expect(await obs({ name: `Desk ${token}` })).toEqual({
        status: 'rejected',
        reason: 'name_invalid',
      });
      expect(
        await obs({ dimensions: { product: 'core', region: 'emea', segment: token } }),
      ).toEqual({ status: 'rejected', reason: 'secret_like_value' });
      expect(await obs({ ownerRef: token })).toEqual({
        status: 'rejected',
        reason: 'owner_ref_invalid',
      });
      expect(await obs({ ownerRef: 'jane.doe@example.com' })).toEqual({
        status: 'rejected',
        reason: 'owner_ref_invalid',
      });
      expect(await contextsOf(c, t)).toEqual([]);
      // Operator: an audited denial (no value in the audit trail).
      await expect(
        s().writer.write(await human(t), {
          account,
          type: 'product_region',
          dimensions: { product: 'core', region: 'emea' },
          name: `Desk ${token}`,
          reason: AC_REASON,
        }),
      ).rejects.toMatchObject({ name: 'SecretLikeValueError' });
      await expect(
        s().writer.write(await human(t), {
          account,
          type: 'product_region',
          dimensions: { product: 'core', region: 'emea', segment: token },
          name: 'Clean',
          reason: AC_REASON,
        }),
      ).rejects.toMatchObject({ name: 'SecretLikeValueError' });
      const denied = (await auditOf(c, t)).filter((a) => a.reason_code === 'secret_like_value');
      expect(denied).toHaveLength(2);
      expect(denied[0]).toMatchObject({
        outcome: 'denied',
        action: 'account_context.write',
        target_kind: 'account_context',
      });
      await expect(
        s().writer.write(await human(t), {
          account,
          type: 'product_region',
          dimensions: { product: 'core', region: 'emea' },
          name: 'Clean',
          ownerRef: 'jane.doe@example.com',
          reason: AC_REASON,
        }),
      ).rejects.toMatchObject({ code: 'validation_failed' });
      expect(JSON.stringify(await auditOf(c, t))).not.toContain(token);
      expect(JSON.stringify(await auditOf(c, t))).not.toContain('jane.doe');
      expect(await contextsOf(c, t)).toEqual([]);
      // The database refuses an email-like owner_ref and secret-like dimension keys (CHECKs).
      const ctx = (await obs({}, 'rel-ok')).contextId!;
      await expect(
        asApp(c, t, (db) =>
          db.query(
            `UPDATE tenant_account_contexts SET owner_ref = 'jane.doe@example.com' WHERE id = $1`,
            [ctx],
          ),
        ),
      ).rejects.toThrow(/check constraint/);
    });
  });

  describe('V26: module disabled after use', () => {
    it('reads keep working, every write is refused (audited), data is kept; re-enabling restores writes', async () => {
      const t = await contextTenant(c, 'acdisable');
      const account = (await companies(c, t, ['8201']))['8201']!;
      await observePerson(c, t, '8251');
      const person = await personIdOf(c, t, '8251');
      const ctx = (
        await observeContext(c, t, {
          companyId: account,
          record: 'rel-d',
          dimensions: { product: 'core', region: 'emea' },
          name: 'Kept',
        })
      ).contextId!;
      const line = await insertLine(c, t, account);
      await s().members.add(await human(t), {
        context: ctx,
        person,
        role: 'csm',
        reason: AC_REASON,
      });
      const before = await contextsOf(c, t);

      await setModule(c, t, 'account_context', false);

      // Source writes: outcome only, nothing written.
      expect(
        await observeContext(c, t, {
          companyId: account,
          record: 'rel-d',
          dimensions: { product: 'core', region: 'emea' },
          name: 'Renamed while disabled',
        }),
      ).toEqual({ status: 'module_disabled' });
      expect(await assignFromSource(t, line, ctx)).toBe('skipped');
      // Operator writes: refused with module_disabled (audited denial).
      const refusals: [string, () => Promise<unknown>][] = [
        [
          'account_context.write',
          async () =>
            s().writer.write(await human(t), { context: ctx, name: 'x', reason: AC_REASON }),
        ],
        [
          'account_context.retire',
          async () => s().writer.retire(await human(t), { context: ctx, reason: AC_REASON }),
        ],
        [
          'account_context.release',
          async () => s().writer.release(await human(t), { context: ctx, reason: AC_REASON }),
        ],
        [
          'account_context.line.assign',
          async () =>
            s().writer.assignLine(await human(t), { line, context: ctx, reason: AC_REASON }),
        ],
        [
          'account_context.member.set',
          async () =>
            s().members.end(await human(t), {
              context: ctx,
              person,
              role: 'csm',
              reason: AC_REASON,
            }),
        ],
      ];
      for (const [action, run] of refusals) {
        await expect(run()).rejects.toMatchObject({ code: 'module_disabled' });
        const last = (await auditOf(c, t, action)).at(-1);
        expect(last?.outcome, action).not.toBe('allowed');
        expect(last?.reason_code, action).toBe('module_disabled');
      }
      // Data kept; reads allowed (audited).
      expect(await contextsOf(c, t)).toEqual(before);
      expect((await lineContextOf(c, t, line)).context_id).toBeNull();
      expect((await membersOf(c, t, ctx)).map((m) => m.status)).toEqual(['active']);
      const view = await s().read.get(await reader(t), { contextId: ctx });
      expect(view).toMatchObject({ id: ctx, name: 'Kept', type: 'product_region' });
      const list = await s().read.listForAccounts(await reader(t), { companyIds: [account] });
      expect(list.contexts.map((x) => x.id)).toEqual([ctx]);
      expect((await auditOf(c, t, 'account_context.read')).at(-1)).toMatchObject({
        outcome: 'allowed',
      });

      await setModule(c, t, 'account_context', true);
      expect(
        await s().writer.write(await human(t), {
          context: ctx,
          name: 'Writable again',
          reason: AC_REASON,
        }),
      ).toMatchObject({ changed: true });
    });
  });

  describe('V27: extension values on account_context targets and extension_ref dimensions', () => {
    const extensionDoc = () => ({
      schema_version: 1,
      fields: [
        field('ctx_tier', 'enum', {
          target: 'account_context',
          allowed_values: [
            { code: 'gold', label: 'Gold' },
            { code: 'silver', label: 'Silver' },
          ],
        }),
        field('ctx_note', 'string', { target: 'account_context' }),
      ],
    });
    const tiered = {
      key: 'tiered',
      title: 'Tier',
      description: 'A tier of the account from an extension field',
      dimensions: [
        {
          key: 'tier',
          type: 'extension_ref',
          required: true,
          extension_field: 'ctx_tier',
          sensitivity: 'internal',
          categories: ['commercial'],
        },
      ],
      member_roles: ['csm'],
    };

    it('values on a context (module extension + account_context); an extension_ref dimension validates against the field; module off refuses', async () => {
      const t = await contextTenant(c, 'acext', { publish: false });
      await setModule(c, t, 'extension', true);
      await publishExtension(c, t, extensionDoc());
      await publishContextTypes(c, t, defaultContextTypes([tiered]));
      const account = (await companies(c, t, ['8301']))['8301']!;
      // extension_ref dimension: a valid enum code creates; an unknown code is refused.
      const gold = await observeContext(c, t, {
        companyId: account,
        record: 'rel-gold',
        type: 'tiered',
        dimensions: { tier: 'gold' },
        name: 'Gold tier',
      });
      expect(gold.status).toBe('created');
      expect(
        await observeContext(c, t, {
          companyId: account,
          record: 'rel-bronze',
          type: 'tiered',
          dimensions: { tier: 'bronze' },
          name: 'Bronze tier',
        }),
      ).toEqual({ status: 'rejected', reason: 'extension_value_invalid' });
      expect((await contextOf(c, t, gold.contextId!)).dimensions).toEqual({ tier: 'gold' });

      // Extension values on the context (source and operator).
      const ctx = gold.contextId!;
      const ext = c.app.get(ExtensionValueWriter);
      const observeExt = async (raw: Record<string, unknown>) =>
        ext.observeSource(await authz(t, 'canonical.source_sync'), {
          target: { kind: 'account_context', id: ctx },
          values: Object.entries(raw).map(([f, r]) => ({ field: f, raw: r })),
          observedAt: new Date(),
          provenance: sourceProvenance('rel-gold', {
            source: { system: 'hubspot', objectType: 'relationships', id: 'rel-gold' },
          }),
        });
      expect(await observeExt({ ctx_note: 'Synthetic note', ctx_tier: 'silver' })).toMatchObject({
        status: 'ok',
        written: 2,
      });
      const v = await valuesOf(c, t, ctx);
      expect(v.ctx_note).toMatchObject({
        target_kind: 'account_context',
        target_id: ctx,
        value_text: 'Synthetic note',
      });
      expect(v.ctx_tier).toMatchObject({ value_enum: 'silver' });
      await ext.set(await human(t), {
        target: `account_context:${ctx}`,
        field: 'ctx_note',
        value: 'Operator note',
        reason: AC_REASON,
      });
      expect((await valuesOf(c, t, ctx)).ctx_note!.value_text).toBe('Operator note');

      // Module account_context disabled: extension values on contexts are refused too.
      await setModule(c, t, 'account_context', false);
      expect(await observeExt({ ctx_note: 'Refused' })).toMatchObject({
        status: 'module_disabled',
        written: 0,
      });
      await expect(
        ext.set(await human(t), {
          target: `account_context:${ctx}`,
          field: 'ctx_note',
          value: 'Refused',
          reason: AC_REASON,
        }),
      ).rejects.toMatchObject({ code: 'module_disabled' });
      expect((await valuesOf(c, t, ctx)).ctx_note!.value_text).toBe('Operator note');
    });
  });
});
