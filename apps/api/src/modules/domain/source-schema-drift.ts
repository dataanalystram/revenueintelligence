import type { MappingDocument, ObjectMapping } from './source-mapping';
import { mappedFields } from './source-mapping';
import { findSourceField, findSourceObject, type SourceSchema } from './source-connector';

/**
 * Schema drift on the MAPPED surface only (ADR 0019 §6): the fields and
 * objects a published mapping reads, compared between the snapshot it was
 * validated against and the schema the source describes now. Blocking drift
 * stops a run before any canonical write; nothing is reinterpreted.
 */
export type DriftCode =
  | 'mapped_object_removed'
  | 'mapped_field_removed'
  | 'mapped_field_type_changed'
  | 'relationship_target_changed'
  | 'enum_option_removed'
  | 'enum_option_added';

export interface DriftIssue {
  readonly code: DriftCode;
  readonly object: string;
  readonly field?: string;
  /** Blocking drift refuses the run (`schema_drift`); the rest is reported. */
  readonly blocking: boolean;
}

/** The objects and fields a mapping reads, including product references and fallbacks. */
export function mappedSurface(doc: MappingDocument): Map<string, Set<string>> {
  const surface = new Map<string, Set<string>>();
  const add = (object: string, fields: readonly string[]) => {
    const set = surface.get(object) ?? new Set<string>();
    fields.forEach((f) => set.add(f));
    surface.set(object, set);
  };
  for (const obj of doc.objects) {
    add(obj.source, mappedFields(obj));
    for (const rel of obj.relationships) {
      if (rel.fallbackVia) add(rel.fallbackVia.object, [rel.fallbackVia.targetField]);
    }
  }
  if (doc.productReferences)
    add(doc.productReferences.object, [doc.productReferences.identity.field]);
  return surface;
}

/** Enum values a mapping depends on (holding filter values, value-map keys). */
function usedEnumValues(obj: ObjectMapping, field: string): Set<string> {
  const used = new Set<string>();
  if (obj.holdingFilter?.field === field) obj.holdingFilter.values.forEach((v) => used.add(v));
  for (const entry of obj.fields) {
    if (entry.kind === 'core' && 'source' in entry && entry.source === field) {
      Object.keys(entry.transforms?.valueMap?.map ?? {}).forEach((v) => used.add(v));
    }
  }
  return used;
}

export function detectSchemaDrift(
  doc: MappingDocument,
  validatedAgainst: SourceSchema,
  current: SourceSchema,
): DriftIssue[] {
  const issues: DriftIssue[] = [];
  for (const [object, fields] of [...mappedSurface(doc)].sort(([a], [b]) => a.localeCompare(b))) {
    if (!findSourceObject(current, object)) {
      issues.push({ code: 'mapped_object_removed', object, blocking: true });
      continue;
    }
    for (const field of [...fields].sort()) {
      const before = findSourceField(validatedAgainst, object, field);
      const now = findSourceField(current, object, field);
      if (!now) {
        issues.push({ code: 'mapped_field_removed', object, field, blocking: true });
        continue;
      }
      if (!before) continue;
      if (before.type !== now.type) {
        issues.push({ code: 'mapped_field_type_changed', object, field, blocking: true });
      }
      if ((before.relatesTo ?? null) !== (now.relatesTo ?? null)) {
        issues.push({ code: 'relationship_target_changed', object, field, blocking: true });
      }
      const was = new Set((before.enumOptions ?? []).map((o) => o.value));
      const is = new Set((now.enumOptions ?? []).map((o) => o.value));
      const obj = doc.objects.find((o) => o.source === object);
      const used = obj ? usedEnumValues(obj, field) : new Set<string>();
      for (const v of was) {
        if (!is.has(v)) {
          // A removed option the mapping relies on changes its meaning: blocking.
          issues.push({ code: 'enum_option_removed', object, field, blocking: used.has(v) });
        }
      }
      for (const v of is) {
        if (!was.has(v)) issues.push({ code: 'enum_option_added', object, field, blocking: false });
      }
    }
  }
  return issues;
}
