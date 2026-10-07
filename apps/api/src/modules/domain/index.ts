/**
 * Canonical domain model — the vocabulary every other module speaks.
 *
 * Pure TypeScript + Zod: no framework, persistence or vendor dependencies
 * (enforced by dependency-cruiser). Entities are immutable data validated by
 * their schemas; behaviour is pure functions that return new values.
 */
export * from './attribution';
export * from './company';
export * from './connector-error';
export * from './connector-kinds';
export * from './crm-reader';
export * from './email';
export * from './external-ref';
export * from './external-snapshots';
export * from './lead';
export * from './lead-candidate';
export * from './person';
export * from './product';
export * from './qualification';
export * from './sales-outcome';
export * from './shared/codes';
export * from './shared/errors';
export * from './shared/ids';
export * from './shared/time';
export * from './signals';
export * from './source-authority';
export * from './source-connector';
export * from './source-mapping';
export * from './source-mapping-engine';
export * from './source-observation';
export * from './source-schema-drift';
export * from './source-transforms';
export * from './coverage';
export * from './eligibility';
export * from './holding-domain';
export * from './source-protection';
export * from './product-model';
export * from './shared/canonical-json';
export * from './subscription';
export * from './profiling';
