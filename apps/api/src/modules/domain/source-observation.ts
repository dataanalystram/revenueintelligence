import { createHash } from 'node:crypto';
import { z } from 'zod';
import { EmailAddressSchema, type EmailAddress } from './email';
import { decideReferenceObservation } from './canonical/source-reference';
import type { ExternalRef, ExternalRefState } from './external-ref';

/**
 * What a source system says about one record at one moment (M6, ADR 0014).
 * Every ingestion path (webhook read-back, backfill page, reconciliation
 * page) produces observations; `ContextIngestionService.ingest` is the only
 * consumer. Vendor-neutral: connectors map their payloads into this.
 */
export const ContextKindSchema = z.enum(['company', 'person']);
export type ContextKind = z.infer<typeof ContextKindSchema>;

export interface CompanyFields {
  readonly name?: string;
  /** Normalised web domain. */
  readonly domain?: string;
}

export interface PersonFields {
  readonly email?: EmailAddress;
  readonly firstName?: string;
  readonly lastName?: string;
  readonly jobTitle?: string;
}

/** A person→company link in the source (association), as context only. */
export interface SourceCompanyLink {
  readonly company: ExternalRef;
  readonly typeId: number;
  readonly category: 'standard' | 'user_defined' | 'integrator_defined' | 'other';
  readonly primary: boolean;
}

interface ObservationBase {
  readonly ref: ExternalRef;
  /** When the platform read this from the source (orders reads against tombstones). */
  readonly observedAt: Date;
}

export type SourceObservation =
  | (ObservationBase & {
      readonly kind: 'company';
      readonly presence: 'present';
      readonly sourceCreatedAt?: Date;
      readonly sourceUpdatedAt?: Date;
      readonly fields: CompanyFields;
    })
  | (ObservationBase & {
      readonly kind: 'person';
      readonly presence: 'present';
      readonly sourceCreatedAt?: Date;
      readonly sourceUpdatedAt?: Date;
      readonly fields: PersonFields;
      /** undefined = associations not read; [] = the person has no company links. */
      readonly companyLinks?: readonly SourceCompanyLink[];
    })
  | (ObservationBase & {
      readonly kind: ContextKind;
      /** The source does not return the record now (deleted, or never existed). */
      readonly presence: 'absent';
    });

export type PresentObservation = Extract<SourceObservation, { presence: 'present' }>;

const DomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/);

function text(value: string | undefined, max: number): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

/** Normalises source company values; invalid values are dropped, never guessed. */
export function companyFields(raw: { name?: string; domain?: string }): CompanyFields {
  const domain = DomainSchema.safeParse(raw.domain ?? '');
  return {
    ...(text(raw.name, 500) ? { name: text(raw.name, 500) } : {}),
    ...(domain.success ? { domain: domain.data } : {}),
  };
}

/** Normalises source person values; an invalid email is dropped (never stored). */
export function personFields(raw: {
  email?: string;
  firstName?: string;
  lastName?: string;
  jobTitle?: string;
}): PersonFields {
  const email = EmailAddressSchema.safeParse(raw.email ?? '');
  return {
    ...(email.success ? { email: email.data } : {}),
    ...(text(raw.firstName, 200) ? { firstName: text(raw.firstName, 200) } : {}),
    ...(text(raw.lastName, 200) ? { lastName: text(raw.lastName, 200) } : {}),
    ...(text(raw.jobTitle, 300) ? { jobTitle: text(raw.jobTitle, 300) } : {}),
  };
}

/** SHA-256 over the mapped fields in a fixed order: equality without storing values twice. */
export function fieldHash(observation: PresentObservation): string {
  const f = observation.fields as Record<string, unknown>;
  const ordered = Object.keys(f)
    .sort()
    .map((k) => [k, f[k]]);
  const links =
    observation.kind === 'person' && observation.companyLinks
      ? [...observation.companyLinks]
          .map((l) => `${l.company.id}:${l.typeId}:${l.primary ? 1 : 0}`)
          .sort()
      : null;
  return createHash('sha256')
    .update(JSON.stringify({ kind: observation.kind, fields: ordered, links }))
    .digest('hex');
}

/** What the platform already knows about a source record (its external reference). */
export interface StoredReference {
  readonly state: ExternalRefState;
  readonly sourceUpdatedAt?: Date;
  readonly fieldHash?: string;
  readonly deletedAt?: Date;
  /** M9B: when an accepted full read retired the reference (state `retired`). */
  readonly retiredAt?: Date;
  /** Latest time the record was read as present. */
  readonly lastSeenAt?: Date;
}

export type ApplyDecision =
  /** New source record: create a canonical record and the reference. */
  | 'create'
  /** Newer source state: update the canonical record. */
  | 'apply'
  /** A tombstoned (or retired) record read as present after that was recorded. */
  | 'restore'
  /** The source no longer returns the record: tombstone the reference. */
  | 'delete'
  /** Same source state as stored: only the last-seen time moves. */
  | 'unchanged'
  /** Older than what is stored (out of order, or read before a tombstone): no-op. */
  | 'stale'
  /** Absent at the source and unknown to the platform: nothing to do. */
  | 'not_found';

/**
 * Decides how an observation relates to the stored reference (pure; ADR 0014).
 *
 * - Source modification time orders two present observations; equal times
 *   with equal field hashes are unchanged; equal times with different hashes
 *   apply (the later read wins).
 * - Read time orders presence against absence: a record read as present
 *   before its deletion was recorded cannot revive it, and an absence read
 *   before a later presence is stale.
 */
export function decideApply(
  stored: StoredReference | undefined,
  observation: SourceObservation,
): ApplyDecision {
  return decideApplyWithHash(
    stored,
    observation,
    observation.presence === 'present' ? fieldHash(observation) : undefined,
  );
}

/**
 * The ordering rules of `decideApply` for any source record kind, given the
 * hash of the observation's source values (M7 subscriptions reuse it).
 */
export function decideApplyWithHash(
  stored: StoredReference | undefined,
  observation: {
    readonly presence: 'present' | 'absent';
    readonly observedAt: Date;
    readonly sourceUpdatedAt?: Date;
  },
  hash: string | undefined,
): ApplyDecision {
  // M10B (plan §2.4, Q9): the shared reference lifecycle rule.
  return decideReferenceObservation(stored, observation, hash);
}

/** The primary company link, or undefined when there is none or it is ambiguous. */
export function primaryCompanyLink(links: readonly SourceCompanyLink[]): {
  link: SourceCompanyLink | undefined;
  ambiguous: boolean;
} {
  const primaries = links.filter((l) => l.primary);
  const distinct = new Set(primaries.map((l) => l.company.id));
  if (distinct.size > 1) return { link: undefined, ambiguous: true };
  if (distinct.size === 1) return { link: primaries[0], ambiguous: false };
  const companies = new Set(links.map((l) => l.company.id));
  return { link: companies.size === 1 ? links[0] : undefined, ambiguous: companies.size > 1 };
}
