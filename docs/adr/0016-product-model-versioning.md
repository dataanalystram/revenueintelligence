# ADR 0016: Product model — versioned per-tenant catalogue, relationships and conditions (Milestone 7)

- Status: accepted (M7 implementation, 2026-10-02; plan approved with
  changes the same day). "As built" notes at the end record where the
  implementation refines the plan.
- Date: 2026-10-02

## Context

M7 must know, per tenant:

- what products exist;
- how they relate to each other;
- which conditions govern a new purchase.

The answers must be explainable and reproducible later (plan:
[M07](../milestones/M07-product-catalogue-subscriptions-eligibility.md)).

What exists today:

- M2 left a mutable catalogue table, `tenant_products`, keyed by
  `(tenant_id, key)`.
- Tenant configuration (policies, qualification) is versioned as one mutable
  row with a counter. Past states of a mutable row cannot be read back, so a
  decision made under an earlier policy could never be reproduced.

ADR 0012 decided that eligibility rules are declarative, versioned per-tenant
data, evaluated by a pure deterministic evaluator, with no generic rules
engine.

## Decision

1. **One immutable product model per tenant per version.** A JSON document
   holds four parts, validated together:
   - the catalogue: products with `key`, `name`, `description`, `family`,
     `status` (`active` | `retired`), an optional availability window, and
     `externalRefs`;
   - the relationships;
   - the configured conditions;
   - the ownership settings (`ownedStates`).

   Published versions are stored with a SHA-256 content hash, `effectiveFrom`,
   the publisher and `publishedAt`. A trigger refuses any UPDATE or DELETE. A
   correction is a new version. There are no drafts in the database: a draft
   is a file checked with `validate`.

2. **The selected version** for an `asOf` is the highest version whose
   `effectiveFrom` ≤ `asOf`. `effectiveFrom` is monotonic across versions and
   never in the past at publish time.
3. **`tenant_products` is a read-only projection** of the latest published
   version. It is updated in the publishing transaction. Rows are never
   deleted (trigger); a product that leaves sale becomes `retired`.
   Subscriptions reference the projection by `(tenant_id, key)`.
4. **Relationships**: `requires` (`anyOf`), `excludes` (mutual), `replaces`
   (supersession; the upgrade path stays open), `includes` (a bundle counts as
   owning its contents). `requires` supports **`anyOf` only in M7**. `allOf`
   is not implemented until a real requirement shows a need for it. Today,
   several `requires` entries on one product already mean "all of these
   groups".
5. **Conditions**: one type in M7, `account_attribute` over a closed canonical
   attribute list (`customer_status`). Attributes are added only when a
   connected source supplies them.
6. **Rules are data and their semantics are code.** A small, fixed set of pure
   check functions interprets the document. There is no expression language,
   no `eval` and no external engine. A new check _type_ needs code, tests and
   an evaluator version bump.
7. **Validation before publish** rejects the following, each with a stable
   code and a JSON path:
   - duplicate keys or external references;
   - unknown references and self-references;
   - `requires` cycles, and cycles in `includes ∪ replaces` (iterative DFS,
     with one witness path reported);
   - unsatisfiable or contradictory relationships;
   - invalid windows and effective dates;
   - unknown attributes;
   - size limits;
   - the cross-version identity rules (8).
8. **Product identity continuity (cross-version invariant).** The product
   **key is the product identity**. Once a key has represented a product in a
   published version, it can never be reused for a different product.
   Enforcement compares the candidate with the latest published version:
   - **K1, no removal.** Every key in the previous version must still be
     present (`product_key_removed`). A product leaves sale only by becoming
     `retired`, so a key's whole history is visible in every version.
   - **K2, retired identity is frozen.** For a product that was `retired` in
     the previous version, `name` and `family` must not change
     (`retired_product_identity_change`). Bringing it back to `active` is
     allowed only with the same name and family (it is the same product
     returning to sale). It must be declared in the document's `lifecycle`
     section (`{key, action: "reactivate"}`), otherwise it fails with
     `undeclared_reactivation`.
   - **K3, renames are declared.** For an active product, a changed `name`
     must carry `renamedFrom` equal to the previous name, otherwise it fails
     with `undeclared_rename`. Description, family, availability and status
     changes need no declaration: they do not alter identity.
   - **K4, the projection never forgets.** `tenant_products` rows are never
     deleted, so K1 also holds against the database, and a key can never be
     inserted as "new" once it has existed.

   **What tells a rename from reuse.** The key's unbroken presence across
   versions, plus an **explicit, audited declaration** (`renamedFrom`, or
   `reactivate`) recorded in the immutable version with its publisher. The
   ADR's example is rejected: `analytics` is retired in v2, then appears in
   v5 named "School Payments". K1 forces it to remain listed in v3–v4, and in
   v5 K2 refuses the name change on a retired product. Renaming an active
   `analytics` from "Analytics" to "Analytics Pro" with
   `renamedFrom: "Analytics"` is allowed. Software cannot prove the intent
   behind a declared rename of an active product. The guarantee is that a key
   never silently changes meaning, and every declared change is visible in
   `product:model diff` and attributable to its publisher.

