import { z } from 'zod';

/** Email addresses are compared case-insensitively, so they are normalised to lowercase. */
export const EmailAddressSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email().max(254))
  .brand<'EmailAddress'>();

export type EmailAddress = z.infer<typeof EmailAddressSchema>;

export function emailDomain(email: EmailAddress): string {
  return email.slice(email.lastIndexOf('@') + 1);
}
