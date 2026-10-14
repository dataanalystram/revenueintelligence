import { createHash } from 'node:crypto';
import { stableJson } from './source-connector';
import { z } from 'zod';

/**
 * Source authority (ADR 0020 §8–10): per business fact, which tenant source
 * connection may write it. The set of facts is closed. There is no field-level
 * precedence, priority chain or voting: one connection or nobody.
 */
export const AuthorityFactSchema = z.enum([
  'account_profile',
  'person_profile',
  'subscription_lines',
  'subscription_state',
  'subscription_terms',
  // M10C (ADR 0029): who may write the account hierarchy. Optional in documents.
  'account_hierarchy',
]);
export type AuthorityFact = z.infer<typeof AuthorityFactSchema>;

export const AUTHORITY_FACTS = AuthorityFactSchema.options;

/**
 * The ADR 0020 facts every authority document states. Facts added later
 * (M10C `account_hierarchy`) are optional: a document without them reads as
 * unassigned, and the content hash covers them only when assigned.
 */
export const REQUIRED_AUTHORITY_FACTS = [
  'account_profile',
  'person_profile',
  'subscription_lines',
  'subscription_state',
  'subscription_terms',
] as const satisfies readonly AuthorityFact[];
const OPTIONAL_AUTHORITY_FACTS = AUTHORITY_FACTS.filter(
  (f) => !(REQUIRED_AUTHORITY_FACTS as readonly string[]).includes(f),
);

/** `{fact → connection id | null}`: every fact is stated, `null` = unassigned. */
export const AuthorityDocumentSchema = z
  .strictObject({
    facts: z.strictObject({
      ...(Object.fromEntries(REQUIRED_AUTHORITY_FACTS.map((f) => [f, z.uuid().nullable()])) as Record<
        (typeof REQUIRED_AUTHORITY_FACTS)[number],
        z.ZodNullable<z.ZodUUID>
      >),
      account_hierarchy: z.uuid().nullable().optional(),
    }),
  })
  .readonly();
export type AuthorityDocument = z.infer<typeof AuthorityDocumentSchema>;

export const UNASSIGNED_AUTHORITY: AuthorityDocument = {
  facts: {
    account_profile: null,
    person_profile: null,
    subscription_lines: null,
    subscription_state: null,
    subscription_terms: null,
  },
};

export function authorityOf(doc: AuthorityDocument, fact: AuthorityFact): string | null {
  return doc.facts[fact] ?? null;
}

export function isAuthoritative(
  doc: AuthorityDocument,
  fact: AuthorityFact,
  connectionId: string,
): boolean {
  return (doc.facts[fact] ?? null) === connectionId;
}

/** Facts a connection holds (sorted, for stable output). */
export function factsHeldBy(doc: AuthorityDocument, connectionId: string): AuthorityFact[] {
  return AUTHORITY_FACTS.filter((f) => doc.facts[f] === connectionId);
}

/**
 * Content hash of an authority version: the five ADR 0020 connection ids (or
 * `-`) joined by `|` in fact order (also computed by the M8 migration's seed).
 * M10C: an optional fact is appended as `|fact=<id>` only when assigned, so the
 * hash of every existing version is unchanged.
 */
export function authorityContentHash(doc: AuthorityDocument): string {
  const required = REQUIRED_AUTHORITY_FACTS.map((f) => doc.facts[f] ?? '-');
  const optional = OPTIONAL_AUTHORITY_FACTS.flatMap((f) => {
    const id = doc.facts[f];
    return id ? [`${f}=${id}`] : [];
  });
  return createHash('sha256')
    .update([...required, ...optional].join('|'))
    .digest('hex');
}

/**
 * An operator acceptance of an adapter-declared stable full-read proof
 * (ADR 0023, M9A §11.4). It can only ever accept `stable_snapshot`: no
 * acceptance yields `externally_grounded`.
 */
export const ProofAcceptanceSchema = z.strictObject({
  connectionId: z.uuid(),
  tier: z.literal('stable_snapshot'),
  reason: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .refine((r) => !/(secret|password|token|apikey|bearer)/i.test(r), 'no secrets in reasons'),
  actor: z.string().regex(/^[A-Za-z0-9_.:@-]{1,128}$/),
  at: z.iso.datetime().optional(),
});
export type ProofAcceptance = z.infer<typeof ProofAcceptanceSchema>;

/**
 * Content hash with proof acceptances: identical to the M8 hash while there
 * are none (parity with the M8 SQL seed); otherwise the M8 hash, `|`, and the
 * stable JSON of the acceptances sorted by connection (timestamps excluded).
 */
export function authorityContentHashWith(
  doc: AuthorityDocument,
  acceptances: readonly ProofAcceptance[],
): string {
  const base = authorityContentHash(doc);
  if (acceptances.length === 0) return base;
  const content = [...acceptances]
    .map(({ connectionId, tier, reason, actor }) => ({ connectionId, tier, reason, actor }))
    .sort((a, b) =>
      a.connectionId < b.connectionId ? -1 : a.connectionId > b.connectionId ? 1 : 0,
    );
  return createHash('sha256')
    .update(`${base}|${stableJson(content)}`)
    .digest('hex');
}
