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
    // M10C: the M10 §10 initial field "Account parent_account_id" (full history).
    parent_company_id: { table: 'companies', column: 'parent_company_id' },
  },
  // M10C: personal fields, value-free unless a published data policy allows values (Q15).
  person_affiliation: {
    status: { table: 'tenant_person_affiliations', column: 'status' },
    starts_at: { table: 'tenant_person_affiliations', column: 'starts_at' },
    ends_at: { table: 'tenant_person_affiliations', column: 'ends_at' },
    role_codes: { table: 'tenant_person_affiliations', column: 'role_codes' },
  },
  subscription: {
    state: { table: 'tenant_subscriptions', column: 'state' },
    starts_at: { table: 'tenant_subscriptions', column: 'starts_at' },
    ends_at: { table: 'tenant_subscriptions', column: 'ends_at' },
    product_key: { table: 'tenant_subscriptions', column: 'product_key' },
    quantity: { table: 'tenant_subscriptions', column: 'quantity' },
    // M10E (Q23): the line's account context.
    context_id: { table: 'tenant_subscriptions', column: 'context_id' },
    // M10F (M10 §10 "Subscription `contract_id`"; plan §9): the line's contract and price offer.
    contract_id: { table: 'tenant_subscriptions', column: 'contract_id' },
    price_offer_id: { table: 'tenant_subscriptions', column: 'price_offer_id' },
  },
  // M10E (M10 §10 "AccountContext owner / status").
  account_context: {
    owner_ref: { table: 'tenant_account_contexts', column: 'owner_ref' },
    status: { table: 'tenant_account_contexts', column: 'status' },
  },
  // M10F (M10 §10 "Contract status / dates"; plan §9). renewal_date and list_amount_minor are
  // declared `value_free` in the classification manifest: recorded without values (Q18).
  contract: {
    status: { table: 'tenant_contracts', column: 'status' },
    starts_at: { table: 'tenant_contracts', column: 'starts_at' },
    ends_at: { table: 'tenant_contracts', column: 'ends_at' },
    renewal_date: { table: 'tenant_contracts', column: 'renewal_date' },
  },
  price_offer: {
    status: { table: 'tenant_price_offers', column: 'status' },
    list_amount_minor: { table: 'tenant_price_offers', column: 'list_amount_minor' },
  },
  entitlement: {
    status: { table: 'tenant_entitlements', column: 'status' },
    starts_at: { table: 'tenant_entitlements', column: 'starts_at' },
    ends_at: { table: 'tenant_entitlements', column: 'ends_at' },
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
 *
 * M10F (plan §9, Q18): a column that is not sensitive for history but whose
 * manifest declares `history: 'value_free'` (the financial `renewal_date` and
 * `list_amount_minor`) is recorded value-free too: who / when / change id,
 * never the value. Sensitive columns keep the rule above unchanged (a published
 * data policy may still allow their values), so no pre-M10F decision moves;
 * `isSensitiveForHistory` is not widened (tech debt #94).
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
    if (input.classification.history === 'value_free') {
      return { record: true, valuesRecorded: false, retentionClass: 'canonical_lifecycle' };
    }
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
