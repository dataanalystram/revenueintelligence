import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { operatorActor, sourceSyncActor, systemActor } from '../../src/modules/domain';
import {
  AuthorizationDeniedError,
  CapabilityGrants,
  InvalidAuthorizedContextError,
  type AuthorizedContext,
  type TenantContext,
} from '../../src/modules/tenancy';
import { asApp, auditOf, companies } from '../support/account-structure';
import { acServices, contextTenant, observeContext } from '../support/account-context';
import { startContextHarness, type ContextHarness } from '../support/context';
import { authz, TEST_GRANTOR } from '../support/security';

const CONFIDENTIAL = 'data.account_context.read_confidential';
/** A confidential dimension value and renewal date that must never reach an audit event. */
const PROBE_SEGMENT = 'Probeconfidentialsegment';
const PROBE_RENEWAL = '2027-04-30';

/**
 * M10E hardening #90 (ADR 0031 addendum, docs/tech-debt.md #90): confidential
 * AccountContext reads need data.account_context.read_confidential on top of
 * data.account_context.read. Real PostgreSQL as the app role (forced RLS),
 * through the real harness app and the real WriteAuthorizer / CapabilityGrants
 * (no policy bypass). Covers: default redaction; refusal (not redaction) plus a
 * `denied` audit event naming the capability without it; success plus an
 * `allowed` audit event naming it (keys only) with it; revoke; tenant isolation
 * of contexts and of grants; grant rules (no self-grant, closed capability list,
 * no-op refused); adversarial calls (the confidential capability without the base
 * read, a forged context, another actor kind with a granted id, raw SQL as the
 * app role). Synthetic types and values only.
 */
