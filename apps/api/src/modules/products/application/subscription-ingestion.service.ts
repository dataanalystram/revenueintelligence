import { Injectable } from '@nestjs/common';
import {
  canonicalHash,
  decideApplyWithHash,
  ProductKeySchema,
  SubscriptionObservationSchema,
  type ApplyDecision,
  type SubscriptionObservation,
} from '../../domain';
import { TenantDatabase, type TenantContext, type TenantTransaction } from '../../tenancy';
import {
  SubscriptionStore,
  type SubscriptionRow,
  type SubscriptionValues,
} from '../infrastructure/subscription.store';
import { SubscriptionQueries } from '../infrastructure/subscription.queries';
import { ProductCatalogueService } from './product-catalogue.service';

export type SubscriptionCause =
  'import' | 'backfill' | 'reconciliation' | 'webhook' | 'replay' | 'resync';

export interface SubscriptionIngestMeta {
  readonly cause: SubscriptionCause;
  readonly correlationId: string;
  readonly checkpointId?: string;
  /** Producing adapter (e.g. `csv_import`, later a connector) and its version. */
  readonly adapter: string;
  readonly adapterVersion: string;
}

export type SubscriptionIngestOutcome =
  | {
      readonly outcome: 'created' | 'updated' | 'restored' | 'deleted';
      readonly subscriptionId: string;
      readonly changedFields: readonly string[];
    }
  | { readonly outcome: 'unchanged' | 'stale' | 'not_found'; readonly subscriptionId?: string }
  | {
      readonly outcome: 'rejected';
      readonly reason: 'unknown_account' | 'unknown_product' | 'invalid_observation';
    };

const MAX_LOCK_ROUNDS = 5;

/**
 * The single subscription writer (ADR 0017 §3): imports now, connectors in M8.
 * One tenant transaction per line; the line lock first, then the
 * canonical-company lock(s) before touching any subscription row, so a line can
 * never land on a company merged away concurrently and no lock cycle is
 * possible. Ordering, tombstones and idempotency follow `decideApply`.
 */
@Injectable()
export class SubscriptionIngestionService {
  constructor(
    private readonly db: TenantDatabase,
    private readonly store: SubscriptionStore,
    private readonly queries: SubscriptionQueries,
    private readonly catalogue: ProductCatalogueService,
  ) {}

  async ingest(
    ctx: TenantContext,
    observation: SubscriptionObservation,
    meta: SubscriptionIngestMeta,
  ): Promise<SubscriptionIngestOutcome> {
    const parsed = SubscriptionObservationSchema.safeParse(observation);
    if (!parsed.success) return { outcome: 'rejected', reason: 'invalid_observation' };
    return this.db.transaction(ctx, (tx) => this.apply(tx, parsed.data, meta));
  }

