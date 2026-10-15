import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ACTOR_KINDS,
  AUDIT_GENESIS_HASH,
  AuditDetailsSchema,
  AuditEventInputSchema,
  auditEventHash,
  CAPABILITIES,
  classificationProblems,
  decide,
  effectiveSensitivity,
  findSecretLike,
  findSecretLikeInJson,
  GRANTABLE_ACTOR_KINDS,
  GRANTABLE_CAPABILITIES,
  isGrantableCapability,
  operatorActor,
  operatorIdFrom,
  POLICY,
  POLICY_VERSION,
  retentionCutoff,
  AUDIT_PURGE_EXECUTION_APPROVED,
  systemActor,
  verifyAuditChain,
  type AuditChainPayload,
  type StoredAuditEvent,
} from './index';

/** Pattern-shaped test strings are assembled at runtime: no real secret is ever in the repository. */
const shaped = {
  pem: ['-----BEGIN', 'RSA PRIVATE KEY-----'].join(' '),
  jwt: ['eyJ' + 'a'.repeat(12), 'eyJ' + 'b'.repeat(12), 'c'.repeat(16)].join('.'),
  bearer: 'Authorization: ' + 'Bearer ' + 'x'.repeat(24),
  aws: 'AKIA' + 'Q'.repeat(16),
  stripe: ['sk', 'live', 'z'.repeat(20)].join('_'),
  slack: 'xox' + 'b-' + '1'.repeat(12),
  github: 'gh' + 'p_' + 'A'.repeat(36),
  hubspot: 'pat-' + 'na1-' + ['abcdef12', 'abcd', 'abcd', 'abcd', 'abcdef123456'].join('-'),
  chargebee: 'test' + '_' + 'K'.repeat(28),
  google: 'AI' + 'za' + 'S'.repeat(35),
  url: 'postgres' + '://lip:' + 'hunter2pass' + '@db.example:5432/x',
  assignment: 'api_key' + '=' + 'abcd1234efgh',
};

describe('security policy (S1)', () => {
  it('decides every capability × actor kind exactly as policy v1 states', () => {
    for (const capability of CAPABILITIES) {
      for (const kind of ACTOR_KINDS) {
        const decision = decide(kind, capability);
        if (kind === 'human_user' || kind === 'ai') {
          expect(decision).toEqual({ allowed: false, reason: 'actor_kind_not_supported' });
        } else if (POLICY[capability].includes(kind)) {
          expect(decision).toEqual({ allowed: true });
        } else {
          expect(decision).toEqual({ allowed: false, reason: 'capability_not_granted' });
        }
      }
    }
  });

  it('pins the grants that matter (policy v1 table)', () => {
    expect(POLICY['canonical.source_sync']).toEqual(['source_sync', 'system']);
    expect(POLICY['canonical.import']).toEqual(['operator']);
    expect(POLICY['processing.receipt']).toEqual(['system']);
    expect(POLICY['config.oauth.grant']).toEqual(['system']);
    expect(POLICY['data.sync.run']).toEqual(['operator', 'system']);
    // M10C (policy v4, Q2): operator only, honoured only by the M10C operator commands.
    expect(POLICY['canonical.human_entry']).toEqual(['operator']);
    expect(POLICY['data.account_structure.read']).toEqual(['operator']);
    // M10D (policy v5, Q17, Q29): extension reads are operator-only.
    expect(POLICY['data.extension.read']).toEqual(['operator']);
    // M10B (policy v3): provenance reads are operator-only; evidence links system-only.
    expect(POLICY['data.provenance.read']).toEqual(['operator']);
    expect(POLICY['canonical.evidence.link']).toEqual(['system']);
    const operatorOnly = CAPABILITIES.filter(
      (c) => c.startsWith('config.') && c !== 'config.oauth.grant',
    );
    for (const c of operatorOnly) expect(POLICY[c]).toEqual(['operator']);
  });
});

