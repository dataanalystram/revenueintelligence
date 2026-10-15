import { Injectable } from '@nestjs/common';
import { GovernanceError } from '../../governance';
import {
  assertAuthorized,
  AuditFailures,
  AuditTrail,
  TenantDatabase,
  type AuthorizedContext,
  type TenantTransaction,
} from '../../tenancy';
import {
  AccountContextStore,
  type AccountContextRow,
} from '../infrastructure/account-context.store';
import type { DimensionValue } from './account-context.rules';
import { requireUuid } from './account-structure.shared';

/** Read bound per call (contexts, lines); more is flagged `truncated`, never silently cut. */
export const ACCOUNT_CONTEXT_READ_BOUND = 1000;
/** Accounts per `listForAccounts` call. */
export const ACCOUNT_CONTEXT_READ_ACCOUNTS = 500;
const WITHHELD_SENSITIVITIES: ReadonlySet<string> = new Set(['confidential', 'restricted']);

export interface AccountContextView {
  readonly id: string;
  readonly companyId: string;
  readonly type: string;
  readonly typeId: string;
  readonly name: string;
  readonly status: string;
  readonly ownerRef: string | null;
  readonly renewalDate: string | null;
  readonly recordState: string;
  readonly mergedIntoId: string | null;
  readonly dimensions: Readonly<Record<string, DimensionValue>>;
  readonly persons: readonly {
    readonly personId: string;
    readonly role: string;
    readonly status: string;
    readonly startedAt: Date;
    readonly endedAt: Date | null;
  }[];
  readonly products: readonly { readonly productKey: string; readonly origin: string }[];
  /**
   * M10E 2b: attributes withheld from this read (`renewalDate`, `dimension.<key>` of a
   * confidential / restricted dimension) unless `includeConfidential` (audited).
   */
  readonly withheld: readonly string[];
}

export interface AccountContextList {
  readonly contexts: readonly AccountContextView[];
  readonly truncated: boolean;
}

export interface ContextLineList {
  readonly contextId: string;
  readonly lines: readonly {
    readonly id: string;
    readonly companyId: string;
    readonly productKey: string;
    readonly state: string;
  }[];
  readonly truncated: boolean;
}

/**
 * Read models of M10E AccountContext (plan §8): contexts of a batch of
 * accounts (with members and products: four queries per call whatever the
 * number of contexts — no N+1), one context, and the lines of a context. The
 * optional `scope` (context ids) is the future authorization hook (Q21).
 * Reads are allowed whatever the gate says (Q18 / Q20: data kept and
 * readable). Each call writes one `account_context.read` audit event
 * (capability `data.account_context.read`, operator only; identifiers and
 * counts, Q25). Output is identifiers, codes, dates and the classified
 * dimension values — never logged.
 */
@Injectable()
export class AccountContextReadModel {
  constructor(
    private readonly db: TenantDatabase,
    private readonly store: AccountContextStore,
    readonly audit: AuditTrail,
  ) {}

  @AuditFailures('account_context.read', 'account_context')
  async listForAccounts(
    actx: AuthorizedContext<'data.account_context.read'>,
    query: {
      readonly companyIds: readonly string[];
      readonly scope?: readonly string[];
      readonly includeConfidential?: boolean;
    },
  ): Promise<AccountContextList> {
    assertAuthorized(actx, 'data.account_context.read');
    const companyIds = [...new Set(query.companyIds.map((id) => requireUuid(id, '--account')))];
    if (companyIds.length === 0 || companyIds.length > ACCOUNT_CONTEXT_READ_ACCOUNTS) {
      throw new GovernanceError(
        'validation_failed',
        `Name 1–${ACCOUNT_CONTEXT_READ_ACCOUNTS} accounts`,
      );
    }
    const scope = query.scope?.map((id) => requireUuid(id, '--scope'));
    return this.db.transaction(actx.tenant, async (tx) => {
      const rows = await this.store.contextsForCompanies(
        tx,
        companyIds,
        scope,
        ACCOUNT_CONTEXT_READ_BOUND + 1,
      );
      const truncated = rows.length > ACCOUNT_CONTEXT_READ_BOUND;
      const contexts = await this.views(
        tx,
        rows.slice(0, ACCOUNT_CONTEXT_READ_BOUND),
        query.includeConfidential === true,
      );
      await this.audit.record(tx, actx, {
        action: 'account_context.read',
        targetKind: 'account_context',
        targetRef: companyIds.length === 1 ? companyIds[0]! : 'accounts',
        details: {
          operation: 'list',
          accounts: companyIds.length,
          scoped: scope !== undefined,
          contexts: contexts.length,
          truncated,
          includeConfidential: query.includeConfidential === true,
        },
      });
      return { contexts, truncated };
    });
  }

