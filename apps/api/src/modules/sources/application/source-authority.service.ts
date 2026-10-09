import { Injectable } from '@nestjs/common';
import {
  AUTHORITY_FACTS,
  authorityContentHashWith,
  AuthorityDocumentSchema,
  ProofAcceptanceSchema,
  type ProofAcceptance,
  holdingsConfirmed,
  MappingDocumentSchema,
  type AuthorityDocument,
  type AuthorityFact,
} from '../../domain';
import {
  assertAuthorized,
  AuditTrail,
  tenantAdvisoryLock,
  TenantDatabase,
  type AuthorizedContext,
  type TenantContext,
} from '../../tenancy';
import {
  AuthorityInvalidError,
  ConcurrentSourcePublishError,
  PublishBaseVersionRequiredError,
  SourcesError,
} from '../errors';
import {
  SourcesRepository,
  type StoredAuthorityVersion,
} from '../infrastructure/sources.repository';

/** Which connection kinds can carry which facts (code-mapped kinds have fixed abilities). */
const CODE_KIND_FACTS: Record<string, readonly AuthorityFact[]> = {
  import: ['subscription_lines', 'subscription_state', 'subscription_terms'],
  hubspot: ['account_profile', 'person_profile'],
};

type Issue = { code: string; path: string; message: string };

/**
 * Source authority declarations (ADR 0020 §8–11): versioned per tenant,
 * published with a required base version, one connection or nobody per fact.
 */
@Injectable()
export class SourceAuthorityService {
  constructor(
    private readonly db: TenantDatabase,
    private readonly repo: SourcesRepository,
    private readonly audit: AuditTrail,
  ) {}

  show(ctx: TenantContext): Promise<StoredAuthorityVersion | undefined> {
    return this.db.transaction(ctx, (tx) => this.repo.latestAuthority(tx));
  }

  async publish(
    actx: AuthorizedContext<'config.authority.publish'>,
    raw: unknown,
    options: {
      expectedBaseVersion: number;
      /**
       * M9A (§11.4): accept an adapter-declared stable full-read proof for a
       * versioned connection. Only `stable_snapshot` can be accepted.
       */
      proofAcceptances?: ReadonlyArray<{ connectionId: string; reason: string }>;
    },
  ): Promise<StoredAuthorityVersion> {
    assertAuthorized(actx, 'config.authority.publish');
    const ctx = actx.tenant;
    const actor = actx.actor.id;
    const base = (options as { expectedBaseVersion?: number }).expectedBaseVersion;
    if (base === undefined || !Number.isInteger(base) || base < 0) {
      throw new PublishBaseVersionRequiredError('an authority declaration');
    }
    if (!/^[A-Za-z0-9_.:@-]{1,128}$/.test(actor)) {
      throw new SourcesError('invalid_actor', 'Invalid actor');
    }
    const parsed = AuthorityDocumentSchema.safeParse(raw);
    if (!parsed.success) {
      throw new AuthorityInvalidError(
        parsed.error.issues.map((i) => ({
          code: 'invalid_document',
          path: i.path.join('.'),
          message: i.message,
        })),
      );
    }
    const doc = parsed.data;
    return this.db.transaction(ctx, async (tx) => {
      await tenantAdvisoryLock(tx, 'source-authority', 'tenant');
      const latest = await this.repo.latestAuthority(tx);
      const latestVersion = latest?.version ?? 0;
      if (base !== latestVersion) {
        throw new ConcurrentSourcePublishError('The authority declaration', base, latestVersion);
      }
      const issues: Issue[] = [];
      for (const fact of AUTHORITY_FACTS) {
        const id = doc.facts[fact];
        if (!id) continue;
        const connection = await this.repo.connection(tx, id);
        if (!connection) {
          issues.push({
            code: 'unknown_connection',
            path: `facts.${fact}`,
            message: `no connection ${id}`,
          });
          continue;
        }
        const fixed = CODE_KIND_FACTS[connection.kind];
        if (connection.mappingMode === 'code' && !fixed?.includes(fact)) {
          issues.push({
            code: 'authority_not_supported',
            path: `facts.${fact}`,
            message: `${connection.kind} cannot provide ${fact}`,
          });
        }
      }
      // No cross-source line matching (ADR 0020 §10): state and terms come from
      // the lines' own source, or nobody.
      for (const fact of ['subscription_state', 'subscription_terms'] as const) {
        const id = doc.facts[fact];
        if (id && id !== doc.facts.subscription_lines) {
          issues.push({
            code: 'cross_source_unsupported',
            path: `facts.${fact}`,
            message: `${fact} must come from the subscription_lines connection or stay unassigned`,
          });
        }
      }
      // Holding gate: a versioned source decides holdings only with a confirmed filter.
      const linesId = doc.facts.subscription_lines;
      if (linesId) {
        const connection = await this.repo.connection(tx, linesId);
        if (connection?.mappingMode === 'versioned') {
          const mapping = await this.repo.latestMapping(tx, linesId);
          const objects = mapping
            ? MappingDocumentSchema.parse(mapping.document).objects.filter(
                (o) => o.entity === 'subscription',
              )
            : [];
          if (objects.length === 0 || !objects.every(holdingsConfirmed)) {
            issues.push({
              code: 'holding_filter_required',
              path: 'facts.subscription_lines',
              message:
                'publish a mapping whose subscription objects declare a confirmed holding filter or a confirmed all-holdings statement first',
            });
          }
        }
      }
      const at = new Date().toISOString();
      const acceptances: ProofAcceptance[] = [];
      for (const [i, a] of (options.proofAcceptances ?? []).entries()) {
        const parsed = ProofAcceptanceSchema.safeParse({
          connectionId: a.connectionId,
          tier: 'stable_snapshot',
          reason: a.reason,
          actor,
          at,
        });
        const connection = parsed.success
          ? await this.repo.connection(tx, a.connectionId)
          : undefined;
        if (!parsed.success || !connection || connection.mappingMode !== 'versioned') {
          issues.push({
            code: 'invalid_proof_acceptance',
            path: `proofAcceptances.${i}`,
            message: 'an acceptance names a versioned connection of this tenant and a reason',
          });
          continue;
        }
        if (acceptances.some((x) => x.connectionId === a.connectionId)) {
          issues.push({
            code: 'invalid_proof_acceptance',
            path: `proofAcceptances.${i}`,
            message: 'a connection is accepted once',
          });
          continue;
        }
        acceptances.push(parsed.data);
      }
      if (issues.length > 0) throw new AuthorityInvalidError(issues);
      const stored = await this.repo.insertAuthority(tx, {
        version: latestVersion + 1,
        document: doc,
        // Unchanged from M8 while there are no acceptances (hash parity).
        contentHash: authorityContentHashWith(doc, acceptances),
        publishedBy: actor,
        proofAcceptances: acceptances,
      });
      await this.audit.record(tx, actx, {
        action: 'authority.publish',
        targetKind: 'authority',
        targetRef: `v${stored.version}`,
        details: {
          version: stored.version,
          baseVersion: latestVersion,
          proofAcceptances: acceptances.length,
        },
      });
      return stored;
    });
  }
}

export type { AuthorityDocument };
