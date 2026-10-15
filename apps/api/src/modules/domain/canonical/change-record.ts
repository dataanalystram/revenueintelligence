/**
 * Change-record vocabulary (M10A2 plan §9, E5 §3). The database CHECKs equal
 * these lists (schema guard). Entity kinds are widened by each sub-milestone
 * with its entity (M10B: `product`, key-identified).
 */
export const CHANGE_ENTITY_KINDS = [
  'company',
  'person',
  'subscription',
  'product',
  // M10C (0.3)
  'person_affiliation',
  // M10D (0.4): custom records and custom relationship edges (Q24)
  'custom_record',
  'custom_relationship',
  // M10E (0.5): account contexts and their person memberships (Q24).
  'account_context',
  'account_context_person',
] as const;
/** The change entity kinds published with canonical 0.2 (frozen for its catalogue hash). */
export const CHANGE_ENTITY_KINDS_0_2 = ['company', 'person', 'subscription', 'product'] as const;
/** The change entity kinds published with canonical 0.3 (frozen for its catalogue hash). */
export const CHANGE_ENTITY_KINDS_0_3 = [
  'company',
  'person',
  'subscription',
  'product',
  'person_affiliation',
] as const;
/** The change entity kinds published with canonical 0.4 (frozen for its catalogue hash). */
export const CHANGE_ENTITY_KINDS_0_4 = [
  'company',
  'person',
  'subscription',
  'product',
  'person_affiliation',
  'custom_record',
  'custom_relationship',
] as const;
export type ChangeEntityKind = (typeof CHANGE_ENTITY_KINDS)[number];

/** M10B: change records of these kinds name the entity by `entity_key` (D3), every other kind by `entity_id`. */
export const KEY_IDENTIFIED_CHANGE_KINDS: readonly ChangeEntityKind[] = ['product'];

export const CHANGE_TYPES = [
  'created',
  'updated',
  'state_changed',
  'merged',
  'ref_added',
  'relationship_changed',
  'retired',
  'reactivated',
  'promoted',
  'migrated',
  'superseded',
  'retracted',
] as const;
export type ChangeType = (typeof CHANGE_TYPES)[number];

export const CHANGE_CAUSES = [
  'webhook',
  'backfill',
  'reconciliation',
  'replay',
  'resync',
  'import',
  'migration',
  'derivation',
  'human',
  'ai',
] as const;
export type ChangeCause = (typeof CHANGE_CAUSES)[number];

export const CHANGE_ORIGINS = [
  'source_provided',
  'deterministic',
  'ai_derived',
  'human',
  'migration',
] as const;
export type ChangeOrigin = (typeof CHANGE_ORIGINS)[number];

/** Origins whose change record must carry a derivation `{key, version, inputs_hash}`. */
export const DERIVED_ORIGINS: readonly ChangeOrigin[] = ['deterministic', 'ai_derived'];

/** Transform ids (ADR 0020 closed set: the keys of a field's `transforms`). */
export const TRANSFORM_IDS = ['nullValues', 'normalise', 'parse', 'valueMap'] as const;
export type TransformId = (typeof TRANSFORM_IDS)[number];

/** `field:transform_id`, e.g. `name:normalise`. */
export const TRANSFORM_TRACE_PATTERN =
  /^[A-Za-z][A-Za-z0-9_]{0,63}:(nullValues|normalise|parse|valueMap)$/;

export const SCHEMA_SNAPSHOT_HASH_PATTERN = /^[0-9a-f]{64}$/;

/** The governance columns every change record written since M10A2 carries. */
export interface ChangeGovernance {
  readonly origin: ChangeOrigin;
  readonly canonicalVersion: string;
  readonly schemaSnapshotHash: string | null;
  readonly transforms: readonly string[];
}

/**
 * The transform trace of a mapped object: `target_field:transform_id` for each
 * transform the published mapping declares on a mapped field (names only).
 */
export function transformTrace(
  fields: readonly { readonly target: string; readonly transforms?: object | undefined }[],
): string[] {
  const out = new Set<string>();
  for (const f of fields) {
    if (!f.transforms) continue;
    const field = f.target.includes('.') ? f.target.split('.').at(-1)! : f.target;
    for (const id of TRANSFORM_IDS) {
      if ((f.transforms as Record<string, unknown>)[id] !== undefined) {
        const entry = `${field}:${id}`;
        if (TRANSFORM_TRACE_PATTERN.test(entry)) out.add(entry);
      }
    }
  }
  return [...out].sort();
}
