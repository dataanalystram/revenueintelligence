import { Inject, Injectable } from '@nestjs/common';
import {
  assertAuthorized,
  AuditFailures,
  AuditTrail,
  TenantDatabase,
  type AuthorizedContext,
} from '../../tenancy';
import { APP_CONFIG, type AppConfig } from '../../../platform/config';
import { GovernanceError } from '../../governance';
import { AccountStructureStore } from '../infrastructure/account-structure.store';
import { requireUuid } from './account-structure.shared';

export interface HierarchyView {
  readonly companyId: string;
  readonly recordState: string;
  readonly parentId: string | null;
  readonly origin: string | null;
  /** `[company, parent, …, root]`. */
  readonly ancestors: readonly string[];
  readonly rootId: string;
  /** Edges from the root (a root has depth 0). */
  readonly depth: number;
  /** The walk stopped at its bound (guardrail + 1) without reaching a root. */
  readonly truncated: boolean;
  readonly descendants?: readonly { id: string; parentId: string; depth: number }[];
  readonly descendantsTruncated?: boolean;
}

export interface AffiliationView {
  readonly id: string;
  readonly personId: string;
  readonly companyId: string;
  readonly status: string;
  readonly roleCodes: readonly string[];
  readonly startsAt: Date | null;
  readonly endsAt: Date | null;
  readonly endedAt: Date | null;
  readonly endReason: string | null;
  readonly mergedIntoId: string | null;
  readonly origin: string;
  /** Derived (Q9): the affiliation's company is the person's primary account. Never stored. */
  readonly isPrimary: boolean;
}

/**
 * Read models of the account structure (M10C plan §5): the hierarchy around an
 * account (ancestors, root, depth, descendants; bounded by the guardrail + 1,
 * a deeper tree is truncated and flagged, never looped) and the affiliations
 * of a person or an account with the derived primary flag. Read-only on
 * canonical data; each call writes one `account_structure.read` audit event
 * (capability `data.account_structure.read`, operator only, Q16). Output is
 * identifiers, codes and dates — affiliations are personal data.
 * Derived group roll-ups (owned products across a subtree) are not part of
 * this read model (products module; M10C phase 3).
 */
@Injectable()
export class AccountStructureReadModel {
  constructor(
    private readonly db: TenantDatabase,
    private readonly store: AccountStructureStore,
    readonly audit: AuditTrail,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private get bound(): number {
    return ((this.config as Partial<AppConfig>).canonical?.hierarchyMaxDepth ?? 10) + 1;
  }

  @AuditFailures('account_structure.read', 'account_hierarchy')
  async hierarchy(
    actx: AuthorizedContext<'data.account_structure.read'>,
    query: { readonly companyId: string; readonly descendants?: boolean },
  ): Promise<HierarchyView> {
    assertAuthorized(actx, 'data.account_structure.read');
    const companyId = requireUuid(query.companyId, '--company');
    return this.db.transaction(actx.tenant, async (tx) => {
      const company = await this.store.company(tx, companyId);
      if (!company) throw new GovernanceError('validation_failed', 'The company does not exist');
      const walk = await this.store.path(tx, companyId, this.bound);
      let descendants: { id: string; parentId: string; depth: number }[] | undefined;
      let descendantsTruncated = false;
      if (query.descendants) {
        descendants = await this.store.descendants(tx, companyId, this.bound);
        descendantsTruncated = descendants.some((d) => d.depth >= this.bound);
      }
      await this.audit.record(tx, actx, {
        action: 'account_structure.read',
        targetKind: 'account_hierarchy',
        targetRef: companyId,
        details: {
          ancestors: walk.path.length - 1,
          truncated: walk.truncated,
          descendants: descendants?.length ?? null,
        },
      });
      return {
        companyId,
        recordState: company.recordState,
        parentId: company.parentId,
        origin: company.origin,
        ancestors: walk.path,
        rootId: walk.path[walk.path.length - 1] ?? companyId,
        depth: walk.path.length - 1,
        truncated: walk.truncated,
        ...(descendants ? { descendants, descendantsTruncated } : {}),
      };
    });
  }

  @AuditFailures('account_structure.read', 'person_affiliation')
  async affiliations(
    actx: AuthorizedContext<'data.account_structure.read'>,
    query: {
      readonly personId?: string;
      readonly companyId?: string;
      readonly activeOnly?: boolean;
    },
  ): Promise<readonly AffiliationView[]> {
    assertAuthorized(actx, 'data.account_structure.read');
    if ((query.personId === undefined) === (query.companyId === undefined)) {
      throw new GovernanceError('validation_failed', 'Name exactly one of --person / --company');
    }
    const personId = query.personId ? requireUuid(query.personId, '--person') : undefined;
    const companyId = query.companyId ? requireUuid(query.companyId, '--company') : undefined;
    return this.db.transaction(actx.tenant, async (tx) => {
      const rows = await this.store.affiliationsOf(tx, {
        ...(personId ? { personId } : {}),
        ...(companyId ? { companyId } : {}),
        ...(query.activeOnly ? { activeOnly: true } : {}),
      });
      const primaries = new Map<string, string | null>();
      for (const id of new Set(rows.map((r) => r.personId))) {
        primaries.set(id, (await this.store.person(tx, id))?.companyId ?? null);
      }
      await this.audit.record(tx, actx, {
        action: 'account_structure.read',
        targetKind: 'person_affiliation',
        targetRef: personId ?? companyId!,
        details: { subject: personId ? 'person' : 'company', affiliations: rows.length },
      });
      return rows.map((r) => ({
        id: r.id,
        personId: r.personId,
        companyId: r.companyId,
        status: r.status,
        roleCodes: r.roleCodes,
        startsAt: r.startsAt,
        endsAt: r.endsAt,
        endedAt: r.endedAt,
        endReason: r.endReason,
        mergedIntoId: r.mergedIntoId,
        origin: r.origin,
        isPrimary: primaries.get(r.personId) === r.companyId,
      }));
    });
  }
}
