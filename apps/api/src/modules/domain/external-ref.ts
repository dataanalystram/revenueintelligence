import { z } from 'zod';

/** Systems of record the platform integrates with. */
export const ExternalSystemSchema = z.enum(['hubspot', 'sugar', 'gainsight_cs', 'gainsight_px']);
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
