import { z } from 'zod';

export const PolicyKindSchema = z.enum(['sla', 'routing', 'requalification']);
export type PolicyKind = z.infer<typeof PolicyKindSchema>;

const minutes = z
  .number()
  .int()
  .min(1)
  .max(60 * 24 * 90);

/**
 * Response-time targets by temperature. The policy engine (M14) applies them;
 * the values are tenant data, never code.
 */
export const SlaPolicySchema = z.strictObject({
  responseMinutes: z.strictObject({ hot: minutes, warm: minutes, cold: minutes }),
});

/** Placeholder until M14 defines routing; stored and versioned now. */
export const RoutingPolicySchema = z.strictObject({
  placeholder: z.literal(true).default(true),
  notes: z.string().max(2000).optional(),
});

/** Placeholder until M11/M14 define requalification windows. */
export const RequalificationPolicySchema = z.strictObject({
  placeholder: z.literal(true).default(true),
  notes: z.string().max(2000).optional(),
});

export const PolicySchemas = {
  sla: SlaPolicySchema,
  routing: RoutingPolicySchema,
  requalification: RequalificationPolicySchema,
} as const satisfies Record<PolicyKind, z.ZodType>;

export type PolicyDocument<K extends PolicyKind = PolicyKind> = z.infer<(typeof PolicySchemas)[K]>;

export interface Policy<K extends PolicyKind = PolicyKind> {
  readonly kind: K;
  readonly document: PolicyDocument<K>;
  readonly version: number;
}

export function parsePolicyDocument<K extends PolicyKind>(
  kind: K,
  document: unknown,
): PolicyDocument<K> {
  return PolicySchemas[kind].parse(document) as PolicyDocument<K>;
}
