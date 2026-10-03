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
]);
export type AuthorityFact = z.infer<typeof AuthorityFactSchema>;

export const AUTHORITY_FACTS = AuthorityFactSchema.options;

/** `{fact → connection id | null}`: every fact is stated, `null` = unassigned. */
export const AuthorityDocumentSchema = z
  .strictObject({
    facts: z.strictObject(
      Object.fromEntries(AUTHORITY_FACTS.map((f) => [f, z.uuid().nullable()])) as Record<
        AuthorityFact,
        z.ZodNullable<z.ZodUUID>
      >,
    ),
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
  return doc.facts[fact];
}

export function isAuthoritative(
  doc: AuthorityDocument,
  fact: AuthorityFact,
  connectionId: string,
): boolean {
  return doc.facts[fact] === connectionId;
}

/** Facts a connection holds (sorted, for stable output). */
export function factsHeldBy(doc: AuthorityDocument, connectionId: string): AuthorityFact[] {
  return AUTHORITY_FACTS.filter((f) => doc.facts[f] === connectionId);
}