9. **No internal product UUID.** Keys are immutable (no key changes), never
   deleted and never reassigned. A UUID would be assigned by looking up the
   key, so it would carry exactly the same identity with no extra evidence. It
   would only matter if keys themselves had to be renamable, which this design
   forbids: a "new key" is a new product.
10. **Every result records** `modelVersion`, `modelHash` and
    `evaluatorVersion`. Old versions stay loadable, so past decisions can be
    re-run.

## Consequences

- The catalogue and the rules can never disagree: they are validated and
  versioned as one unit.
- Changes are auditable as whole versions (`product:model diff`). History is
  never rewritten.
- Operators must declare renames and reactivations. That small burden is what
  makes key reuse detectable.
- A retired key is permanent. Re-launching under a new identity needs a new
  key.
- Concurrent publishes are serialised by a per-tenant advisory lock, and the
  version is unique per tenant (primary key). Each publish validates against
  the version committed before it. A publisher that prepared its document
  against a specific version passes `basedOnVersion`; if another version was
  published meanwhile it gets a clear `ConcurrentPublishError` instead of
  silently superseding it. A failed publish leaves no version and no
  projection change, because both happen in one transaction.
- Evaluation during activation is consistent. A model is selected by
  `effectiveFrom` from immutable rows, so an evaluation sees either the old or
  the new version, never a mixture. The projection is updated in the same
  transaction as the version insert.

## Alternatives considered

- **Mutable catalogue plus a separate rules version.** Rejected: a rule
  version could refer to a catalogue state it was never validated against,
  and the past could not be reproduced.
- **An internal UUID with renamable keys.** Rejected: more moving parts, and
  no stronger evidence of identity.
- **A generic rules engine or expression language.** Rejected by ADR 0012:
  opaque, hard to explain, and it invites customer-specific logic.

## As built (M7)

- **Code.** The document schema, validator (`validateProductModel`) and the
  indexed model live in the pure domain (`src/modules/domain/product-model.ts`,
  protected by `domain-is-pure`) rather than inside the products module; the
  products module holds the services and persistence
  (`ProductCatalogueService`, `ProductModelStore`). Stored versions are
  re-validated (structural checks and content hash) every time they are
  indexed; a corrupt stored version fails with `CorruptProductModelError`
  instead of being evaluated. Indexed models are cached per
  (tenant, version, content hash).
- **First version and pre-M7 rows.** Before any version exists, the
  `tenant_products` rows created before M7 act as the "previous version" for
  K1–K3, so the first model cannot drop or silently redefine them.
- **Who writes `tenant_products`.** Only the publishing transaction.
  `TenantConfigService.saveProduct`/`deleteProduct` and the tenant template's
  `products` key were removed (the template did not gain `productModel`:
  Juniper's products are `tbc`, and a template field would make tenancy depend
  on products). `listProducts` remains as a read of the projection. ESLint
  allows the `tenantProduct` delegate only in the products persistence layer.
- **Limits.** 2,000 products, 10,000 rules, 50 `anyOf` members, 20 external
  references per product (`model_too_large`).
- **CLI.** `product:model validate | publish [--based-on N] --execute | show |
diff`; publish is a dry run without `--execute`.

## M8 note: publication requires the base version

M8 (ADR 0020 §11, technical debt #26) makes optimistic concurrency mandatory:
`ProductCatalogueService.publish` refuses a call without `basedOnVersion`
(`BaseVersionRequiredError`; `0` before the first version) and refuses a stale
base with `ConcurrentPublishError`. The CLI requires `--based-on` for
`product:model publish --execute`. The publication lock and versioning are
unchanged. Concurrent publishes from one base now yield exactly one new
version; the others conflict.