describe('S1: policy v7 (M10D plan §16, M10E plan §15, M10E hardening #90)', () => {
  it('is version 7', () => {
    expect(POLICY_VERSION).toBe(7);
  });

  it('#90: data.account_context.read_confidential is granted to no actor kind by policy (explicit tenant grant only)', () => {
    expect(POLICY['data.account_context.read_confidential']).toEqual([]);
    for (const kind of ACTOR_KINDS) {
      const decision = decide(kind, 'data.account_context.read_confidential');
      expect(decision.allowed, `${kind} data.account_context.read_confidential`).toBe(false);
      expect(decision).toEqual({
        allowed: false,
        reason:
          kind === 'human_user' || kind === 'ai'
            ? 'actor_kind_not_supported'
            : 'capability_not_granted',
      });
    }
    // The base read is unchanged: operator-only, and it never implies the confidential read.
    expect(POLICY['data.account_context.read']).toEqual(['operator']);
  });

  it('#90: the grantable list is closed to the one confidential read (no generic grant, e.g. of all restricted data); only operators are grantees', () => {
    expect(GRANTABLE_CAPABILITIES).toEqual(['data.account_context.read_confidential']);
    expect(GRANTABLE_ACTOR_KINDS).toEqual(['operator']);
    for (const capability of CAPABILITIES) {
      expect(isGrantableCapability(capability), capability).toBe(
        capability === 'data.account_context.read_confidential',
      );
    }
    for (const other of ['restricted', 'data.*', '*', 'data.extension.read_confidential', '']) {
      expect(isGrantableCapability(other), other).toBe(false);
    }
    // Every grantable capability is granted to no kind by policy (else the grant would be moot).
    for (const capability of GRANTABLE_CAPABILITIES) expect(POLICY[capability]).toEqual([]);
  });

  it('#90: security.capability.grant (grant / revoke) is operator-only', () => {
    for (const kind of ACTOR_KINDS) {
      expect(
        decide(kind, 'security.capability.grant').allowed,
        `${kind} security.capability.grant`,
      ).toBe(kind === 'operator');
    }
  });

  it('#90: the confidential read follows the data.<area>.read naming (one verb segment, snake_case qualifier)', () => {
    const reads = CAPABILITIES.filter((c) => c.startsWith('data.') && c.includes('.read'));
    expect(reads).toEqual([
      'data.provenance.read',
      'data.account_structure.read',
      'data.extension.read',
      'data.account_context.read',
      'data.account_context.read_confidential',
    ]);
    for (const c of CAPABILITIES) expect(c, c).toMatch(/^[a-z]+\.[a-z_]+(\.[a-z_]+)?$/);
  });

  it('M10E: data.account_context.read is operator-only', () => {
    for (const kind of ACTOR_KINDS) {
      expect(
        decide(kind, 'data.account_context.read').allowed,
        `${kind} data.account_context.read`,
      ).toBe(kind === 'operator');
    }
  });

  it('extension reads and operator entry are operator-only; source writes stay source_sync / system', () => {
    for (const kind of ACTOR_KINDS) {
      const operator = kind === 'operator';
      expect(decide(kind, 'data.extension.read').allowed, `${kind} data.extension.read`).toBe(
        operator,
      );
      expect(decide(kind, 'canonical.human_entry').allowed, `${kind} canonical.human_entry`).toBe(
        operator,
      );
      expect(decide(kind, 'canonical.source_sync').allowed, `${kind} canonical.source_sync`).toBe(
        kind === 'source_sync' || kind === 'system',
      );
    }
    // Registry, mapping, module and adoption changes of kind `extension` reuse the operator grants.
    for (const c of [
      'config.registry.publish',
      'config.mapping.publish',
      'config.module.change',
      'config.canonical.adopt',
    ] as const) {
      expect(POLICY[c]).toEqual(['operator']);
    }
  });
});

describe('actors', () => {
  it('an operator is asserted, a system actor is system', () => {
    expect(operatorActor('alice@example')).toEqual({
      kind: 'operator',
      id: 'alice@example',
      assurance: 'asserted',
    });
    expect(systemActor('worker').assurance).toBe('system');
  });

  it('refuses an id outside the pattern', () => {
    expect(() => operatorActor('has space')).toThrow(/operator id must match/);
    expect(() => operatorActor('')).toThrow();
  });

  it('Q1: the operator id comes from --actor, else LIP_OPERATOR_ID, else nothing', () => {
    expect(operatorIdFrom('a', 'b')).toBe('a');
    expect(operatorIdFrom(undefined, 'b')).toBe('b');
    expect(operatorIdFrom(undefined, undefined)).toBeUndefined();
    expect(operatorIdFrom('  ', undefined)).toBeUndefined();
  });
});