  private async apply(
    tx: TenantTransaction,
    obs: SubscriptionObservation,
    meta: SubscriptionIngestMeta,
  ): Promise<SubscriptionIngestOutcome> {
    await this.store.lockLine(tx, obs.source);
    const before = await this.store.findBySource(tx, obs.source);

    if (obs.presence === 'absent') {
      const decision = decideApplyWithHash(storedRef(before), obs, undefined);
      if (decision !== 'delete' || !before)
        return {
          outcome:
            decision === 'delete' ? 'not_found' : (decision as 'unchanged' | 'stale' | 'not_found'),
        };
      const stored = await this.lockOwnerAndReload(tx, obs, [before.companyId]);
      if (!stored || stored.recordState === 'deleted')
        return { outcome: 'unchanged', subscriptionId: before.id };
      await this.store.update(tx, stored.id, { recordState: 'deleted', deletedAt: obs.observedAt });
      await this.store.insertChange(tx, {
        subscriptionId: stored.id,
        changeType: 'state_changed',
        changedFields: ['recordState'],
        source: obs.source,
        cause: meta.cause,
        ...(meta.checkpointId ? { checkpointId: meta.checkpointId } : {}),
        ...(obs.sourceUpdatedAt ? { sourceUpdatedAt: obs.sourceUpdatedAt } : {}),
        adapter: meta.adapter,
        adapterVersion: meta.adapterVersion,
        correlationId: meta.correlationId,
      });
      return { outcome: 'deleted', subscriptionId: stored.id, changedFields: ['recordState'] };
    }

    const productKey = await this.resolveProduct(tx, obs.productRef);
    if (!productKey) return { outcome: 'rejected', reason: 'unknown_product' };
    let companyId = await this.queries.resolveCompany(tx, obs.companyRef);
    if (!companyId) return { outcome: 'rejected', reason: 'unknown_account' };

    // Lock every company this write touches (target, and current owner if the
    // line moves), then re-resolve: a merge that committed meanwhile is followed.
    const locked = new Set<string>();
    let stored: SubscriptionRow | undefined = before;
    for (let round = 0; ; round += 1) {
      if (round >= MAX_LOCK_ROUNDS) throw new Error('company lineage kept changing while locking');
      const wanted = [companyId, ...(stored ? [stored.companyId] : [])].filter(
        (id) => !locked.has(id),
      );
      if (wanted.length === 0) break;
      await this.store.lockCompanies(tx, wanted);
      wanted.forEach((id) => locked.add(id));
      companyId = await this.queries.canonicalCompany(tx, companyId);
      stored = await this.store.findBySource(tx, obs.source);
    }

    const hash = canonicalHash({
      companyRef: obs.companyRef,
      productRef: obs.productRef,
      state: obs.state,
      startsAt: obs.startsAt,
      endsAt: obs.endsAt,
      quantity: obs.quantity,
    });
    const values: SubscriptionValues = {
      companyId,
      productKey,
      state: obs.state,
      startsAt: obs.startsAt ?? null,
      endsAt: obs.endsAt ?? null,
      quantity: obs.quantity ?? null,
      sourceUpdatedAt: obs.sourceUpdatedAt ?? null,
      fieldHash: hash,
    };
    const decision: ApplyDecision = decideApplyWithHash(storedRef(stored), obs, hash);
    const change = (
      subscriptionId: string,
      changeType: 'created' | 'updated' | 'state_changed',
      changedFields: string[],
    ) =>
      this.store.insertChange(tx, {
        subscriptionId,
        changeType,
        changedFields,
        source: obs.source,
        cause: meta.cause,
        ...(meta.checkpointId ? { checkpointId: meta.checkpointId } : {}),
        ...(obs.sourceUpdatedAt ? { sourceUpdatedAt: obs.sourceUpdatedAt } : {}),
        adapter: meta.adapter,
        adapterVersion: meta.adapterVersion,
        correlationId: meta.correlationId,
      });

    if (decision === 'create' || !stored) {
      const id = await this.store.insert(tx, obs.source, values, obs.observedAt);
      const fields = ['companyId', 'productKey', 'state', ...presentFields(values)];
      await change(id, 'created', fields);
      return { outcome: 'created', subscriptionId: id, changedFields: fields };
    }

    // The line exists at the source in this read: it was seen (tombstone pass).
    const seen = {
      lastSeenAt: maxDate(stored.lastSeenAt, obs.observedAt),
      observedAt: maxDate(stored.observedAt, obs.observedAt),
    };
    if (
      decision === 'stale' ||
      decision === 'unchanged' ||
      decision === 'not_found' ||
      decision === 'delete'
    ) {
      if (stored.recordState === 'active') await this.store.update(tx, stored.id, seen);
      return {
        outcome: decision === 'unchanged' ? 'unchanged' : 'stale',
        subscriptionId: stored.id,
      };
    }

    // apply / restore
    const fields = changedFields(stored, values);
    const restoring = decision === 'restore';
    await this.store.update(tx, stored.id, {
      ...values,
      ...seen,
      ...(restoring ? { recordState: 'active' as const, deletedAt: null } : {}),
    });
    if (restoring) {
      await change(stored.id, 'state_changed', ['recordState', ...fields]);
      return {
        outcome: 'restored',
        subscriptionId: stored.id,
        changedFields: ['recordState', ...fields],
      };
    }
    if (fields.length === 0) return { outcome: 'unchanged', subscriptionId: stored.id };
    await change(stored.id, fields.includes('state') ? 'state_changed' : 'updated', fields);
    return { outcome: 'updated', subscriptionId: stored.id, changedFields: fields };
  }

