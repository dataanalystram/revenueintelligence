import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { operatorActor } from '../../src/modules/domain';
import {
  AuthorizationDeniedError,
  CapabilityGrants,
  type TenantContext,
} from '../../src/modules/tenancy';
import { auditOf, companies } from '../support/account-structure';
import { contextTenant, observeContext, setModule } from '../support/account-context';
import { startContextHarness, type ContextHarness } from '../support/context';
import { field, publishExtension, services, sourceProvenance } from '../support/extension';
import { authz, TEST_GRANTOR } from '../support/security';

const CONFIDENTIAL = 'data.account_context.read_confidential';
/** Synthetic confidential / internal values that must never reach an audit event. */
const PROBE_CTX = 'Probectxconfidentialvalue';
const PROBE_NOTE = 'Probectxinternalnote';
const PROBE_COMPANY = 'Probecompanyconfidential';

/**
 * M10E hardening #90, re-review m2 (ADR 0031 addendum): confidential extension
 * values on an `account_context` target are AccountContext confidential data.
 * `extension values show --include-confidential` over such a target needs
 * data.account_context.read_confidential (explicit tenant grant) on top of
 * data.extension.read: refused + `denied` audit without it, released + `allowed`
 * audit naming the capability with it; default reads still redact; other target
 * kinds keep the M10D behaviour (data.extension.read + the audited flag); tenant
 * isolation of grants and values. Real PostgreSQL as the app role, real
 * WriteAuthorizer / CapabilityGrants. Synthetic definitions and values only.
 */
