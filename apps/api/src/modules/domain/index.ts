/**
 * Canonical domain model — the vocabulary every other module speaks.
 *
 * Pure TypeScript + Zod: no framework, persistence or vendor dependencies
 * (enforced by dependency-cruiser). Entities are immutable data validated by
 * their schemas; behaviour is pure functions that return new values.
 */
export * from './attribution';
export * from './company';
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