  private async lockOwnerAndReload(
    tx: TenantTransaction,
    obs: SubscriptionObservation,
    companyIds: string[],
  ): Promise<SubscriptionRow | undefined> {
    const locked = new Set<string>();
    let stored: SubscriptionRow | undefined;
    for (let round = 0; round < MAX_LOCK_ROUNDS; round += 1) {
      const wanted = companyIds.filter((id) => !locked.has(id));
      if (wanted.length === 0) return stored;
      await this.store.lockCompanies(tx, wanted);
      wanted.forEach((id) => locked.add(id));
      stored = await this.store.findBySource(tx, obs.source);
      companyIds = stored ? [stored.companyId] : [];
    }
    throw new Error('company lineage kept changing while locking');
  }

  /** Whether a product reference resolves (import dry runs). */
  async resolvesProduct(tx: TenantTransaction, ref: string): Promise<boolean> {
    return (await this.resolveProduct(tx, ref)) !== undefined;
  }

  /** A product key, or a source product id mapped by the active model's externalRefs. */
  private async resolveProduct(tx: TenantTransaction, ref: string): Promise<string | undefined> {
    const asKey = ProductKeySchema.safeParse(ref);
    if (asKey.success && (await this.queries.productExists(tx, asKey.data))) return asKey.data;
    const m = /^([a-z_]+):([A-Za-z0-9_]+):(.+)$/.exec(ref);
    if (!m) return undefined;
    const model = await this.catalogue.modelAtTx(tx, new Date());
    const hit = model?.document.products.find((p) =>
      p.externalRefs.some((r) => r.system === m[1] && r.objectType === m[2] && r.id === m[3]),
    );
    return hit?.key;
  }
}

function storedRef(row: SubscriptionRow | undefined) {
  if (!row) return undefined;
  return {
    state: row.recordState === 'deleted' ? ('deleted' as const) : ('active' as const),
    ...(row.sourceUpdatedAt ? { sourceUpdatedAt: row.sourceUpdatedAt } : {}),
    ...(row.fieldHash ? { fieldHash: row.fieldHash } : {}),
    ...(row.deletedAt ? { deletedAt: row.deletedAt } : {}),
    lastSeenAt: row.lastSeenAt,
  };
}

function presentFields(v: SubscriptionValues): string[] {
  return [
    ...(v.startsAt ? ['startsAt'] : []),
    ...(v.endsAt ? ['endsAt'] : []),
    ...(v.quantity !== null ? ['quantity'] : []),
  ];
}

function changedFields(stored: SubscriptionRow, next: SubscriptionValues): string[] {
  const t = (d: Date | null) => (d ? d.getTime() : null);
  const out: string[] = [];
  if (stored.companyId !== next.companyId) out.push('companyId');
  if (stored.productKey !== next.productKey) out.push('productKey');
  if (stored.state !== next.state) out.push('state');
  if (t(stored.startsAt) !== t(next.startsAt)) out.push('startsAt');
  if (t(stored.endsAt) !== t(next.endsAt)) out.push('endsAt');
  if (stored.quantity !== next.quantity) out.push('quantity');
  return out;
}

function maxDate(a: Date, b: Date): Date {
  return a.getTime() >= b.getTime() ? a : b;
}
