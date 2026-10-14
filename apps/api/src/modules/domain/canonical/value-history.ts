import type { ColumnClassification } from '../security/classification';
import { effectiveSensitivity } from '../security/classification';

/**
 * Value history (M10 plan §10, control 12; M10A2 plan §8). The closed field
 * catalogue per entity kind (Q14), each with the column it mirrors (for its
 * classification). The database CHECK equals this catalogue.
 */
export const VALUE_HISTORY_FIELDS = {
  company: {
    name: { table: 'companies', column: 'name' },
  },
  subscription: {
    state: { table: 'tenant_subscriptions', column: 'state' },
    starts_at: { table: 'tenant_subscriptions', column: 'starts_at' },
    ends_at: { table: 'tenant_subscriptions', column: 'ends_at' },
    product_key: { table: 'tenant_subscriptions', column: 'product_key' },
    quantity: { table: 'tenant_subscriptions', column: 'quantity' },
  },
} as const satisfies Readonly<
  Record<string, Readonly<Record<string, { readonly table: string; readonly column: string }>>>
>;
export type ValueHistoryEntityKind = keyof typeof VALUE_HISTORY_FIELDS;

export function valueHistoryPairs(): { entityKind: string; field: string }[] {
  return Object.entries(VALUE_HISTORY_FIELDS).flatMap(([entityKind, fields]) =>
    Object.keys(fields).map((field) => ({ entityKind, field })),
  );
}

export function valueHistoryColumn(
  entityKind: string,
  field: string,
): { readonly table: string; readonly column: string } | undefined {
  const fields = (
    VALUE_HISTORY_FIELDS as Record<string, Record<string, { table: string; column: string }>>
  )[entityKind];
  return fields?.[field];
}

export const VALUE_HISTORY_MAX_BYTES = 4096;

/**
 * A column is sensitive for history purposes (plan §8 step 2) when its
 * effective sensitivity is `restricted` (a `tbc` entry counts) or it carries a
 * personal, communication or security category.
 */
export function isSensitiveForHistory(c: ColumnClassification): boolean {
  return (
    effectiveSensitivity(c) === 'restricted' ||
    c.categories.some((cat) => cat === 'personal' || cat === 'communication' || cat === 'security')
  );
}

export type ValueHistoryDecision =
  | { readonly record: false }
  | {
      readonly record: true;
      readonly valuesRecorded: false;
      readonly retentionClass: 'canonical_lifecycle';
    }
  | {
      readonly record: true;
      readonly valuesRecorded: true;
      readonly retentionClass: 'canonical_lifecycle' | 'sensitive_value_history';
      readonly policyVersion: number | null;
    };

/**
 * Per field: not in the catalogue → nothing; sensitive and not allowed by the
 * published data policy → a value-free row; otherwise a full row (policy-allowed
 * sensitive fields carry `sensitive_value_history` and the policy version).
 */
export function decideValueHistory(input: {
  readonly entityKind: string;
  readonly field: string;
  readonly classification: ColumnClassification | undefined;
  readonly policyAllows: boolean;
  readonly policyVersion: number | null;
}): ValueHistoryDecision {
  if (!valueHistoryColumn(input.entityKind, input.field) || !input.classification) {
    return { record: false };
  }
  if (!isSensitiveForHistory(input.classification)) {
    return {
      record: true,
      valuesRecorded: true,
      retentionClass: 'canonical_lifecycle',
      policyVersion: null,
    };
  }
  if (input.policyAllows && input.policyVersion !== null) {
    return {
      record: true,
      valuesRecorded: true,
      retentionClass: 'sensitive_value_history',
      policyVersion: input.policyVersion,
    };
  }
  return { record: true, valuesRecorded: false, retentionClass: 'canonical_lifecycle' };
}
