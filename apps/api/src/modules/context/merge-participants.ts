import type { ExternalRef, SecurityActor } from '../domain';
import type { TenantTransaction } from '../tenancy';

/**
 * Account-merge participation (ADR 0017 §8). The canonical company merge stays
 * one workflow in this module; other modules that hold facts about companies
 * plug in here and act **inside the same transaction**, right after the
 * merge has repointed references and people. Dependency inversion: context
 * defines the port, the owning module implements it, the composition root
 * wires it — context never imports those modules.
 */
export interface CompanyMerge {
  /** The canonical company merged away (kept, `merged`). */
  readonly loserId: string;
  /** The surviving canonical company. */
  readonly survivorId: string;
  /** Provenance of the merge itself, to be recorded with every moved fact. */
  readonly provenance: {
    readonly source: ExternalRef;
    readonly cause: string;
    readonly receiptDeliveryKey?: string;
    readonly checkpointId?: string;
    readonly sourceUpdatedAt?: Date;
    readonly adapter: string;
    readonly adapterVersion: string;
    readonly correlationId: string;
    /** M10A1: who wrote the merge. */
    readonly actor?: SecurityActor;
  };
}

export interface CompanyMergeParticipant {
  onCompanyMerged(tx: TenantTransaction, merge: CompanyMerge): Promise<void>;
}

export const COMPANY_MERGE_PARTICIPANTS = Symbol('COMPANY_MERGE_PARTICIPANTS');

/**
 * Advisory-lock scope for a canonical company. The merge takes it for the
 * loser and the survivor before repointing; writers of company-owned facts take
 * it before touching their rows, so a write can never land on a company merged
 * away concurrently (see `tenantAdvisoryLock`).
 */
export const COMPANY_CANONICAL_LOCK_SCOPE = 'company-canonical';

/**
 * Person-merge participation (M10C plan §4): mirrors the company port. The
 * person merge stays one workflow in `ContextIngestionService.merge`;
 * participants act inside the same transaction after the references moved
 * and before the loser is marked merged.
 */
export interface PersonMerge {
  /** The canonical person merged away (kept, `merged`). */
  readonly loserId: string;
  /** The surviving canonical person. */
  readonly survivorId: string;
  /** Provenance of the merge itself, to be recorded with every moved fact. */
  readonly provenance: CompanyMerge['provenance'];
}

export interface PersonMergeParticipant {
  onPersonMerged(tx: TenantTransaction, merge: PersonMerge): Promise<void>;
}

export const PERSON_MERGE_PARTICIPANTS = Symbol('PERSON_MERGE_PARTICIPANTS');

/** Advisory-lock scope for a canonical person (affiliation writers; taken after company locks). */
export const PERSON_CANONICAL_LOCK_SCOPE = 'person-canonical';
