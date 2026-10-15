import { z } from 'zod';
import { RETENTION_CLASSES, RETENTION_DEFAULTS, type RetentionClass } from '../security/retention';
import { isExtensionHistoryField } from './extension';
import { valueHistoryColumn } from './value-history';

/**
 * Data policy document v1 (registry kind `data_policy`; M10 plan F5, §16.3;
 * M10A2 plan §6, Q10). Only classes whose product default is a number of days
 * can be configured; classes whose default is `disabled` cannot appear, and
 * `raw_retention` is the literal `false` (the schema cannot express `true`).
 * The defaults are engineering product defaults, not SOC 2, GDPR, HIPAA or
 * legal-retention claims.
 */
export const DAYS_RETENTION_CLASSES: readonly RetentionClass[] = RETENTION_CLASSES.filter(
  (c) => RETENTION_DEFAULTS[c].kind === 'days',
);

export const DATA_POLICY_MIN_DAYS = 1;
export const DATA_POLICY_MAX_DAYS = 3650;
export const SECURITY_AUDIT_MIN_DAYS = 90;

const Days = z.number().int().min(DATA_POLICY_MIN_DAYS).max(DATA_POLICY_MAX_DAYS);
const ClassDays = z.strictObject({ days: Days });

const RetentionOverrides = z
  .strictObject(Object.fromEntries(DAYS_RETENTION_CLASSES.map((c) => [c, ClassDays.optional()])))
  .superRefine((r, ctx) => {
    const audit = (r as Record<string, { days: number } | undefined>).security_audit;
    if (audit && audit.days < SECURITY_AUDIT_MIN_DAYS) {
      ctx.addIssue({
        code: 'custom',
        path: ['security_audit', 'days'],
        message: `security_audit is kept at least ${SECURITY_AUDIT_MIN_DAYS} days`,
      });
    }
  });

const AllowEntry = z
  .strictObject({
    entity_kind: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
    // M10D (Q23): `ext:<key>` names an extension field (checked against the
    // current extension registry at publish).
    field: z.string().regex(/^([a-z][a-z0-9_]{0,63}|ext:[a-z][a-z0-9_]{0,62})$/),
    days: Days,
  })
  .superRefine((e, ctx) => {
    if (
      !valueHistoryColumn(e.entity_kind, e.field) &&
      !isExtensionHistoryField(e.entity_kind, e.field)
    ) {
      ctx.addIssue({
        code: 'custom',
        message: `${e.entity_kind}.${e.field} is not a value-history field`,
      });
    }
  });

export const DataPolicyDocumentSchema = z
  .strictObject({
    schema: z.literal(1),
    retention: RetentionOverrides.default({}),
    raw_retention: z.literal(false),
    value_history: z.strictObject({ allow: z.array(AllowEntry).max(100) }).default({ allow: [] }),
  })
  .superRefine((d, ctx) => {
    const seen = new Set<string>();
    for (const e of d.value_history.allow) {
      const k = `${e.entity_kind}.${e.field}`;
      if (seen.has(k)) ctx.addIssue({ code: 'custom', message: `duplicate allow entry ${k}` });
      seen.add(k);
    }
  });
export type DataPolicyDocument = z.infer<typeof DataPolicyDocumentSchema>;

export const DATA_POLICY_SCHEMA_VERSION = 1;
/** A data policy projects one registry entry with this key (a singleton document). */
export const DATA_POLICY_ENTRY_KEY = 'data_policy';

export type ResolvedRetention =
  | { readonly kind: 'days'; readonly days: number; readonly source: 'policy' | 'default' }
  | { readonly kind: 'disabled' | 'lifecycle'; readonly source: 'default' };

/** `published policy ?? product defaults`, per class. */
export function resolveRetention(
  policy: DataPolicyDocument | undefined,
): Readonly<Record<RetentionClass, ResolvedRetention>> {
  const out = {} as Record<RetentionClass, ResolvedRetention>;
  const overrides = (policy?.retention ?? {}) as Record<string, { days: number } | undefined>;
  for (const c of RETENTION_CLASSES) {
    const d = RETENTION_DEFAULTS[c];
    const override = overrides[c];
    if (d.kind === 'days') {
      out[c] = override
        ? { kind: 'days', days: override.days, source: 'policy' }
        : { kind: 'days', days: d.days, source: 'default' };
    } else {
      out[c] = { kind: d.kind, source: 'default' };
    }
  }
  return out;
}

/** Whether the policy allows keeping values of a sensitive value-history field. */
export function policyAllowsValues(
  policy: DataPolicyDocument | undefined,
  entityKind: string,
  field: string,
): boolean {
  return !!policy?.value_history.allow.some(
    (e) => e.entity_kind === entityKind && e.field === field,
  );
}