describe('M10E hardening #90: confidential AccountContext reads', () => {
  let c: ContextHarness;
  let tA: TenantContext;
  let tB: TenantContext;
  let ctxA: string;
  let accountA: string;
  let ctxB: string;

  beforeAll(async () => {
    c = await startContextHarness();
    tA = await contextTenant(c, 'acconfa', { portal: 9101 });
    tB = await contextTenant(c, 'acconfb', { portal: 9102 });
    accountA = (await companies(c, tA, ['9101']))['9101']!;
    const accountB = (await companies(c, tB, ['9102']))['9102']!;
    const a = await observeContext(c, tA, {
      companyId: accountA,
      record: 'rel-conf-a',
      dimensions: { product: 'core', region: 'emea', segment: PROBE_SEGMENT },
      name: 'Confidential A',
      renewalDate: PROBE_RENEWAL,
    });
    const b = await observeContext(c, tB, {
      companyId: accountB,
      record: 'rel-conf-b',
      dimensions: { product: 'core', region: 'amer', segment: PROBE_SEGMENT },
      name: 'Confidential B',
      renewalDate: PROBE_RENEWAL,
    });
    ctxA = a.contextId!;
    ctxB = b.contextId!;
  });
  afterAll(async () => {
    await c?.close();
  });

  const read = () => acServices(c).read;
  const grants = () => c.app.get(CapabilityGrants);
  const reader = (t: TenantContext, id: string) =>
    authz(t, 'data.account_context.read', operatorActor(id));
  const grantor = (t: TenantContext, actor = TEST_GRANTOR) =>
    authz(t, 'security.capability.grant', actor);
  const grant = async (t: TenantContext, grantee: string) =>
    grants().grant(await grantor(t), { grantee, capability: CONFIDENTIAL });
  const revoke = async (t: TenantContext, grantee: string) =>
    grants().revoke(await grantor(t), { grantee, capability: CONFIDENTIAL });
  const readEvents = async (t: TenantContext) => auditOf(c, t, 'account_context.read');
  const valueFree = (events: unknown) => {
    const text = JSON.stringify(events);
    for (const v of [PROBE_SEGMENT, PROBE_RENEWAL, 'Confidential A', 'Confidential B']) {
      expect(text).not.toContain(v);
    }
  };

  it('default: an ordinary read needs only data.account_context.read and withholds the renewal date and the confidential dimension (keys listed, values absent)', async () => {
    const before = (await readEvents(tA)).length;
    const shown = await read().get(await reader(tA, 'plain-reader'), { contextId: ctxA });
    expect(shown.renewalDate).toBeNull();
    expect(shown.dimensions).toEqual({ product: 'core', region: 'emea' });
    expect([...shown.withheld].sort()).toEqual(['dimension.segment', 'renewalDate']);
    const listed = await read().listForAccounts(await reader(tA, 'plain-reader'), {
      companyIds: [accountA],
    });
    expect(listed.contexts).toHaveLength(1);
    expect(listed.contexts[0]!.renewalDate).toBeNull();
    expect(listed.contexts[0]!.dimensions).not.toHaveProperty('segment');
    const events = (await readEvents(tA)).slice(before);
    expect(events.map((e) => [e.outcome, e.capability, e.details.includeConfidential])).toEqual([
      ['allowed', 'data.account_context.read', false],
      ['allowed', 'data.account_context.read', false],
    ]);
    for (const e of events) expect(e.details).not.toHaveProperty('releasedKeys');
    valueFree(events);
  });

  it('refusal: includeConfidential without the capability is refused (not redacted) and audited as denied with data.account_context.read_confidential', async () => {
    const before = (await readEvents(tA)).length;
    const actx = await reader(tA, 'no-grant-reader');
    const refused = read().get(actx, { contextId: ctxA, includeConfidential: true });
    await expect(refused).rejects.toBeInstanceOf(AuthorizationDeniedError);
    await expect(
      read().get(await reader(tA, 'no-grant-reader-2'), {
        contextId: ctxA,
        includeConfidential: true,
      }),
    ).rejects.toMatchObject({ code: 'authorization_denied', capability: CONFIDENTIAL });
    await expect(
      read().listForAccounts(await reader(tA, 'no-grant-reader-3'), {
        companyIds: [accountA],
        includeConfidential: true,
      }),
    ).rejects.toMatchObject({ code: 'authorization_denied', capability: CONFIDENTIAL });
    const events = (await readEvents(tA)).slice(before);
    // One denied event per refused call; no allowed (redacted) read and no failed event.
    expect(events.map((e) => [e.outcome, e.capability, e.reason_code, e.actor_kind])).toEqual([
      ['denied', CONFIDENTIAL, 'capability_not_granted', 'operator'],
      ['denied', CONFIDENTIAL, 'capability_not_granted', 'operator'],
      ['denied', CONFIDENTIAL, 'capability_not_granted', 'operator'],
    ]);
    expect(events[0]).toMatchObject({
      target_kind: 'account_context',
      target_ref: ctxA,
      details: { operation: 'show', includeConfidential: true },
    });
    expect(events[2]).toMatchObject({
      target_ref: accountA,
      details: { operation: 'list', includeConfidential: true },
    });
    valueFree(events);
  });

  it('success: with an explicit grant the values are released and the read is audited as allowed with the capability, includeConfidential and the released keys (never values); a revoke refuses again', async () => {
    await grant(tA, 'conf-reader');
    const before = (await readEvents(tA)).length;
    const shown = await read().get(await reader(tA, 'conf-reader'), {
      contextId: ctxA,
      includeConfidential: true,
    });
    expect(shown).toMatchObject({
      renewalDate: PROBE_RENEWAL,
      dimensions: { product: 'core', region: 'emea', segment: PROBE_SEGMENT },
      withheld: [],
    });
    const listed = await read().listForAccounts(await reader(tA, 'conf-reader'), {
      companyIds: [accountA],
      includeConfidential: true,
    });
    expect(listed.contexts[0]).toMatchObject({ renewalDate: PROBE_RENEWAL, withheld: [] });
    // The same operator without the flag still gets the redacted view.
    const plain = await read().get(await reader(tA, 'conf-reader'), { contextId: ctxA });
    expect(plain.renewalDate).toBeNull();
    const events = (await readEvents(tA)).slice(before);
    expect(events.map((e) => [e.outcome, e.capability, e.details.includeConfidential])).toEqual([
      ['allowed', CONFIDENTIAL, true],
      ['allowed', CONFIDENTIAL, true],
      ['allowed', 'data.account_context.read', false],
    ]);
    expect(events[0]!.details).toMatchObject({
      operation: 'show',
      releasedKeys: ['dimension.segment', 'renewalDate'],
      releasedKeysTruncated: false,
    });
    expect(events[1]!.details).toMatchObject({
      operation: 'list',
      releasedKeys: ['dimension.segment', 'renewalDate'],
    });
    valueFree(events);
    // The grant itself is audited (identifiers and codes only).
    const grantEvents = await auditOf(c, tA, 'capability.grant');
    expect(grantEvents.at(-1)).toMatchObject({
      outcome: 'allowed',
      capability: 'security.capability.grant',
      target_kind: 'capability_grant',
      target_ref: `${CONFIDENTIAL}:conf-reader`,
      details: { capability: CONFIDENTIAL, grantee: 'conf-reader', version: 1 },
    });

    const revokesBefore = (await auditOf(c, tA, 'capability.revoke')).length;
    await revoke(tA, 'conf-reader');
    // The revoke itself is audited: exactly one allowed event (identifiers and codes only).
    const revokeEvents = (await auditOf(c, tA, 'capability.revoke')).slice(revokesBefore);
    expect(revokeEvents).toHaveLength(1);
    expect(revokeEvents[0]).toMatchObject({
      outcome: 'allowed',
      capability: 'security.capability.grant',
      target_kind: 'capability_grant',
      target_ref: `${CONFIDENTIAL}:conf-reader`,
      details: { capability: CONFIDENTIAL, grantee: 'conf-reader', version: 2 },
    });
    valueFree(revokeEvents);
    await expect(
      read().get(await reader(tA, 'conf-reader'), { contextId: ctxA, includeConfidential: true }),
    ).rejects.toMatchObject({ code: 'authorization_denied', capability: CONFIDENTIAL });
    // A re-grant is a new version of the same row.
    await expect(grant(tA, 'conf-reader')).resolves.toMatchObject({ active: true, version: 3 });
    await revoke(tA, 'conf-reader');
  });

  it('tenant isolation: a grant in tenant A does not grant in tenant B; a context of tenant B stays unreachable from tenant A, with or without the grant', async () => {
    await grant(tA, 'iso-reader');
    // Tenant A's grant, tenant A's read: allowed.
    await expect(
      read().get(await reader(tA, 'iso-reader'), { contextId: ctxA, includeConfidential: true }),
    ).resolves.toMatchObject({ renewalDate: PROBE_RENEWAL });
    // Tenant B context id from tenant A (with the confidential grant): does not exist (RLS).
    await expect(
      read().get(await reader(tA, 'iso-reader'), { contextId: ctxB, includeConfidential: true }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(
      read().get(await reader(tA, 'iso-reader'), { contextId: ctxB }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    // The same operator id in tenant B holds nothing there: refused, denied in B's trail.
    const beforeB = (await readEvents(tB)).length;
    await expect(
      read().get(await reader(tB, 'iso-reader'), { contextId: ctxB, includeConfidential: true }),
    ).rejects.toMatchObject({ code: 'authorization_denied', capability: CONFIDENTIAL });
    const eventsB = (await readEvents(tB)).slice(beforeB);
    expect(eventsB.map((e) => [e.outcome, e.capability])).toEqual([['denied', CONFIDENTIAL]]);
    expect(await grants().holds(tB, operatorActor('iso-reader'), CONFIDENTIAL)).toBe(false);
    expect(await grants().holds(tA, operatorActor('iso-reader'), CONFIDENTIAL)).toBe(true);
    // Tenant A's grant row is invisible to tenant B as the app role (forced RLS).
    const seen = await asApp(c, tB, (db) =>
      db.query<{ n: number }>(`SELECT count(*)::int AS n FROM tenant_capability_grants`),
    );
    expect(seen.rows[0]!.n).toBe(0);
    await revoke(tA, 'iso-reader');
  });

  it('grant rules: no self-grant, only the closed grantable list (no generic grant), no no-op; each refusal audited with its reason', async () => {
    await expect(
      grants().grant(await grantor(tA, operatorActor('self-granter')), {
        grantee: 'self-granter',
        capability: CONFIDENTIAL,
      }),
    ).rejects.toMatchObject({ code: 'self_grant_refused' });
    for (const capability of [
      'data.account_context.read',
      'security.audit.read',
      'security.capability.grant',
      'restricted',
      'data.extension.read',
    ]) {
      await expect(
        grants().grant(await grantor(tA), { grantee: 'rule-reader', capability }),
        capability,
      ).rejects.toMatchObject({ code: 'capability_not_grantable' });
    }
    await expect(
      grants().grant(await grantor(tA), {
        grantee: 'bad id with spaces',
        capability: CONFIDENTIAL,
      }),
    ).rejects.toMatchObject({ name: 'InvalidActorError' });
    await expect(revoke(tA, 'rule-reader')).rejects.toMatchObject({ code: 'no_change' });
    await grant(tA, 'rule-reader');
    await expect(grant(tA, 'rule-reader')).rejects.toMatchObject({ code: 'no_change' });
    await revoke(tA, 'rule-reader');
    const failed = (await auditOf(c, tA, 'capability.grant')).filter((e) => e.outcome === 'failed');
    expect(failed.map((e) => e.reason_code)).toEqual(
      expect.arrayContaining(['self_grant_refused', 'capability_not_grantable', 'no_change']),
    );
    // Only the grantor's capability authorizes a grant: a source-sync or system actor is denied.
    await expect(grantor(tA, sourceSyncActor('run:grant'))).rejects.toBeInstanceOf(
      AuthorizationDeniedError,
    );
    await expect(grantor(tA, systemActor('grant-system'))).rejects.toBeInstanceOf(
      AuthorizationDeniedError,
    );
  });

  describe('adversarial', () => {
    it('the confidential capability alone (without the base read) is refused by the read model', async () => {
      await grant(tA, 'only-conf');
      const confOnly = await authz(tA, CONFIDENTIAL, operatorActor('only-conf'));
      expect(confOnly.capability).toBe(CONFIDENTIAL);
      const asRead = confOnly as unknown as AuthorizedContext<'data.account_context.read'>;
      await expect(
        read().get(asRead, { contextId: ctxA, includeConfidential: true }),
      ).rejects.toBeInstanceOf(InvalidAuthorizedContextError);
      await expect(
        read().listForAccounts(asRead, { companyIds: [accountA], includeConfidential: true }),
      ).rejects.toBeInstanceOf(InvalidAuthorizedContextError);
      await revoke(tA, 'only-conf');
    });

    it('a forged authorized context (a plain object claiming the read) is refused', async () => {
      const real = await reader(tA, 'forger');
      const forged = {
        tenant: real.tenant,
        actor: real.actor,
        capability: 'data.account_context.read',
        correlationId: real.correlationId,
        policyVersion: real.policyVersion,
      } as unknown as AuthorizedContext<'data.account_context.read'>;
      await expect(
        read().get(forged, { contextId: ctxA, includeConfidential: true }),
      ).rejects.toBeInstanceOf(InvalidAuthorizedContextError);
      const forgedConf = Object.create(Object.getPrototypeOf(real) as object, {
        ...Object.getOwnPropertyDescriptors(real),
        capability: { value: CONFIDENTIAL },
      }) as AuthorizedContext<'data.account_context.read'>;
      await expect(
        read().get(forgedConf, { contextId: ctxA, includeConfidential: true }),
      ).rejects.toBeInstanceOf(InvalidAuthorizedContextError);
    });

    it('a granted operator id under another actor kind holds nothing (kind is part of the grant); system / source-sync actors get no read at all', async () => {
      await grant(tA, 'kind-reader');
      await expect(authz(tA, CONFIDENTIAL, systemActor('kind-reader'))).rejects.toBeInstanceOf(
        AuthorizationDeniedError,
      );
      await expect(authz(tA, CONFIDENTIAL, sourceSyncActor('kind-reader'))).rejects.toBeInstanceOf(
        AuthorizationDeniedError,
      );
      await expect(
        authz(tA, 'data.account_context.read', systemActor('kind-reader')),
      ).rejects.toBeInstanceOf(AuthorizationDeniedError);
      // A different operator id is not the granted one.
      await expect(authz(tA, CONFIDENTIAL, operatorActor('kind-reader2'))).rejects.toBeInstanceOf(
        AuthorizationDeniedError,
      );
      await expect(authz(tA, CONFIDENTIAL, operatorActor('kind-reader'))).resolves.toMatchObject({
        capability: CONFIDENTIAL,
      });
      await revoke(tA, 'kind-reader');
    });

    it('raw SQL as the app role: no grant of another capability, to another kind, to oneself; identity immutable; no DELETE', async () => {
      const row = (over: Record<string, string>) => {
        const v = {
          actor_kind: 'operator',
          actor_id: 'sql-reader',
          capability: CONFIDENTIAL,
          granted_by_id: 'sql-grantor',
          ...over,
        };
        return `INSERT INTO tenant_capability_grants (tenant_id, actor_kind, actor_id, capability, active, version,
                  granted_at, granted_by_kind, granted_by_id, granted_by_assurance)
                VALUES ('${tA.tenantId}', '${v.actor_kind}', '${v.actor_id}', '${v.capability}', true, 1, now(),
                  'operator', '${v.granted_by_id}', 'asserted')`;
      };
      const refused = async (sql: string, message: RegExp) =>
        expect(asApp(c, tA, (db) => db.query(sql))).rejects.toThrow(message);
      await refused(row({ capability: 'security.audit.read' }), /capability_grantable/);
      await refused(row({ capability: 'data.account_context.read' }), /capability_grantable/);
      await refused(row({ actor_kind: 'system' }), /grantee_operator/);
      await refused(row({ granted_by_id: 'sql-reader' }), /no_self_grant/);
      // Another tenant's id in the row: refused by the tenant policy (forced RLS).
      await refused(row({}).replace(`'${tA.tenantId}'`, `'${tB.tenantId}'`), /row-level security/);
      await grant(tA, 'sql-reader');
      await refused(
        `UPDATE tenant_capability_grants SET actor_id = 'someone-else', version = version + 1`,
        /capability_grant_identity_immutable/,
      );
      await refused(
        `UPDATE tenant_capability_grants SET capability = 'security.audit.read', version = version + 1`,
        /capability_grant_identity_immutable|capability_grantable/,
      );
      // Re-review n1: a well-formed revoke that does not bump the version is refused by the
      // guard trigger (no silent state change without a new version), as is a version jump.
      const revokeSql = (version: string) =>
        `UPDATE tenant_capability_grants SET active = false, revoked_at = now(),
                revoked_by_kind = 'operator', revoked_by_id = 'sql-grantor',
                revoked_by_assurance = 'asserted', version = ${version}
          WHERE actor_id = 'sql-reader'`;
      await refused(revokeSql('version'), /capability_grant_version_not_incremented/);
      await refused(revokeSql('version + 2'), /capability_grant_version_not_incremented/);
      expect(await grants().holds(tA, operatorActor('sql-reader'), CONFIDENTIAL)).toBe(true);
      await refused(`DELETE FROM tenant_capability_grants`, /permission denied/);
      await revoke(tA, 'sql-reader');
    });
  });
});