describe('secret-like detection (S11)', () => {
  it.each(Object.entries(shaped))('detects %s', (_name, value) => {
    expect(findSecretLike(value)).toBeDefined();
    expect(findSecretLike(`prefix ${value} suffix`)).toBeDefined();
  });

  it.each([
    'Acme Learning Trust',
    'St. Mary’s Primary School',
    'jane.doe@example.org',
    '+44 20 7946 0958',
    '0f8fad5b-d9cb-469f-a165-70867728950e',
    '16BjvGKzWl0bQ1s5r', // a Chargebee-style record id
    'a'.repeat(64), // a sha-256 hex
    'ZXhhbXBsZSBiYXNlNjQgdGV4dCB0aGF0IGlzIG5vdCBhIHNlY3JldA',
    'https://www.example.org/path?x=1',
    'test_customer_42',
    'password reset requested',
    'The secret to success',
  ])('does not flag %s', (value) => {
    expect(findSecretLike(value)).toBeUndefined();
  });

  it('walks JSON and reports paths and codes only', () => {
    const hits = findSecretLikeInJson({ a: { b: [1, shaped.aws] }, c: 'fine' });
    expect(hits).toEqual([{ path: '$.a.b[1]', code: 'aws_access_key' }]);
    expect(JSON.stringify(hits)).not.toContain(shaped.aws);
  });
});

describe('classification', () => {
  const base = {
    sensitivity: 'internal' as const,
    categories: ['operational' as const],
    kind: 'code' as const,
    retention: 'canonical_lifecycle' as const,
    history: 'none' as const,
  };

  it('enforces the category floors', () => {
    expect(classificationProblems('t.c', { ...base, categories: ['personal'] })).toEqual([
      't.c: category personal needs at least confidential, not internal',
      't.c: a personal column needs a subject link',
    ]);
    expect(
      classificationProblems('t.c', {
        ...base,
        sensitivity: 'restricted',
        categories: ['communication'],
      }),
    ).toEqual([]);
  });

  it('Q6: a tbc column is restricted operationally and must be recorded so', () => {
    const tbc = {
      ...base,
      sensitivity: 'restricted' as const,
      tbc: { reason: 'owner to confirm the category', owner: 'owner' },
    };
    expect(effectiveSensitivity(tbc)).toBe('restricted');
    expect(classificationProblems('t.c', tbc)).toEqual([]);
    expect(classificationProblems('t.c', { ...tbc, sensitivity: 'internal' })).toContain(
      't.c: a tbc column is recorded as restricted',
    );
  });
});

