import { z } from 'zod';

/**
 * A point in time. Accepts a Date or an ISO-8601 string with an explicit
 * offset (as produced by JSON serialisation across queues) and yields a Date.
 * Strings without an offset are rejected because their meaning is ambiguous.
 */
export const InstantSchema = z
  .union([z.date(), z.iso.datetime({ offset: true }).transform((value) => new Date(value))])
  .refine((date) => !Number.isNaN(date.getTime()), 'Invalid date');

export type Instant = Date;
