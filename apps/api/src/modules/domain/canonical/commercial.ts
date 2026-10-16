/**
 * Commercial (M10F plan docs/milestones/M10F-commercial-plan.md, ADR 0032,
 * canonical 0.6, module `commercial`): Price/Offer, Contract (with its three
 * Contract → Contract links), Entitlement and the line commercial references.
 * Closed vocabularies — the database CHECKs equal these lists (schema guard) —
 * and the advisory-lock scopes the guard triggers take. Pure: no I/O.
 *
 * No price offer, contract, entitlement, currency list, status map or source
 * field is seeded (CLAUDE.md, plan §0): the vocabularies below are the small,
 * vendor-neutral canonical enums fixed by E3 §13 (plan §2, Q3). A source code
 * reaches them only through a mapping's closed `valueMap` transform.
 */

/** Minimum canonical version for every commercial entity, link, line reference and mapping block (plan §11). */
export const COMMERCIAL_MIN_VERSION = '0.6';
export const COMMERCIAL_MODULE_KEY = 'commercial' as const;

/** The entity kinds module `commercial` owns (entity index, change records, generic references). */
export const COMMERCIAL_ENTITY_KINDS = ['price_offer', 'contract', 'entitlement'] as const;
export type CommercialEntityKind = (typeof COMMERCIAL_ENTITY_KINDS)[number];

/** `tenant_price_offers.pricing_model` (CHECK; nullable; Q8). Codes only — no tiers (plan §1.1). */
export const PRICING_MODELS = ['flat', 'per_unit', 'tiered', 'volume', 'usage'] as const;
export type PricingModel = (typeof PRICING_MODELS)[number];
/** `tenant_price_offers.billing_period_unit` (CHECK; nullable, paired with `billing_period`; Q8). */
export const BILLING_PERIOD_UNITS = ['day', 'week', 'month', 'year'] as const;
export type BillingPeriodUnit = (typeof BILLING_PERIOD_UNITS)[number];
/** `tenant_price_offers.status` (CHECK; plan §3.1). A retired offer keeps its lines (plan §5.1). */
export const PRICE_OFFER_STATUSES = ['active', 'retired'] as const;
export type PriceOfferStatus = (typeof PRICE_OFFER_STATUSES)[number];
/** `tenant_contracts.status` (CHECK; E3 §13; an unmapped source status reads `unknown`). */
export const CONTRACT_STATUSES = ['draft', 'active', 'expired', 'terminated', 'unknown'] as const;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];
/** `tenant_entitlements.status` (CHECK; Q15; informational only). */
export const ENTITLEMENT_STATUSES = ['active', 'inactive', 'expired', 'unknown'] as const;
export type EntitlementStatus = (typeof ENTITLEMENT_STATUSES)[number];
/** `record_state` of the three tables (CHECK): no merge in M10F (Q14). */
export const COMMERCIAL_RECORD_STATES = ['active'] as const;

/**
 * The three Contract → Contract links (Q6): one nullable composite self-FK
 * column per kind, so "0..1 of each" (E3 §14) is structural. Acyclic over the
 * union of the three kinds (Q7) and same-account (Q12).
 */
export const CONTRACT_LINK_KINDS = ['renews', 'amends', 'parent'] as const;
export type ContractLinkKind = (typeof CONTRACT_LINK_KINDS)[number];
export const CONTRACT_LINK_COLUMNS: Readonly<Record<ContractLinkKind, string>> = {
  renews: 'renews_contract_id',
  amends: 'amends_contract_id',
  parent: 'parent_contract_id',
};

/** ISO 4217 shape (not a list): three upper-case letters (plan §3.1). */
export const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/**
 * Database fail-closed ceiling of the contract-graph and line-lineage walks
 * (M10C pattern; plan §3.2, §3.4). Not a guardrail.
 */
export const COMMERCIAL_WALK_CEILING = 64;

/**
 * Tenant advisory-lock scopes (value `tenant`) the guard triggers take, in the
 * fixed lock order of plan §4 / Q16: `contract-graph` before `line-lineage`.
 */
export const CONTRACT_GRAPH_LOCK_SCOPE = 'contract-graph';
export const LINE_LINEAGE_LOCK_SCOPE = 'line-lineage';
export const COMMERCIAL_LOCK_VALUE = 'tenant';
export const COMMERCIAL_LOCK_ORDER = [CONTRACT_GRAPH_LOCK_SCOPE, LINE_LINEAGE_LOCK_SCOPE] as const;

/** Named refusals raised by the M10F triggers (the message is the code). */
export const COMMERCIAL_TRIGGER_REFUSALS = [
  'price_offer_identity_immutable',
  'price_offer_product_referenced',
  'contract_link_cycle',
  'contract_link_ceiling',
  'contract_link_cross_account',
  'contract_graph_isolation_unsupported',
  'contract_context_company_mismatch',
  'line_contract_company_mismatch',
  'line_price_offer_product_mismatch',
  'line_lineage_cycle',
  'line_lineage_ceiling',
  'line_lineage_cross_account',
  'line_lineage_isolation_unsupported',
] as const;
export type CommercialTriggerRefusal = (typeof COMMERCIAL_TRIGGER_REFUSALS)[number];

/** Interim data-quality kinds recorded in `tenant_identity_conflicts` until M10L (plan §3.5). */
export const COMMERCIAL_CONFLICT_KINDS = [
  'contract_reference_unresolved',
  'price_offer_reference_unresolved',
  'contract_company_mismatch',
  'price_offer_product_mismatch',
  'contract_link_cycle_refused',
  'contract_link_cross_account',
  'contract_duplicate_source',
  'commercial_human_override_disagrees',
] as const;

/**
 * Value-history fields of M10F (M10 §10 "Subscription `contract_id`",
 * "Contract status / dates"; plan §9). `contract.renewal_date` and
 * `price_offer.list_amount_minor` are declared `value_free` in the
 * classification manifest: recorded without values (Q18).
 */
export const COMMERCIAL_HISTORY_FIELDS = {
  subscription: ['contract_id', 'price_offer_id'],
  contract: ['status', 'starts_at', 'ends_at', 'renewal_date'],
  price_offer: ['status', 'list_amount_minor'],
  entitlement: ['status', 'starts_at', 'ends_at'],
} as const;

/** Line `agreement_ref` (Core, E3 §4.1): all three columns or none (CHECK). */
export const AGREEMENT_REF_COLUMNS = [
  'agreement_ref_system',
  'agreement_ref_object_type',
  'agreement_ref_external_id',
] as const;

/**
 * Line mapping targets introduced by 0.6 (plan §6.2). Their writers arrive with
 * the M10F services (phase 2); the catalogue hashes them from 0.6.
 */
export const COMMERCIAL_LINE_MAPPING_TARGETS = [
  'subscription.agreement',
  'subscription.priceOfferRef',
  'subscription.supersedesRef',
] as const;

/** The closed commercial vocabularies hashed into the 0.6 catalogue (plan §2, §11). */
export const COMMERCIAL_VOCABULARIES = {
  pricingModels: PRICING_MODELS,
  billingPeriodUnits: BILLING_PERIOD_UNITS,
  priceOfferStatuses: PRICE_OFFER_STATUSES,
  contractStatuses: CONTRACT_STATUSES,
  contractLinkKinds: CONTRACT_LINK_KINDS,
  entitlementStatuses: ENTITLEMENT_STATUSES,
} as const;
