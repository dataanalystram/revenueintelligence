import {
  companyFields,
  personFields,
  type ContextKind,
  type CrmReader,
  type ExternalAssociation,
  type ExternalCompanySnapshot,
  type ExternalPersonSnapshot,
  type SourceCompanyLink,
  type SourceObservation,
} from '../../domain';
import { TransientJobError } from '../errors';

/**
 * Builds vendor-neutral observations from a tenant's CrmReader (read-only).
 * The read time is taken before the request, so a read that started before a
 * deletion was recorded can never revive the record (ADR 0014).
 */

export function companyObservation(
  snap: ExternalCompanySnapshot,
  observedAt: Date,
): SourceObservation {
  if (snap.archived) return { kind: 'company', presence: 'absent', ref: snap.ref, observedAt };
  return {
    kind: 'company',
    presence: 'present',
    ref: snap.ref,
    observedAt,
    ...(snap.createdAt ? { sourceCreatedAt: snap.createdAt } : {}),
    ...(snap.updatedAt ? { sourceUpdatedAt: snap.updatedAt } : {}),
    fields: companyFields({ name: snap.name, domain: snap.domain }),
  };
}

export function personObservation(
  snap: ExternalPersonSnapshot,
  observedAt: Date,
  links: readonly SourceCompanyLink[] | undefined,
): SourceObservation {
  if (snap.archived) return { kind: 'person', presence: 'absent', ref: snap.ref, observedAt };
  return {
    kind: 'person',
    presence: 'present',
    ref: snap.ref,
    observedAt,
    ...(snap.createdAt ? { sourceCreatedAt: snap.createdAt } : {}),
    ...(snap.updatedAt ? { sourceUpdatedAt: snap.updatedAt } : {}),
    fields: personFields({
      email: snap.email,
      firstName: snap.firstName,
      lastName: snap.lastName,
      jobTitle: snap.jobTitle,
    }),
    ...(links ? { companyLinks: links } : {}),
  };
}

/** Person → company links for the given person ids (all pages; failures are retried). */
export async function companyLinks(
  reader: CrmReader,
  personIds: readonly string[],
): Promise<Map<string, SourceCompanyLink[]>> {
  const out = new Map<string, SourceCompanyLink[]>(personIds.map((id) => [id, []]));
  if (personIds.length === 0) return out;
  const result = await reader.readAssociations('person', personIds, 'company');
  if (result.failures.length > 0) {
    throw new TransientJobError(
      'source_association_failure',
      `association read reported ${result.failures.length} failure(s)`,
    );
  }
  for (const a of result.associations) out.get(a.from.id)?.push(toLink(a));
  return out;
}

function toLink(a: ExternalAssociation): SourceCompanyLink {
  const primary = a.types.find((t) => t.primary);
  const type = primary ?? a.types[0]!;
  return { company: a.to, typeId: type.typeId, category: type.category, primary: !!primary };
}

/** Reads one record back (and a person's company links). */
export async function observeSubject(
  reader: CrmReader,
  kind: ContextKind,
  externalId: string,
): Promise<SourceObservation> {
  const observedAt = new Date();
  if (kind === 'company') {
    const snap = await reader.getRecord('company', externalId);
    return snap
      ? companyObservation(snap, observedAt)
      : { kind, presence: 'absent', ref: reader.refFor(kind, externalId), observedAt };
  }
  const snap = await reader.getRecord('person', externalId);
  if (!snap) return { kind, presence: 'absent', ref: reader.refFor(kind, externalId), observedAt };
  const links = snap.archived
    ? undefined
    : (await companyLinks(reader, [externalId])).get(externalId);
  return personObservation(snap, observedAt, links);
}