describe('M10E hardening #90 (m2): confidential extension values on account_context targets', () => {
  let c: ContextHarness;
  let tA: TenantContext;
  let tB: TenantContext;
  let ctxA: string;
  let ctxB: string;
  let companyA: string;

  const document = () => ({
    schema_version: 1,
    fields: [
      field('ctx_terms', 'string', {
        target: 'account_context',
        sensitivity: 'confidential',
        categories: ['commercial'],
      }),
      field('ctx_note', 'string', { target: 'account_context' }),
      field('co_terms', 'string', { sensitivity: 'confidential', categories: ['commercial'] }),
    ],
  });

  const setup = async (prefix: string, portal: number, account: string) => {
    const t = await contextTenant(c, prefix, { portal });
    await setModule(c, t, 'extension', true);
    await publishExtension(c, t, document());
    const companyId = (await companies(c, t, [account]))[account]!;
    const ctx = await observeContext(c, t, {
      companyId,
      record: `rel-ext-${prefix}`,
      dimensions: { product: 'core', region: 'emea' },
      name: `Context ${prefix}`,
    });
    const values = services(c).values;
    expect(
      await values.observeSource(await authz(t, 'canonical.source_sync'), {
        target: { kind: 'account_context', id: ctx.contextId! },
        values: [
          { field: 'ctx_terms', raw: PROBE_CTX },
          { field: 'ctx_note', raw: PROBE_NOTE },
        ],
        observedAt: new Date(),
        provenance: sourceProvenance(`rel-ext-${prefix}`, {
          source: { system: 'hubspot', objectType: 'relationships', id: `rel-ext-${prefix}` },
        }),
      }),
    ).toMatchObject({ status: 'ok', written: 2 });
    expect(
      await values.observeSource(await authz(t, 'canonical.source_sync'), {
        target: { kind: 'company', id: companyId },
        values: [{ field: 'co_terms', raw: PROBE_COMPANY }],
        observedAt: new Date(),
        provenance: sourceProvenance(account),
      }),
    ).toMatchObject({ status: 'ok', written: 1 });
    return { t, ctx: ctx.contextId!, companyId };
  };

  beforeAll(async () => {
    c = await startContextHarness();
    const a = await setup('acextca', 9201, '9201');
    const b = await setup('acextcb', 9202, '9202');
    tA = a.t;
    tB = b.t;
    ctxA = a.ctx;
    ctxB = b.ctx;
    companyA = a.companyId;
  });
  afterAll(async () => {
    await c?.close();
  });

  const read = () => services(c).read;
  const grants = () => c.app.get(CapabilityGrants);
  const reader = (t: TenantContext, id: string) =>
    authz(t, 'data.extension.read', operatorActor(id));
  const grantor = (t: TenantContext) => authz(t, 'security.capability.grant', TEST_GRANTOR);
  const grant = async (t: TenantContext, grantee: string) =>
    grants().grant(await grantor(t), { grantee, capability: CONFIDENTIAL });
  const revoke = async (t: TenantContext, grantee: string) =>
    grants().revoke(await grantor(t), { grantee, capability: CONFIDENTIAL });
  const readEvents = (t: TenantContext) => auditOf(c, t, 'extension.read');
  const valueFree = (events: unknown) => {
    const text = JSON.stringify(events);
    for (const v of [PROBE_CTX, PROBE_NOTE, PROBE_COMPANY]) expect(text).not.toContain(v);
  };
  const byField = (views: readonly { field: string }[], key: string) =>
    views.find((v) => v.field === key) as Record<string, unknown> | undefined;

  it('default: without the flag an account_context target needs only data.extension.read; the confidential value is withheld, the internal one shown', async () => {
    const before = (await readEvents(tA)).length;
    const views = await read().valuesFor(await reader(tA, 'ext-plain'), 'display', [
      `account_context:${ctxA}`,
    ]);
    expect(byField(views, 'ctx_note')).toMatchObject({ shown: true, value: PROBE_NOTE });
    const secret = byField(views, 'ctx_terms')!;
    expect(secret).toMatchObject({ sensitivity: 'confidential', shown: false });
    expect(secret).not.toHaveProperty('value');
    const events = (await readEvents(tA)).slice(before);
    expect(events.map((e) => [e.outcome, e.capability, e.details.includeConfidential])).toEqual([
      ['allowed', 'data.extension.read', false],
    ]);
    expect(events[0]!.details).not.toHaveProperty('accountContextConfidential');
    valueFree(events);
  });

  it('refusal: includeConfidential over an account_context target without the grant is refused (not redacted) and audited as denied with data.account_context.read_confidential — also when mixed with other targets', async () => {
    const before = (await readEvents(tA)).length;
    const refused = read().valuesFor(
      await reader(tA, 'ext-nogrant'),
      'display',
      [`account_context:${ctxA}`],
      { includeConfidential: true },
    );
    await expect(refused).rejects.toBeInstanceOf(AuthorizationDeniedError);
    await expect(
      read().valuesFor(
        await reader(tA, 'ext-nogrant-2'),
        'display',
        [`company:${companyA}`, `account_context:${ctxA}`],
        { includeConfidential: true },
      ),
    ).rejects.toMatchObject({ code: 'authorization_denied', capability: CONFIDENTIAL });
    const events = (await readEvents(tA)).slice(before);
    // One denied event per refusal (distinct actors: denials are coalesced per actor for 60 s).
    expect(events.map((e) => [e.outcome, e.capability, e.reason_code])).toEqual([
      ['denied', CONFIDENTIAL, 'capability_not_granted'],
      ['denied', CONFIDENTIAL, 'capability_not_granted'],
    ]);
    expect(events[0]).toMatchObject({
      target_kind: 'extension_value',
      target_ref: `account_context:${ctxA}`,
      details: { operation: 'values', includeConfidential: true, targetKind: 'account_context' },
    });
    expect(events[1]!.target_ref).toBe('2_targets');
    valueFree(events);
  });

  it('success: with an explicit grant the confidential value is released and the read is audited as allowed with the capability; a revoke refuses again', async () => {
    await grant(tA, 'ext-conf');
    const before = (await readEvents(tA)).length;
    const views = await read().valuesFor(
      await reader(tA, 'ext-conf'),
      'display',
      [`account_context:${ctxA}`],
      { includeConfidential: true },
    );
    expect(byField(views, 'ctx_terms')).toMatchObject({ shown: true, value: PROBE_CTX });
    expect(byField(views, 'ctx_note')).toMatchObject({ shown: true, value: PROBE_NOTE });
    // The same operator without the flag still gets the redacted view.
    const plain = await read().valuesFor(await reader(tA, 'ext-conf'), 'display', [
      `account_context:${ctxA}`,
    ]);
    expect(byField(plain, 'ctx_terms')).toMatchObject({ shown: false });
    const events = (await readEvents(tA)).slice(before);
    expect(events.map((e) => [e.outcome, e.capability, e.details.includeConfidential])).toEqual([
      ['allowed', CONFIDENTIAL, true],
      ['allowed', 'data.extension.read', false],
    ]);
    expect(events[0]).toMatchObject({
      target_kind: 'extension_value',
      target_ref: `account_context:${ctxA}`,
      details: { accountContextConfidential: true, targets: 1, values: 2 },
    });
    valueFree(events);

    await revoke(tA, 'ext-conf');
    await expect(
      read().valuesFor(await reader(tA, 'ext-conf'), 'display', [`account_context:${ctxA}`], {
        includeConfidential: true,
      }),
    ).rejects.toMatchObject({ code: 'authorization_denied', capability: CONFIDENTIAL });
    expect((await readEvents(tA)).at(-1)).toMatchObject({
      outcome: 'denied',
      capability: CONFIDENTIAL,
    });
  });

  it('other target kinds are unaffected: a confidential company value is released with data.extension.read and the audited flag (M10D behaviour), no grant consulted', async () => {
    const before = (await readEvents(tA)).length;
    const views = await read().valuesFor(
      await reader(tA, 'ext-company'),
      'display',
      [`company:${companyA}`],
      { includeConfidential: true },
    );
    expect(byField(views, 'co_terms')).toMatchObject({ shown: true, value: PROBE_COMPANY });
    const events = (await readEvents(tA)).slice(before);
    expect(events.map((e) => [e.outcome, e.capability, e.details.includeConfidential])).toEqual([
      ['allowed', 'data.extension.read', true],
    ]);
    expect(events[0]!.details).not.toHaveProperty('accountContextConfidential');
    expect(await grants().holds(tA, operatorActor('ext-company'), CONFIDENTIAL)).toBe(false);
    valueFree(events);
  });

  it('tenant isolation: a grant in tenant A does not release in tenant B (denied in B’s trail); tenant B’s context values are unreachable from tenant A even with A’s grant', async () => {
    await grant(tA, 'ext-iso');
    await expect(
      read().valuesFor(await reader(tA, 'ext-iso'), 'display', [`account_context:${ctxA}`], {
        includeConfidential: true,
      }),
    ).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'ctx_terms', value: PROBE_CTX })]),
    );
    // Tenant B's context id read from tenant A with A's grant: nothing (forced RLS).
    await expect(
      read().valuesFor(await reader(tA, 'ext-iso'), 'display', [`account_context:${ctxB}`], {
        includeConfidential: true,
      }),
    ).resolves.toEqual([]);
    // The same operator id in tenant B holds nothing there: refused, denied in B's trail.
    const beforeB = (await readEvents(tB)).length;
    await expect(
      read().valuesFor(await reader(tB, 'ext-iso'), 'display', [`account_context:${ctxB}`], {
        includeConfidential: true,
      }),
    ).rejects.toMatchObject({ code: 'authorization_denied', capability: CONFIDENTIAL });
    const eventsB = (await readEvents(tB)).slice(beforeB);
    expect(eventsB.map((e) => [e.outcome, e.capability])).toEqual([['denied', CONFIDENTIAL]]);
    valueFree(eventsB);
    await revoke(tA, 'ext-iso');
  });
});
