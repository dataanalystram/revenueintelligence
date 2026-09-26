import { z } from 'zod';

/**
 * A tenant-configurable code (e.g. a product key, a disqualification reason or
 * a reason code emitted by a qualification provider). Lowercase slug form keeps
 * codes stable for reporting regardless of how the source system labels them.
 */
export const CodeSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/, 'must be a lowercase code (a-z, 0-9, _ . -)');

export type Code = z.infer<typeof CodeSchema>;

/** Trimmed, non-empty human-readable text with a sane upper bound. */
export const LabelSchema = z.string().trim().min(1).max(500);