  @AuditFailures('account_context.read', 'account_context')
  async get(
    actx: AuthorizedContext<'data.account_context.read'>,
    query: { readonly contextId: string; readonly includeConfidential?: boolean },
  ): Promise<AccountContextView> {
    assertAuthorized(actx, 'data.account_context.read');
    const id = requireUuid(query.contextId, '--context');
    return this.db.transaction(actx.tenant, async (tx) => {
      const row = await this.store.context(tx, id);
      if (!row) throw new GovernanceError('validation_failed', 'The context does not exist');
      const [view] = await this.views(tx, [row], query.includeConfidential === true);
      await this.audit.record(tx, actx, {
        action: 'account_context.read',
        targetKind: 'account_context',
        targetRef: id,
        details: {
          operation: 'show',
          persons: view!.persons.length,
          products: view!.products.length,
          includeConfidential: query.includeConfidential === true,
        },
      });
      return view!;
    });
  }

  @AuditFailures('account_context.read', 'account_context')
  async linesForContext(
    actx: AuthorizedContext<'data.account_context.read'>,
    query: { readonly contextId: string },
  ): Promise<ContextLineList> {
    assertAuthorized(actx, 'data.account_context.read');
    const id = requireUuid(query.contextId, '--context');
    return this.db.transaction(actx.tenant, async (tx) => {
      if (!(await this.store.context(tx, id))) {
        throw new GovernanceError('validation_failed', 'The context does not exist');
      }
      const rows = await this.store.linesOfContexts(tx, [id], ACCOUNT_CONTEXT_READ_BOUND + 1);
      const truncated = rows.length > ACCOUNT_CONTEXT_READ_BOUND;
      const lines = rows.slice(0, ACCOUNT_CONTEXT_READ_BOUND).map((l) => ({
        id: l.id,
        companyId: l.companyId,
        productKey: l.productKey,
        state: l.state,
      }));
      await this.audit.record(tx, actx, {
        action: 'account_context.read',
        targetKind: 'account_context',
        targetRef: id,
        details: { operation: 'lines', lines: lines.length, truncated },
      });
      return { contextId: id, lines, truncated };
    });
  }

  /** Batch assembly: one query each for types, members and products. */
  private async views(
    tx: TenantTransaction,
    rows: readonly AccountContextRow[],
    includeConfidential = false,
  ): Promise<AccountContextView[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const types = await this.store.contextTypes(tx);
    const members = await this.store.membersOfContexts(tx, ids);
    const products = await this.store.productsOfContexts(tx, ids);
    const membersBy = groupBy(members, (m) => m.contextId);
    const productsBy = groupBy(products, (p) => p.contextId);
    return rows.map((r) => {
      const type = types.byId.get(r.contextTypeId);
      const withheld: string[] = [];
      const dimensions: Record<string, DimensionValue> = {};
      for (const [key, value] of Object.entries(r.dimensions)) {
        const sensitivity =
          type?.definition.dimensions.find((d) => d.key === key)?.sensitivity ?? 'internal';
        if (!includeConfidential && WITHHELD_SENSITIVITIES.has(sensitivity)) {
          withheld.push(`dimension.${key}`);
        } else {
          dimensions[key] = value;
        }
      }
      // renewal_date is confidential / financial (plan §6).
      const showRenewal = includeConfidential || r.renewalDate === null;
      if (!showRenewal) withheld.push('renewalDate');
      return {
        id: r.id,
        companyId: r.companyId,
        type: types.byId.get(r.contextTypeId)?.key ?? '',
        typeId: r.contextTypeId,
        name: r.name,
        status: r.status,
        ownerRef: r.ownerRef,
        renewalDate: showRenewal ? r.renewalDate : null,
        recordState: r.recordState,
        mergedIntoId: r.mergedIntoId,
        dimensions,
        persons: (membersBy.get(r.id) ?? []).map((m) => ({
          personId: m.personId,
          role: m.roleCode,
          status: m.status,
          startedAt: m.startedAt,
          endedAt: m.endedAt,
        })),
        products: (productsBy.get(r.id) ?? []).map((p) => ({
          productKey: p.productKey,
          origin: p.origin,
        })),
        withheld,
      };
    });
  }
}

function groupBy<T>(items: readonly T[], key: (t: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = out.get(k);
    if (list) list.push(item);
    else out.set(k, [item]);
  }
  return out;
}
