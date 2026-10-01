import { z } from 'zod';
import { EmailAddressSchema } from './email';
import { ExternalRefListSchema, RecordStateSchema } from './external-ref';
import { CompanyIdSchema, PersonIdSchema, TenantIdSchema } from './shared/ids';
import { InstantSchema } from './shared/time';

/**
 * Buying roles relevant to qualification and routing (e.g. "known decision
 * maker"). Source systems map their own titles/personas onto these.
 */
export const PersonRoleSchema = z.enum([
  'decision_maker',
  'budget_holder',
  'influencer',
  'champion',
  'end_user',
  'administrator',
]);
export type PersonRole = z.infer<typeof PersonRoleSchema>;

/** A human being, independent of which system knows about them (HubSpot Contact, Gainsight Person, Sugar Contact). */
export const PersonSchema = z
  .object({
    id: PersonIdSchema,
    tenantId: TenantIdSchema,
    /** Optional and not identity (ADR 0014); normalised when present. */
    primaryEmail: EmailAddressSchema.optional(),
    additionalEmails: z.array(EmailAddressSchema).readonly().default([]),
    firstName: z.string().trim().min(1).max(200).optional(),
    lastName: z.string().trim().min(1).max(200).optional(),
    jobTitle: z.string().trim().min(1).max(300).optional(),
    companyId: CompanyIdSchema.optional(),
    roles: z.array(PersonRoleSchema).readonly().default([]),
    externalRefs: ExternalRefListSchema.default([]),
    recordState: RecordStateSchema.default('active'),
    /** The record this one was merged into (only when recordState is `merged`). */
    mergedIntoId: PersonIdSchema.optional(),
    createdAt: InstantSchema,
    updatedAt: InstantSchema,
  })
  .refine((p) => p.primaryEmail === undefined || !p.additionalEmails.includes(p.primaryEmail), {
    message: 'primary email must not be repeated in additionalEmails',
    path: ['additionalEmails'],
  })
  .refine((p) => new Set(p.roles).size === p.roles.length, {
    message: 'duplicate role',
    path: ['roles'],
  })
  .refine((p) => (p.recordState === 'merged') === (p.mergedIntoId !== undefined), {
    message: 'mergedIntoId is required exactly when the record is merged',
    path: ['mergedIntoId'],
  })
  .refine((p) => p.mergedIntoId !== p.id, {
    message: 'a record cannot be merged into itself',
    path: ['mergedIntoId'],
  })
  .refine((p) => p.createdAt <= p.updatedAt, {
    message: 'updatedAt must not be before createdAt',
    path: ['updatedAt'],
  })
  .readonly();

export type Person = z.infer<typeof PersonSchema>;
export type PersonInput = z.input<typeof PersonSchema>;

export function personEmails(person: Person): readonly string[] {
  return person.primaryEmail === undefined
    ? person.additionalEmails
    : [person.primaryEmail, ...person.additionalEmails];
}

export function hasRole(person: Person, role: PersonRole): boolean {
  return person.roles.includes(role);
}

/** Name, else email; undefined when the source gave neither (display is a UI decision). */
export function personDisplayName(person: Person): string | undefined {
  const name = [person.firstName, person.lastName].filter(Boolean).join(' ');
  return name || person.primaryEmail;
}
