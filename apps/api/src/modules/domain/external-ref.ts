import { z } from 'zod';
import { ReferenceKindSchema } from './connector-kinds';

/**
 * Systems of record whose records are canonical external references: the
 * connector-kind catalogue minus `import` (ADR 0019). Values are unchanged.
 */
export const ExternalSystemSchema = ReferenceKindSchema;
export type ExternalSystem = z.infer<typeof ExternalSystemSchema>;

/**
 * A pointer to a record in an external system, e.g.
 * `{ system: 'hubspot', objectType: 'leads', id: '123' }`.
 * The object type uses the external system's own name for the object.
 */
export const ExternalRefSchema = z
  .object({
    system: ExternalSystemSchema,
    objectType: z.string().trim().min(1).max(100),
    id: z.string().trim().min(1).max(255),
  })
  .readonly();

export type ExternalRef = z.infer<typeof ExternalRefSchema>;

/**
 * Lifecycle of a reference in its source system (ADR 0014): `deleted` keeps
 * the link (history) after the source record is deleted; `merged` points to
 * the surviving source record. M9B: `retired` — a successful, proven and
 * operator-accepted full read no longer returned the record (absence, not a
 * deletion signal). Retirement keeps the link, never changes the canonical
 * record and is undone by a later observation of the record.
 */
export const ExternalRefStateSchema = z.enum(['active', 'deleted', 'merged', 'retired']);
export type ExternalRefState = z.infer<typeof ExternalRefStateSchema>;

/**
 * State of a canonical record (ADR 0014): `inactive` when every source
 * reference is deleted; `merged` when merged forward into another record.
 * Canonical records are never hard-deleted by ingestion.
 */
export const RecordStateSchema = z.enum(['active', 'inactive', 'merged']);
export type RecordState = z.infer<typeof RecordStateSchema>;

/** A stable string key for an external reference: `system:objectType:id`. */
export function externalRefKey(ref: ExternalRef): string {
  return `${ref.system}:${ref.objectType}:${ref.id}`;
}

export function sameExternalRef(a: ExternalRef, b: ExternalRef): boolean {
  return externalRefKey(a) === externalRefKey(b);
}

/** A list of external references with no exact duplicates. */
export const ExternalRefListSchema = z
  .array(ExternalRefSchema)
  .refine(
    (refs) => new Set(refs.map(externalRefKey)).size === refs.length,
    'duplicate external reference',
  )
  .readonly();

/** Adds a reference if not already present (idempotent). */
export function withExternalRef(
  refs: readonly ExternalRef[],
  ref: ExternalRef,
): readonly ExternalRef[] {
  return refs.some((r) => sameExternalRef(r, ref)) ? refs : [...refs, ref];
}

export function findExternalRef(
  refs: readonly ExternalRef[],
  system: ExternalSystem,
  objectType: string,
): ExternalRef | undefined {
  return refs.find((r) => r.system === system && r.objectType === objectType);
}