describe('retention', () => {
  it('product defaults: audit 365 days; purge execution not approved', () => {
    const now = new Date('2027-01-01T00:00:00.000Z');
    expect(retentionCutoff('security_audit', now)?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(retentionCutoff('raw_rejected_value', now)).toBeUndefined();
    expect(AUDIT_PURGE_EXECUTION_APPROVED).toBe(false);
  });
});

describe('audit events and chain (S6, S8 unit)', () => {
  const input = (over: Partial<AuditChainPayload> = {}): AuditChainPayload => ({
    tenantId: '11111111-1111-4111-8111-111111111111',
    id: randomUUID(),
    seq: 1,
    occurredAt: new Date('2026-10-09T12:00:00.123Z'),
    actorKind: 'operator',
    actorId: 'alice',
    actorAssurance: 'asserted',
    capability: 'config.mapping.publish',
    action: 'mapping.publish',
    outcome: 'allowed',
    reasonCode: null,
    targetKind: 'mapping',
    targetRef: 'conn:1/v2',
    correlationId: randomUUID(),
    policyVersion: 1,
    details: { version: 2, entries: 14 },
    ...over,
  });

  it('details carry identifiers, codes and counts; values and secrets are refused', () => {
    expect(AuditDetailsSchema.safeParse({ count: 3, code: 'ok', ids: ['a', 1] }).success).toBe(
      true,
    );
    expect(AuditDetailsSchema.safeParse({ name: 'Jane Doe' }).success).toBe(false);
    expect(AuditDetailsSchema.safeParse({ nested: { a: 1 } }).success).toBe(false);
    expect(AuditDetailsSchema.safeParse({ k: shaped.chargebee }).success).toBe(false);
    expect(AuditDetailsSchema.safeParse({ k: 'x'.repeat(5000) }).success).toBe(false);
  });

  it('a reason code is required exactly for denied and failed', () => {
    const { tenantId: _t, id: _i, seq: _s, occurredAt: _o, ...e } = input();
    expect(AuditEventInputSchema.safeParse(e).success).toBe(true);
    expect(AuditEventInputSchema.safeParse({ ...e, outcome: 'denied' }).success).toBe(false);
    expect(
      AuditEventInputSchema.safeParse({
        ...e,
        outcome: 'denied',
        reasonCode: 'capability_not_granted',
      }).success,
    ).toBe(true);
  });

  const chain = (n: number): StoredAuditEvent[] => {
    const out: StoredAuditEvent[] = [];
    let prev = AUDIT_GENESIS_HASH;
    for (let seq = 1; seq <= n; seq++) {
      const p = input({ seq });
      const hash = auditEventHash(prev, p);
      out.push({ ...p, prevHash: prev, hash });
      prev = hash;
    }
    return out;
  };

  it('the hash is deterministic and covers every field', () => {
    const p = input();
    expect(auditEventHash(AUDIT_GENESIS_HASH, p)).toBe(
      auditEventHash(AUDIT_GENESIS_HASH, { ...p }),
    );
    expect(auditEventHash(AUDIT_GENESIS_HASH, p)).not.toBe(
      auditEventHash(AUDIT_GENESIS_HASH, { ...p, details: { version: 3, entries: 14 } }),
    );
    expect(auditEventHash(AUDIT_GENESIS_HASH, p)).not.toBe(auditEventHash('f'.repeat(64), p));
  });

  it('a valid chain verifies; tampering, re-linking and gaps are detected', () => {
    const events = chain(5);
    expect(verifyAuditChain(events)).toMatchObject({ ok: true, events: 5 });

    const tampered = events.map((e) => (e.seq === 3 ? { ...e, actorId: 'mallory' } : e));
    expect(verifyAuditChain(tampered)).toMatchObject({
      ok: false,
      brokenAtSeq: 3,
      reason: 'hash_mismatch',
    });

    const relinked = events.map((e) => (e.seq === 4 ? { ...e, prevHash: AUDIT_GENESIS_HASH } : e));
    expect(verifyAuditChain(relinked)).toMatchObject({ ok: false, brokenAtSeq: 4 });

    const gap = events.filter((e) => e.seq !== 2);
    expect(verifyAuditChain(gap)).toMatchObject({ ok: false, brokenAtSeq: 3, reason: 'seq_gap' });
  });

  it('verifies from a purge anchor', () => {
    const events = chain(5);
    const kept = events.slice(2);
    expect(verifyAuditChain(kept, { hash: events[1]!.hash, seq: 2 })).toMatchObject({ ok: true });
    expect(verifyAuditChain(kept)).toMatchObject({ ok: false });
  });
});

describe('secret-like keys (M10A1 review m5)', () => {
  it('a secret-shaped key is found, and never appears in the reported path', () => {
    const key = ['sk', 'live', 'k'.repeat(20)].join('_');
    const hits = findSecretLikeInJson({ settings: { [key]: 'plain' } });
    expect(hits).toEqual([{ path: '$.settings.[key]', code: 'stripe_key' }]);
    expect(JSON.stringify(hits)).not.toContain(key);
  });
});

describe('audit detail keys mirror the database secret-key rule', () => {
  it('refuses keys the database CHECK would refuse', () => {
    expect(AuditDetailsSchema.safeParse({ refreshTokenRotated: true }).success).toBe(false);
    expect(AuditDetailsSchema.safeParse({ rotated: true }).success).toBe(true);
  });
});
