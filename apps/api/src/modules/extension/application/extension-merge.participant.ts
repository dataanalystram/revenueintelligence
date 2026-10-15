import { Injectable } from '@nestjs/common';
import type { ConnectorKind, SecurityActor } from '../../domain';
import type { TenantTransaction } from '../../tenancy';
import { CustomRecordWriter } from './custom-record.writer';
import type { ExtensionProvenance } from './extension-shared';
import { ExtensionValueWriter } from './extension-value.writer';

/**
 * The merge as the context module's company / person merge ports describe it
 * (structurally identical to `CompanyMerge` / `PersonMerge`; the extension
 * module does not import context, which wires this participant).
 */
export interface EntityMerge {
  readonly loserId: string;
  readonly survivorId: string;
  readonly provenance: {
    readonly source: { readonly system: string; readonly objectType: string; readonly id: string };
    readonly cause: string;
    readonly receiptDeliveryKey?: string;
    readonly checkpointId?: string;
    readonly sourceUpdatedAt?: Date;
    readonly adapter: string;
    readonly adapterVersion: string;
    readonly correlationId: string;
    readonly actor?: SecurityActor;
  };
}

/**
 * `ExtensionMergeParticipant` (M10D plan §7, Q22): implements the company and
 * the person merge ports inside the merge transaction. Loser-only values are
 * copied to the survivor; equal values skipped; differing values keep the
 * survivor's and open `extension_value_conflict` (never silently
 * overwritten); custom records whose parent is the loser are re-pointed.
 * Reference values and custom relationships are not rewritten: readers follow
 * merge lineage. Runs whatever the gate says (a tenant rolled back to 0.3 or
 * with the module disabled still has its stored values kept consistent by a
 * merge; the merge itself is never blocked).
 */
@Injectable()
export class ExtensionMergeParticipant {
  constructor(
    private readonly values: ExtensionValueWriter,
    private readonly records: CustomRecordWriter,
  ) {}

  onCompanyMerged(tx: TenantTransaction, merge: EntityMerge): Promise<void> {
    return this.onMerged(tx, 'company', merge);
  }

  onPersonMerged(tx: TenantTransaction, merge: EntityMerge): Promise<void> {
    return this.onMerged(tx, 'person', merge);
  }

  private async onMerged(
    tx: TenantTransaction,
    kind: 'company' | 'person',
    merge: EntityMerge,
  ): Promise<void> {
    const provenance: ExtensionProvenance = {
      ...merge.provenance,
      source: {
        ...merge.provenance.source,
        system: merge.provenance.source.system as ConnectorKind,
      },
    };
    await this.values.onEntityMerged(tx, kind, merge.loserId, merge.survivorId, provenance);
    await this.records.onParentMerged(tx, kind, merge.loserId, merge.survivorId, provenance);
  }
}
