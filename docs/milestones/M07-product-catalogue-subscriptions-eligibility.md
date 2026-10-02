# Milestone 7 — Product catalogue, subscriptions and eligibility

- Status: **implementation plan; architecture approved, corrections applied**.
  Independent planning review of `0d60808`: PASS WITH CHANGES REQUIRED.
  - Correction 1 (account merge and subscriptions) is resolved in
    [account merge](#account-merge-and-subscriptions) and ADR 0017.
  - Correction 2 (product-key reuse across versions) is resolved in §2, §6, §8
    and ADR 0016.
  - No M7 code, dependency, schema, migration or connector change exists.
- Approved decisions (review of 2026-10-02): see
  [approved decisions](#approved-decisions).
- ADRs (proposed):
  - [0016 product model](../adr/0016-product-model-versioning.md);
  - [0017 subscriptions and ownership](../adr/0017-subscriptions-and-ownership.md);
  - [0018 eligibility and whitespace](../adr/0018-eligibility-and-whitespace.md).
- Base: `main` at `fb4c6eb` (M0–M6 complete; M6 closed in PR #9).
- Inputs: [charter](../product/revenue-opportunity-intelligence.md) §5–7, §13–15,
  §18–19; [roadmap](../product/roadmap.md) (M7 and the pre-M8 Subscription
  Source Discovery gate); [ADR 0012](../adr/0012-revenue-opportunity-intelligence-direction.md)
  (declarative, versioned per-tenant rules; pure evaluator; no generic rules
  engine); [ADR 0008](../adr/0008-tenant-isolation.md);
  [ADR 0014](../adr/0014-canonical-identity-references-provenance.md).
- Juniper's real products, relationships, eligibility rules and subscription
  source are **unknown (`tbc`)**. Every example in this plan is generic
  (`core`, `analytics`, `analytics-plus`, `reporting`, `suite`) and none of it
  is shipped as Juniper configuration.

**Purpose.** M7 builds the canonical, vendor-neutral core that answers, per
account and point in time:

- what products exist;
- what the account owns, in which state;
- which products depend on, exclude, replace or include others;
- whether the account may newly acquire a product, and **why**.

M7 ends at deterministic **eligibility and whitespace**. It creates no
opportunities, signals, leads or recommendations.

```
FACTS (what is true)              RULES (tenant policy)               DECISION (derived)
account (M6)                      product model, version N:           eligibility result:
subscriptions (source/import)  +   catalogue, relationships,      →   status + every check,
ownership coverage                 eligibility conditions             the facts and rules it
                                                                      used, model/evaluator
                                                                      versions, asOf
```

Facts, rules and decisions are stored and versioned separately. A decision
is never stored as if it were a fact.

---

## 1. What already exists (architecture check, M0–M6)

| Existing concept                                                                  | Where                                                          | Overlap with M7                                                     | M7 decision                                                                                                                                                          |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ProductKey` (tenant code, `^[a-z0-9][a-z0-9_.-]{0,63}$`)                         | `domain/product.ts`                                            | product identity within a tenant                                    | **Reuse unchanged.** It is the product identity in rules, subscriptions and results                                                                                  |
| `TenantProduct` table `tenant_products` (`key`, `name`, `description`, `active`)  | M2 migration; `tenancy/config/products.ts`                     | the catalogue                                                       | **Evolve**: becomes the **projection** of the active product model (§2). Direct `saveProduct` writes are replaced by publishing a model version                      |
| Tenant template `products: []`                                                    | `config/tenant-templates/*.json`                               | initial catalogue                                                   | **Evolve** into an optional `productModel` (published as version 1 at provisioning). Juniper's stays absent (`tbc`)                                                  |
| `ProductOwnership` / `OwnershipStatus`, `Company.products`, `ownsProduct()`       | `domain/product.ts`, `domain/company.ts`                       | an account's ownership (states active/trial/expired/churned, dates) | **Superseded** by Subscription (§3): same concept, but without history, source, provenance or multiple lines per product. Removed from the Company aggregate         |
| `CompanyProduct` table `company_products` (PK tenant+company+product)             | M2 migration; written only by `PrismaCompanyRepository.create` | the same ownership, persisted                                       | **Migrated** into `tenant_subscriptions` and **dropped** (§21). Nothing in M3–M6 writes it; leaving it would create two competing ownership models                   |
| `ProductSignal` (Gainsight-only refine)                                           | `domain/signals.ts`                                            | product usage                                                       | **Unchanged.** Signals are M10 and independent of eligibility (ADR 0012 already flags the Gainsight-only refine for M10)                                             |
| `LeadCandidate` (`productKey`, equivalence key person+company+product)            | `domain/lead-candidate.ts`                                     | future Account × Product candidate                                  | **Unchanged.** M11 evolves it with its own ADR and consumes M7 results                                                                                               |
| `Lead.productKey`, `SalesOutcome`, qualification decision records                 | `domain/lead.ts`, `sales-outcome.ts`, `qualification.ts`       | none (downstream)                                                   | **Unchanged**                                                                                                                                                        |
| `decideApply` (newer source state wins, tombstones by read time)                  | `domain/source-observation.ts` (M6)                            | applying subscription observations                                  | **Reuse**, generalised to a subscription observation kind (no copy)                                                                                                  |
| `tenant_context_changes` (provenance, field names only)                           | M6                                                             | subscription provenance                                             | **Extend** (`entity_kind` `subscription`, cause `import`, source `import`); no second provenance table                                                               |
| `tenant_sync_checkpoints` (resumable runs, `completed` status)                    | M6                                                             | "has a full subscription load completed?"                           | **Extend** (`kind` `subscription`) and reuse as the ownership-coverage record (§11)                                                                                  |
| `TenantPolicy`, `TenantQualificationConfig` (one mutable row + `version` counter) | M2                                                             | versioning pattern                                                  | **Not reused for rules**: mutable rows cannot reproduce past decisions. M7 introduces immutable published versions (§8), a deliberate new pattern recorded in an ADR |

Nothing in the codebase models eligibility, product relationships or
whitespace today. Account segment, region or size fields do not exist and are
**not invented** (§7).

---

## 2. Q1 — The canonical Product model

A product is **tenant configuration**, owned by the tenant's product model
(§8). It is not a record mirrored from a source system.

| Field            | Type                               | Notes                                                                                       |
| ---------------- | ---------------------------------- | ------------------------------------------------------------------------------------------- |
| `key`            | `ProductKey` (tenant code)         | identity within the tenant; immutable once published; used by rules, subscriptions, results |
| `name`           | label (1–200)                      | display only                                                                                |
| `description`    | text, optional                     | display only                                                                                |
| `family`         | code, optional                     | grouping attribute (Q2)                                                                     |
| `status`         | `active` \| `retired`              | a retired product can be owned but is never whitespace                                      |
| `availableFrom`  | instant, optional                  | not sellable before (effective-date check)                                                  |
| `availableUntil` | instant, optional                  | not sellable from this instant                                                              |
| `externalRefs`   | list of `{system, objectType, id}` | how source systems identify this product (the M8 mapping seam); unique within the tenant    |

There is no free-form metadata bag in M7: no rule type needs one, and an
untyped bag would invite customer-specific logic.

**Identity.** `(tenant_id, key)` remains the product identity (as in M2). No
internal UUID is added. ADR 0014's platform-UUID rule exists for records
mirrored from external systems. A product is tenant-defined: its key is the
platform identity, and external ids are references (`externalRefs`).

**Identity continuity across versions** (ADR 0016 §8). A key, once published,
can never represent a different product. Four rules enforce this:

- **K1, no removal.** Every key in the previous version must still be
  present; a product leaves sale only by becoming `retired`.
- **K2, a retired product's name and family are frozen.** Reactivating it
  keeps them, and must be declared in the document's `lifecycle` section.
- **K3, a changed name on an active product needs `renamedFrom`** equal to
  the previous name.
- **K4, `tenant_products` rows are never deleted.**

So `analytics` retired in v2 and reappearing in v5 as "School Payments" is
rejected:

- it must stay listed in v3–v4;
- v5's name change on a retired product fails
  `retired_product_identity_change`.

"Analytics" → "Analytics Pro" with `renamedFrom` is a legitimate rename.
Description, family, availability and status may change freely.

A UUID would add nothing. It would be assigned by looking up the key, so it
would carry no extra evidence, and keys are immutable and never reassigned.
The evidence that tells a rename from reuse is the key's unbroken presence
across versions, plus an explicit, audited declaration in the immutable
version.

## 3. Q2 — Product family: entity or attribute?

**An attribute** (`family` code) in M7. No M7 rule needs family-level data,
and "requires any core tier" is expressed with `requires … anyOf` (§5). A
family entity with its own lifecycle would be unused structure. If a later
milestone needs family-level fields, `family` codes can be promoted to an
entity without changing product keys.

## 4. Q3 — The canonical Subscription / Entitlement model

A **subscription** is one source line stating that an account holds a product,
whatever the source calls it (subscription, entitlement, asset, contract line,
licence). An account can hold several lines for one product (renewals, two
contracts, a trial then a paid line). Ownership per account × product is
**derived** from all of them at evaluation time (§9), never stored.

| Field                                                     | Type                                                         | Notes                                                                                                      |
| --------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `id`                                                      | platform UUID                                                | canonical (ADR 0014)                                                                                       |
| `companyId`                                               | canonical company (M6)                                       | tenant-scoped FK                                                                                           |
| `productKey`                                              | `ProductKey`                                                 | tenant-scoped FK to the catalogue projection                                                               |
| `state`                                                   | `active` \| `trial` \| `expired` \| `cancelled` \| `unknown` | canonical; source values are mapped by configuration (M8). An unmappable value is `unknown`, never guessed |
| `startsAt`, `endsAt`                                      | instant, optional                                            | `endsAt` > `startsAt` when both are present                                                                |
| `quantity`                                                | positive integer, optional                                   | stored because sources commonly carry it; **no M7 rule uses it** (expansion is out of scope)               |
| source reference                                          | `sourceSystem`, `sourceObjectType`, `sourceRecordId`         | unique per tenant: one source line maps to one subscription                                                |
| `recordState`                                             | `active` \| `deleted`                                        | `deleted` = removed at the source (tombstone, kept for audit)                                              |
| `sourceUpdatedAt`, `observedAt`, `deletedAt`, `fieldHash` | as M6 references                                             | ordering, idempotency and tombstones via `decideApply`                                                     |
| `firstSeenAt`, `lastSeenAt`, `lastChangeId`               | as M6                                                        | provenance link                                                                                            |

**Tiers** are modelled as separate products (`core-basic`, `core-pro`) related
by `replaces`/`excludes`, so no `tier` column is added. `churned` (from the M1
`OwnershipStatus`) is an account-level interpretation, not a line state; M1 rows
with `churned` migrate to `cancelled`.

What a source must provide is the **canonical subscription contract** (§18).
How it maps its own fields is M8 configuration.

## 5. Q4–Q5 — Minimal relationship model: `requires`, `excludes`, `replaces`, `includes`

Four relationship types. Each one is justified by an eligibility effect; the
charter (§5, §7) names all four.

| Relationship                     | Written as                                                 | Meaning                                      | Effect on eligibility for product P                                                                                                       |
| -------------------------------- | ---------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **requires**                     | `{ type: requires, product: P, anyOf: [S1, S2], states? }` | P needs ownership of at least one of `anyOf` | not met → **ineligible** (`requirement_unmet`); `states` narrows which subscription states satisfy it (default: the model's owned states) |
| **excludes** (mutual, symmetric) | `{ type: excludes, products: [A, B] }`                     | A and B cannot be held together              | owning A → B ineligible (`excluded_by_owned`), and vice versa                                                                             |
| **replaces**                     | `{ type: replaces, product: B, replaced: A }`              | B supersedes A (upgrade, successor)          | owning B → A ineligible (`superseded_by_owned`). Owning A does **not** block B: that is the upgrade path                                  |
| **includes**                     | `{ type: includes, product: B, included: A }`              | B contains A (bundle)                        | owning B counts as owning A **for every check**: already-owned, requirements and exclusions                                               |

Deliberately **not** modelled:

- **compatible-with**: it has no eligibility effect.
- **Parent/child**: `family` covers grouping.
- **Transitive requirements**: P requires S, and S requires T. P only checks
  the direct requirement. Owning S already reflects S's own rules, so the
  evaluator never recurses through `requires`.
- A generic graph engine.

## 6. Q6 — Preventing cycles and invalid configuration

Validation is a pure function run on **every** model version before it is
published (`publish` and `validate --dry-run`). A model that fails is never
stored. Errors are reported with stable codes and the JSON path of the
offending entry:

| Check                                                                                       | Code                              |
| ------------------------------------------------------------------------------------------- | --------------------------------- |
| duplicate product key                                                                       | `duplicate_product_key`           |
| duplicate external reference (two products claim one source id)                             | `duplicate_external_ref`          |
| relationship or rule references an unknown product or family                                | `unknown_product_reference`       |
| self-reference (`requires P anyOf [P]`, `excludes [P, P]`, `replaces P→P`, `includes P→P`)  | `self_reference`                  |
| cycle in `requires` (A requires B, B requires A; longer cycles too)                         | `requires_cycle`                  |
| cycle in `includes ∪ replaces` (A includes B, B replaces A; A replaces B replaces A)        | `supersession_cycle`              |
| `requires P anyOf S` where every member of S is excluded with P                             | `unsatisfiable_requirement`       |
| `includes B→A` while `excludes [A, B]`                                                      | `contradictory_relationship`      |
| duplicate relationship or rule id                                                           | `duplicate_rule`                  |
| `availableUntil` ≤ `availableFrom`                                                          | `invalid_availability_window`     |
| a key in the previous version is missing (K1)                                               | `product_key_removed`             |
| a retired product changes name or family (K2)                                               | `retired_product_identity_change` |
| a retired product becomes active without a `lifecycle` reactivate entry (K2)                | `undeclared_reactivation`         |
| an active product's name changes without a matching `renamedFrom` (K3)                      | `undeclared_rename`               |
| `requires` uses anything but `anyOf` (`allOf` is not supported in M7)                       | `unsupported_relationship_form`   |
| `effectiveFrom` earlier than the latest published version's `effectiveFrom`, or in the past | `invalid_effective_from`          |
| rule attribute not in the canonical attribute list (§7)                                     | `unknown_attribute`               |
| size limits (≤ 2 000 products, ≤ 10 000 relationships and rules, ≤ 50 members in `anyOf`)   | `model_too_large`                 |

Cycles are found by an iterative DFS with an explicit stack and three colours
(no recursion), reporting **one witness path** (`A → B → A`). Warnings, which
do not block publishing:

- an active product requires only retired products;
- a product is unreachable (it requires a product that is itself never
  sellable).

The evaluator still guards itself: the `includes` closure is computed
iteratively with a visited set, bounded by the product count, so a corrupt
stored model fails loudly instead of looping.

## 7. Q7 — What an eligibility rule is

An eligibility **check** is one named, pure test that yields
`pass | fail | unknown | not_applicable`, a reason code and the facts it read.
There are two kinds:

**Built-in checks.** They are part of eligibility's meaning, are always on,
and are versioned with the evaluator:

1. `product_available`: the product is `active`, and `asOf` lies in its
   availability window. Otherwise `fail` (`product_retired` or
   `product_not_available`).
2. `not_already_owned`: the product is owned directly or via `includes`.
   If so, `fail` (`already_owned`).
3. `not_superseded`: no owned product `replaces` it.
4. `not_excluded`: no owned product is mutually exclusive with it.
5. `requirements_met`: one per `requires` relationship of the product.

**Configured conditions.** These are tenant data, scoped by `appliesTo`
(a product list, a family list or `all`). M7 has one condition type:

- `account_attribute`: `{ id, appliesTo, attribute, op: in | not_in, values }`.
  The attribute must come from a **closed, canonical** list. In M7 that list
  is `customer_status` (`prospect | customer | former_customer | unknown`, from
  the M6 company). Segment, region and size are added to the canonical account
  model, and to this list, only when a connected source supplies them (M8/M9);
  that is additive. A missing or `unknown` value makes the check `unknown`.

Not M7:

- **Cool-off after disqualification** and **already being pursued**. These need
  lead and outcome history and belong to M11 suppression (ADR 0006).
- **Quantity thresholds.** Expansion is out of scope.
- **Scoring.**

Adding a new check **type** is a code change with an evaluator version bump.
Adding or changing check **instances** is data.

## 8. Q8 — How rules (and the catalogue) are versioned

**One immutable product model per tenant per version.** It contains the
catalogue, the relationships, the configured conditions and the ownership
settings. They are validated together, so a relationship can never point at a
product from a different version.

```jsonc
{
  "ownership": { "ownedStates": ["active", "trial"] }, // which states count as owning
  "products": [{ "key": "core", "name": "Core", "family": "platform", "status": "active" }],
  "relationships": [
    { "id": "analytics-needs-core", "type": "requires", "product": "analytics", "anyOf": ["core"] },
  ],
  "conditions": [
    {
      "id": "customers-only",
      "type": "account_attribute",
      "appliesTo": { "families": ["addons"] },
      "attribute": "customer_status",
      "op": "in",
      "values": ["customer"],
    },
  ],
}
```

- **Publishing** validates the document. It then inserts row `version = n+1`,
  holding the document, its SHA-256 `contentHash`, `effectiveFrom` (default
  now; future scheduling allowed; monotonic), the publishing actor and
  `publishedAt`. In the **same transaction** it upserts the `tenant_products`
  projection (new keys added; name, family and status updated). Keys are never
  absent from a later version (K1), and projection rows are never deleted
  (K4). Versions are **never edited or deleted** (immutability trigger). A
  correction is a new version.
- **Failed and concurrent publication.** Validation, version insert and
  projection update are one transaction. A failure leaves no version and no
  projection change. Two concurrent publishes for one tenant are serialised by
  a per-tenant advisory lock plus the unique `(tenant_id, version)`. The
  second gets a clear `concurrent_publish` conflict and must re-validate
  against the new latest version, because K1–K3 compare with it.
- **Evaluation during activation.** Models are selected from immutable rows
  by `effectiveFrom`. An evaluation sees exactly one version (old or new),
  recorded in its result.
- **Renames and reactivations** are declared in the document: `renamedFrom`
  on the product, and `lifecycle: [{ "key": "…", "action": "reactivate" }]`.
  Both are kept in the version and shown by `product:model diff`.
- **`requires` supports `anyOf` only.** Several `requires` entries on one
  product already mean "all of these groups". `allOf` is not added until a
  real requirement shows a need for it (approved).
- **Selection**: the version in force at `asOf` is the highest version with
  `effectiveFrom ≤ asOf`. There are no drafts in the database; a draft is a file
  checked by `validate`.
- **Effective dates** exist at two levels only: the version's `effectiveFrom`
  (when the policy changes) and a product's `availableFrom`/`availableUntil`
  (when it can be sold). This is not bitemporal modelling.
- Each result records `modelVersion` and `modelHash`, plus `evaluatorVersion`
  (the built-in semantics). Old versions remain loadable, so an old decision
  can be re-run exactly (§15).

Catalogue and rules share **one** version rather than two independent ones.
Keeping them apart would let a rule version refer to a catalogue state it was
never validated against.

## 9. Q9 — Data or code?

**Rules are data. Their semantics are code.**

- A rule set is a strict-Zod-validated JSON document per tenant and version.
- It is interpreted by a small, fixed set of pure TypeScript check functions,
  one per check type.
- There is no expression language, no `eval`, and no external rules engine
  (ADR 0012).
- A tenant cannot express logic the platform has not implemented and tested.
  This is the guard rail against the evaluator turning into a rules-engine
  project.

**Ownership derivation**, also pure. A product is owned at `asOf` when
any non-deleted subscription for it meets all three conditions:

- its state is in `ownership.ownedStates`;
- `startsAt` is absent or ≤ `asOf`;
- `endsAt` is absent or > `asOf`.

Owned products are then closed over `includes`. An owned line in state
`unknown`, or with dates that cannot be compared, makes ownership of that
product `unknown`.

## 10. Q10 — The pure evaluator: input and output

```ts
evaluateEligibility(input: EligibilityInput): EligibilityResult   // pure, synchronous, no I/O, no clock

interface EligibilityInput {
  model: ValidatedProductModel;            // version, contentHash, indexed relationships
  account: { companyId; recordState; customerStatus };
  ownership:
    | { coverage: 'known'; knownAsOf: Instant; subscriptions: SubscriptionFact[] }
    | { coverage: 'unknown' };             // no completed full subscription load (§11)
  productKey: ProductKey;
  asOf: Instant;                           // passed in; the evaluator never reads the clock
}

interface EligibilityResult {
  productKey; companyId; asOf;
  status: 'eligible' | 'ineligible' | 'unknown';
  ownership: 'owned' | 'not_owned' | 'unknown';
  checks: Array<{
    check: CheckCode; ruleId?: string;     // relationship/condition id when configured
    outcome: 'pass' | 'fail' | 'unknown' | 'not_applicable';
    reason: ReasonCode;                     // e.g. requirement_unmet, already_owned
    facts: FactRef[];                       // subscription ids, product keys, attribute names
  }>;
  modelVersion; modelHash; evaluatorVersion; factsHash;  // factsHash = SHA-256 of the canonicalised input facts
}
```

**Precedence**, fixed and documented:

1. Every check is always evaluated; nothing short-circuits, so the explanation
   is complete.
2. If any check is `fail`, the result is **ineligible**. One definite blocker
   is enough, even if other checks are unknown.
3. Otherwise, if any check is `unknown`, the result is **unknown**.
4. Otherwise, **eligible**.

Checks are emitted in a fixed order, which makes `checks` deterministic. A
merged or deleted account is not evaluated: the service resolves merges first
(M6) and refuses deleted accounts.

Example (generic):

```
Product analytics-plus → INELIGIBLE   (model v3, evaluator 1, asOf 2026-11-01T00:00Z)
  ✗ not_already_owned    already_owned          subscription 7f…  (analytics-plus, active)
  ✗ requirements_met     requirement_unmet      rule analytics-plus-needs-core: anyOf [core] — none owned
  ✓ not_excluded, not_superseded, product_available, customers-only
```

## 11. Q11 — What `unknown` means

`unknown` means the platform **cannot decide from the facts it holds**. It is
never a polite form of "no", and it never becomes "eligible" by default. There
are four causes, each with its own reason code:

| Cause                                                                                                          | Reason                       |
| -------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| no completed **full** subscription load for the tenant: "owns nothing" cannot be told apart from "no data yet" | `ownership_not_loaded`       |
| a relevant subscription is in state `unknown`                                                                  | `subscription_state_unknown` |
| a relevant subscription's dates cannot be compared (e.g. `startsAt` missing where the window matters)          | `subscription_dates_unknown` |
| an attribute condition needs a value the account does not have                                                 | `attribute_missing`          |

**Ownership coverage** is the key safeguard: whitespace is never inferred
from the _absence_ of data. It is known once a full subscription load has
completed: an M7 CSV import in `full` mode now, or the M8 connector's backfill
later. Both are recorded as a completed `tenant_sync_checkpoints` row of kind
`subscription`. Until then, every product for every account in the tenant is
`unknown` (`ownership_not_loaded`). Coverage is per tenant in M7. Per-source
or per-account coverage, when authority is split across systems, is decided at
the discovery gate (§30).

## 12. Q12 — Already-owned suppression

A **built-in check** (`not_already_owned`), not a configurable rule. It
fails when the product is owned directly or through an `includes` bundle.
Tenants cannot disable it, because "may newly acquire" is meaningless for a
product already held. Owned products are still reported, under the
whitespace category `owned`, so that M11 can treat renewal or expansion of
owned products as a **separate** opportunity type. M7 does not evaluate
renewals or expansions.

## 13. Q13 — What whitespace is

**Not-owned products** are every product in the tenant's catalogue, at
`asOf`, that the account does not own: neither directly nor through an
`includes` bundle. These are the candidates for evaluation.
**Eligibility** then decides whether each candidate is commercially valid
whitespace.

`listWhitespace(account, asOf)` evaluates every catalogue product and groups
the results:

| Category                | Meaning                                                                                                    |
| ----------------------- | ---------------------------------------------------------------------------------------------------------- |
| `owned`                 | ownership `owned` (direct or included)                                                                     |
| `eligible_whitespace`   | not owned, status `eligible`                                                                               |
| `ineligible_whitespace` | not owned, status `ineligible`, with reasons (superseded, excluded, requirement unmet, retired, condition) |
| `unknown`               | ownership or status `unknown`, with the missing-data reasons                                               |

`not_owned` = `eligible_whitespace ∪ ineligible_whitespace` (and `unknown`
entries where ownership is known but a condition is not). Retired products
appear only under `owned` (if held) or `ineligible_whitespace`.

The charter's full whitespace definition also excludes products "already
being pursued". That part needs open leads and opportunities, so it is
**M11 suppression**, applied on top of `eligible_whitespace`. M7 says nothing
about pursuit. There is no ranking or scoring of whitespace in M7.

## 14. Q14 — Are eligibility results persisted? (A / B / C)

**C — hybrid.**

- **On demand by default.** Evaluation is pure and cheap: one tenant model
  (cached by `tenant + version`, which is immutable, so the cache cannot cross
  tenants or go stale), plus one account's subscriptions. Nothing is written,
  so there is no decision table to keep in sync with changing facts.
- **Snapshot when used.** `tenant_eligibility_snapshots` is an **append-only**
  record of one complete result. It holds the inputs actually used (subscription
  facts, the attribute values read), every check, `modelVersion`, `modelHash`,
  `evaluatorVersion`, `factsHash`, `asOf`, `evaluatedAt`, a purpose code and a
  correlation id. It is written only when a consumer relies on the decision:
  the CLI's `--record` (audit) now, and every M11 candidate later. M11 stores
  the snapshot id as candidate evidence.

Why not A (on demand only)? Facts are current-state: a later subscription
change would make an old decision impossible to reproduce, and M11 needs its
evidence frozen. Why not B (persist everything)? Results would go stale the
moment a fact changed. The table would grow per account × product on every
recompute, and it would invite treating a decision as a fact.

## 15. Q15 — Preserving explainability

Every result answers the questions directly:

- **which account and product, and when?** `companyId`, `productKey`, `asOf`,
  `evaluatedAt`.
- **which facts were evaluated?** `checks[].facts`, plus the snapshot's frozen
  input facts.
- **which rules and version?** `ruleId`, `modelVersion`, `modelHash`,
  `evaluatorVersion`.
- **which dependencies or exclusions mattered?** The failing or unknown checks,
  with their rule ids.
- **what result, and why?** `status`, plus every check's reason code.

Reproducibility is proven by tests:

- re-running the evaluator on a snapshot's stored inputs, with the stored model
  version, yields a byte-identical result (same `factsHash`, same checks);
- a later model version gives a different answer without changing the old
  snapshot.

Reason codes are stable identifiers. Human-readable text is rendered from the
codes in the CLI, never stored as the explanation.

## 16. Q16 — Preserving provenance

Provenance here is **product and subscription context**, not M10 signal
provenance.

- **Subscriptions.** These follow the M6 pattern:
  - a source reference and source/observed times on the row;
  - every create, change or tombstone written to `tenant_context_changes`
    (`entity_kind = subscription`), with changed **field names only**, cause
    (`import` now; `backfill` / `reconciliation` / `webhook` for M8), source,
    correlation id and the import checkpoint id.
  - There are no values in provenance (existing CHECKs).
- **Product model.** The immutable version rows are the audit trail: who
  published, when, the hash, and the effective date. `product:model diff`
  shows the changes between versions. No separate change log is needed.
- **Imported records.** The import file's SHA-256, row count, mode and
  operator are recorded on the checkpoint. Rows reference the declared source
  (`import`, or the system the file was exported from), always with cause
  `import`, so an import can never pass for connector data.
- **Decisions.** Snapshots record their inputs and versions (§14).

## 17. Q17 — Tenant isolation

Everything follows ADR 0008, and the schema guard enforces it on every new
table:

- `tenant_product_models`, `tenant_subscriptions` and
  `tenant_eligibility_snapshots` have `tenant_id`, **forced RLS** with the
  `app_current_tenant()` policy, an immutable-tenant trigger, and
  tenant-scoped keys and FKs (`(tenant_id, company_id)`,
  `(tenant_id, product_key)`).
- Access goes only through `TenantDatabase.transaction(ctx, …)`. The
  evaluator is pure, and its inputs are loaded inside one tenant
  transaction.
- The model cache key includes the tenant id.
- There is **no global or shared catalogue**: identical keys in two tenants are
  unrelated. There are no cross-tenant rule references.
- Integration tests cover:
  - tenant A cannot read tenant B's model, subscriptions or snapshots;
  - an evaluation for tenant A never loads tenant B's facts, even when product
    keys and external ids are identical;
  - the mutation proof removes RLS from one new table and watches the guard
    fail.

## 18. Q18 — How a future connector populates subscriptions

Through **one writer**: `SubscriptionIngestionService.ingest(ctx,
observation, meta)`. It is the M7 counterpart of M6's
`ContextIngestionService` and has the same guarantees:

- one tenant transaction per line;
- a per-line advisory lock;
- `decideApply`: newer source time wins, an old snapshot cannot resurrect a
  tombstone, and an unchanged hash is a no-op;
- provenance is written inside the same transaction.

A dependency rule enforces that only this writer may write subscriptions.
The **canonical subscription observation** is the contract every source maps
into:

```
{ source: { system, objectType, recordId }, companyRef, productRef, state, startsAt?, endsAt?, quantity?,
  sourceUpdatedAt?, observedAt, presence: 'present' | 'absent' }
```

- `companyRef` is resolved to a canonical company through the M6 external
  references. An unresolved account means the line is rejected and reported
  (`unknown_account`). Identity resolution across systems is charter open
  question 1, and M7 does not guess.
- `productRef` is resolved through the active model's `externalRefs`, or used
  directly as a product key. An unknown product means the line is rejected and
  reported (`unknown_product`).
- Source status values are mapped to canonical `state` by **connector
  configuration** (M8). Unmapped values become `unknown`.
- A **full** load ends by tombstoning that source's lines not seen in the load,
  then marks the checkpoint completed, which makes ownership coverage known.

An M8 connector therefore adds:

- a source adapter (vendor payload → observation, validated with Zod at the
  boundary);
- mapping configuration;
- possibly an `ExternalSystem` value.

It changes nothing in the catalogue, the evaluator or the writer.

## 19. Q19 — Temporary input before M8

No fake connector. Input arrives by explicit means only:

- **Generic test fixtures** (`apps/api/test/fixtures/product-models/*.json`,
  `…/subscriptions/*.csv`), fictional and used by the tests.
- **A documented example** (`config/examples/product-model.example.json`,
  `config/examples/subscriptions.example.csv`), clearly fictional, used by the
  runtime script and the operations guide.
- **The CSV import** through the admin CLI (`subscriptions:import`): dry run
  by default, `--execute` to write, `--mode full | incremental`. Each row is
  validated with strict Zod, and errors are reported by row number and code.
- **The tenant template** gains an optional `productModel`. Juniper's stays
  absent: its products and rules are `tbc` until Juniper supplies them.

## 20. Q20 — APIs and CLI

**Internal services** (module `products`, vendor-neutral):

| Interface                                                                        | Purpose                                                             |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `ProductCatalogueService.modelAt(ctx, asOf)`                                     | the model version in force (validated, cached)                      |
| `ProductCatalogueService.getProduct(ctx, key)` / `listProducts(ctx, filter)`     | catalogue reads (projection + model)                                |
| `ProductCatalogueService.publish(ctx, document, {effectiveFrom, actor, dryRun})` | validate and publish; returns the validation report and new version |
| `SubscriptionIngestionService.ingest(ctx, observation, meta)`                    | the single subscription writer                                      |
| `SubscriptionReadModel.accountSubscriptions(ctx, companyId)`                     | facts for one account                                               |
| `EligibilityService.evaluate(ctx, companyId, productKey, {asOf?, record?})`      | load facts → pure evaluator → optional snapshot                     |
| `EligibilityService.whitespace(ctx, companyId, {asOf?})`                         | every product, grouped (§13)                                        |

**CLI.** Every command takes `--tenant`; mutating commands are dry runs unless
`--execute`. Output is JSON with keys, ids, codes and hashes:

`product:model validate --file` · `product:model publish --file [--effective-from] --execute` ·
`product:model show [--version]` · `product:model diff --from --to` ·
`subscriptions:import --file --source --mode full|incremental --execute` ·
`subscriptions:show --company` · `eligibility:evaluate --company --product [--as-of] [--record --execute]` ·
`eligibility:whitespace --company [--as-of]` · `products:report`.

**No HTTP API in M7.** There is no consumer before M11 and the M14 workspace.
No product endpoint exists today either; catalogue reads stay internal and
CLI-only.

## 21. Q21 — Database and schema changes (proposed, not made)

| Change                               | Detail                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tenant_product_models` (new)        | `tenant_id`, `version` (int, unique per tenant), `document` jsonb, `content_hash` (CHECK hex 64), `effective_from`, `published_at`, `published_by` (actor code). Immutability trigger (no UPDATE/DELETE), forced RLS                                                                                                                                         |
| `tenant_products` (evolve)           | add `family` (code, nullable) and `model_version` (last version defining it). `active` is set by publishing. The PK `(tenant_id, key)` is unchanged. A trigger refuses DELETE (K4)                                                                                                                                                                           |
| `tenant_subscriptions` (new)         | fields of §4; FKs `(tenant_id, company_id)` → companies (RESTRICT) and `(tenant_id, product_key)` → tenant_products (RESTRICT); unique `(tenant_id, source_system, source_object_type, source_record_id)`; CHECKs: states, dates, quantity > 0, hash format, id formats; indexes `(tenant_id, company_id)` and `(tenant_id, product_key)`; forced RLS        |
| `company_products` (drop)            | rows migrated first into `tenant_subscriptions` (`source_system = import`, `source_object_type = legacy_company_product`, `source_record_id = <company_id>:<product_key>`, `churned → cancelled`), one provenance row each (cause `import`)                                                                                                                  |
| `tenant_context_changes` (extend)    | CHECKs: `entity_kind` += `subscription`; `cause` += `import`; `source_system` += `import`                                                                                                                                                                                                                                                                    |
| `tenant_sync_checkpoints` (extend)   | CHECKs: `kind` += `subscription`; `system` += `import`. Adds an optional `input_hash` (import file SHA-256)                                                                                                                                                                                                                                                  |
| `tenant_eligibility_snapshots` (new) | `id`, `tenant_id`, `company_id`, `product_key`, `as_of`, `evaluated_at`, `status`, `ownership`, `model_version`, `model_hash`, `evaluator_version`, `facts_hash`, `result` jsonb (checks + frozen facts; CHECK size ≤ 64 KiB), `purpose` code, `correlation_id`. Append-only trigger, forced RLS, index `(tenant_id, company_id, product_key, evaluated_at)` |

**Code.**

- `Company.products`, `ProductOwnership`, `OwnershipStatus` and `ownsProduct()`
  are removed. The company repository stops reading and writing products.
- New domain types: `ProductModel`, `Subscription`, `EligibilityResult`.
- The tenant template's `products` becomes an optional `productModel`.
- `TenantConfigService.saveProduct` is removed; `listProducts` stays.
- **The M6 merge is extended, not rewritten** (see
  [account merge](#account-merge-and-subscriptions)):
  - context defines a `CompanyMergeParticipant` port;
  - `ContextModule.register` requires `mergeParticipants`;
  - `ContextIngestionService.merge` calls the participants inside its
    transaction, right after `repointRefs`, and takes canonical-company locks
    for the loser and the survivor.
- Three dependency rules:
  - only `SubscriptionIngestionService` and its merge participant write
    subscriptions;
  - the evaluator module imports nothing with I/O;
  - `qualification` may not import the eligibility module.

## 22. Q22 — Migrations (proposed, not created)

1. `2026xxxx_m7_product_model_and_subscriptions`: the product models table;
   the `tenant_products` columns; the subscriptions table; the
   `company_products` → `tenant_subscriptions` data migration and drop; the
   CHECK extensions; RLS and triggers.
2. `2026xxxx_m7_eligibility_snapshots`: the snapshots table, RLS and the
   append-only trigger.

Both come with **development/staging down-scripts** (as in M6), tested to
restore exactly the M6 schema. The subscriptions down-script **refuses** data
the old schema cannot hold: more than one line per company and product, a
deleted line, a line from a non-legacy source, or state `unknown`. A
migrations-spec upgrade test seeds M6-era `company_products` rows and checks
they arrive as subscriptions with provenance. Production policy stays
forward-fix.

## 23. Q23 — ADRs (proposed)

- **[ADR 0016](../adr/0016-product-model-versioning.md), product model:**
  - one immutable, validated document per tenant and version (catalogue,
    relationships, conditions, owned states);
  - selection by `effectiveFrom`;
  - a transactional read-only projection;
  - rules as data and semantics as code, with no engine or expression
    language;
  - `requires` supports `anyOf` only;
  - the cross-version identity rules K1–K4, with no internal UUID;
  - failed and concurrent publication.
- **[ADR 0017](../adr/0017-subscriptions-and-ownership.md), subscriptions and
  ownership:**
  - the canonical subscription contract, with multiple lines per product and
    derived ownership;
  - the single writer, with a field hash over source values only;
  - tenant-level coverage (provisional);
  - the legacy migration;
  - **account merge**: participant hook, set-based repoint, merge provenance,
    canonical-company locks, idempotency, snapshots unchanged, and a
    detect-only invariant;
  - privacy and retention deferred to technical debt #15/#17.
- **[ADR 0018](../adr/0018-eligibility-and-whitespace.md), eligibility and
  whitespace:**
  - the pure evaluator, its checks and precedence;
  - what `unknown` means;
  - whitespace categories;
  - hybrid snapshots;
  - the explainability and UI contract;
  - the M10, M11 and M12 boundaries;
  - override deferred;
  - snapshots and tenant deletion deferred to the retention policy.

## 24. Q24 — Unit, integration and property-based tests

- **Validator (unit).** One test per error code in §6, each with a minimal
  invalid model and the expected code and path. Valid models from the
  fixtures pass, and the warnings fire.
- **Evaluator (unit, branch).** Every check × outcome:
  - ownership derivation: states, date windows, `unknown`, `includes`
    closure, transitive bundles;
  - precedence: fail beats unknown beats eligible;
  - deterministic check order;
  - `factsHash` stability;
  - the "no clock" guarantee (the same `asOf` always gives the same result).
- **Property-based.** Random valid models (DAGs) and random facts:
  - the evaluator is total (never throws, always terminates);
  - it is deterministic (same input, same output);
  - `eligible` never coexists with a `fail` check;
  - an owned product is never `eligible_whitespace`;
  - when ownership is unknown, nothing is eligible;
  - adding a `requires` never turns `ineligible` into `eligible`;
  - every invalid edit (injected cycle, self-reference, dangling reference)
    is rejected by the validator.

  Generator: **`fast-check` as a direct devDependency**. It is already in the
  lockfile as a transitive package, but adding it directly is a dependency
  change, so it is an **approval point**. The fallback, without approval, is
  a seeded in-repo generator.

- **Integration (Testcontainers).**
  - Publish, then select the version by `asOf`; versions are immutable (an
    UPDATE is refused by the trigger); the projection is updated and nothing
    is deleted.
  - CSV import, dry run then execute, in full and incremental mode:
    tombstones, idempotency, an unknown account or product rejected, and
    provenance rows written.
  - Coverage: everything is `unknown` before the first full load.
  - Evaluation through the service, and snapshot reproducibility.
  - The `company_products` upgrade migration and the down-scripts.
  - Tenant isolation (§17).
  - The single writer under concurrency: one line ingested twice
    concurrently gives one row and one provenance entry.
  - **Account merge after subscriptions exist.** Merging A into B moves
    A's lines to B:
    - same ids and source references, nothing created or deleted;
    - one `merged` provenance row each, carrying the merge's cause;
    - the survivor's ownership includes both;
    - a replayed merge is a no-op;
    - a chain merge (B into C) moves them again;
    - a cross-system refusal leaves them untouched;
    - a snapshot recorded before the merge is byte-identical afterwards;
    - evaluating A resolves to B and reports both ids.
  - **Concurrent merge and import.** A merge and an import of A's lines run
    in parallel, with forced interleaving (as in the M6 race tests). No line
    ends on the merged company and there is no deadlock. The orphan
    invariant holds.
  - **Composition.** The worker and the context CLI register the subscription
    merge participant.

## 25. Q25 — Mutation and failure tests

Each proof temporarily breaks one mechanism and shows that a test fails **for
the right reason**, then passes again once restored (as in M6):

- remove the `requires_cycle` check → the cycle test fails;
- remove the `supersession_cycle` check;
- disable each built-in check in turn: `already_owned`, `superseded`,
  `excluded`, `requirement_unmet`, `product_available`;
- flip precedence so unknown beats fail;
- treat `unknown` coverage as "owns nothing" → whitespace is inferred from no
  data and the test catches it;
- count `trial` as owned regardless of `ownedStates`;
- drop the `includes` closure;
- evaluator reads the clock instead of `asOf`;
- allow an UPDATE on a published model;
- RLS off on `tenant_subscriptions`;
- another module writes subscriptions directly, bypassing the single writer →
  the dependency rule fails;
- import without a tombstone pass in full mode;
- snapshot written outside the evaluation transaction;
- the merge participant call removed → the merge test finds orphaned lines
  on the merged company;
- the canonical-company lock removed from ingestion or the merge → the
  forced-interleaving race test fails;
- the field hash includes the canonical company → a re-delivered line after
  a merge is reported as changed;
- each of K1, K2 and K3 disabled → the key-reuse and undeclared-rename tests
  fail;
- the `tenant_products` DELETE trigger removed → the key-permanence test
  fails.

**Failure tests:**

- a malformed CSV row, oversize file or wrong encoding is reported and
  nothing is written;
- the import is killed midway: the checkpoint stays incomplete and coverage
  stays unknown;
- a concurrent publish: one version wins and the other gets a clear conflict;
- a corrupt stored model (simulated by bypassing the trigger as owner in a
  test) makes evaluation fail loudly instead of looping.

## 26. Q26 — Invalid-configuration tests

Every row of §6 has a test, plus:

- a replacement loop (`A replaces B`, `B replaces A`);
- a mixed loop (`A includes B`, `B replaces A`);
- an exclusion conflicting with an inclusion;
- an unsatisfiable requirement (all alternatives excluded);
- a duplicate product key;
- a duplicate external ref across products;
- a missing referenced product or family;
- an unknown attribute;
- an invalid availability window;
- an `effectiveFrom` in the past or before the previous version;
- key reuse: a key retired in v2 reappears in v5 with a different name
  (`retired_product_identity_change`);
- a key dropped from a later version (`product_key_removed`);
- an undeclared rename, and a wrong `renamedFrom`;
- an undeclared reactivation;
- an `allOf` form;
- a version that refers to a product removed in the same version;
- an oversize model;
- unknown JSON keys (strict schema);
- product keys that violate the code format.

## 27. Q27 — Runtime verification

New script `scripts/verify-runtime.d/60-product-eligibility.sh`, run through
the CLI against real PostgreSQL:

1. Validate and publish the example model. A second publish with a cycle is
   refused with `requires_cycle` and leaves no new version.
2. Before any import, `eligibility:whitespace` returns everything `unknown`
   (`ownership_not_loaded`).
3. Import the example CSV (dry run, then `--execute` in full mode). Check:
   - counts;
   - provenance rows;
   - the checkpoint completed;
   - re-importing writes nothing (idempotent).
4. `eligibility:evaluate` gives the expected eligible, ineligible and owned
   answers for the example accounts, with reason codes.
5. `--record` writes one snapshot. Re-evaluating that snapshot's inputs gives
   an equal `factsHash` and an equal result.
6. A full import without one line tombstones it, and the answer changes as
   expected.
7. Publish a v2 with an effective date in the future. Evaluating `--as-of`
   before and after that date shows v1 and v2 respectively.
8. Final checks:
   - no CRM call of any kind;
   - logs contain only keys, ids and codes (no names, emails or file
     contents);
   - no leftover processes or connections.

## 28. Q28 — Docker and fresh-clone evidence

- `pnpm verify:docker` adds an in-image check: the product CLI validates the
  example model, and the migrate image applies both migrations.
- A **fresh clone of the final head** runs install, `pnpm verify`,
  `pnpm verify:runtime` (including script 60), `pnpm test:live` (the existing
  suite; M7 adds no live test because it has no connector) and Docker, and
  leaves no resources behind.
- CI is green on the exact final SHA, and the record cites that SHA for all
  evidence.

## 29. Q29 — Acceptance criteria

1. A tenant can validate, publish and inspect versioned product models.
   Invalid models (every §6 case) are refused with stable codes, and published
   versions are immutable.
2. Subscriptions are written by one writer, with source references,
   tombstones and provenance (field names only). `company_products` is
   migrated and removed, with no competing ownership model left.
3. `eligibility(account, product, asOf)` and `whitespace(account, asOf)` are
   pure and deterministic, and return a status with every check. Each result
   names the facts, rule ids, model version and hash, evaluator version and
   `asOf`.
4. When the facts cannot decide, the result is `unknown` with a reason.
   Whitespace is never inferred from missing ownership data.
5. Already-owned (including bundles), supersession, exclusion, requirements,
   availability and the attribute condition each behave as specified, and
   each has a mutation proof.
6. Snapshots are append-only and reproduce exactly. A later model version
   never changes an old snapshot.
7. Tenant isolation is proven on every new table and on evaluation.
8. An account merge moves subscriptions to the survivor:
   - in the M6 merge transaction;
   - as the same rows, with merge provenance, under the canonical-company
     lock;
   - with no orphans, duplicates or lost provenance;
   - leaving earlier snapshots unchanged.
9. A product key can never be reused for a different product (K1–K4).
   Renames and reactivations are explicit and audited.
10. No Juniper product, rule or field appears in code. Juniper configuration
    stays `tbc`. The generic examples are labelled fictional.
11. No connector, signal, candidate, lead, qualification, routing, CRM write,
    UI or AI code is added.
12. The following all pass, with evidence on the final SHA: `pnpm verify`,
    runtime (with script 60), Docker, the fresh clone and CI, plus the
    upgrade migration and down-scripts.
13. ADRs 0016–0018, this record, the operations guide and technical debt are
    updated. The independent review passes.

## 30. Q30 — Unresolved until Subscription Source Discovery

- Which system or systems hold subscription and entitlement truth for Juniper.
- If authority is split, which source wins for which fact. M7 treats every
  non-deleted line as a fact. A per-source authority filter (`ownership.sources`
  in the model) is an **additive** option if the gate requires it.
- Whether coverage must be per source or per account rather than per tenant.
- How source account ids relate to HubSpot companies (the identity rules for
  the M6 external references).
- How source product ids relate to catalogue keys (`externalRefs` contents).
- The source state vocabulary and its mapping to canonical states.
- Whether quantities, tiers or terms matter for eligibility.
- Which account attributes (segment, region, size) exist and where. Each one
  is added to the canonical account model only when a source supplies it.
- Juniper's actual products, families, relationships and conditions.

---

## Account merge and subscriptions

Decision (ADR 0017 §8): **subscriptions follow the surviving canonical
company, as the same source facts, inside the existing M6 merge
transaction.**

```
Before                         Merge A → B (M6, same system)          After
Company A ── S1 (sugar:…:1)    one tenant transaction:                Company A  state=merged, mergedInto=B
Company B ── S2 (sugar:…:2)    lock refs → lock canonical A,B →        Company B ── S1 (same row, same source ref)
                               repointRefs → participants:                       └─ S2
                               UPDATE subscriptions SET company=B     provenance: S1 merged [companyId], merge's cause
```

- **Hook.** The `CompanyMergeParticipant` port is defined by context and
  implemented by products. It is called by `ContextIngestionService.merge`
  right after `repointRefs` for a same-system loser. `ContextModule.register`
  **requires** `mergeParticipants`, and a test proves that both merge-capable
  compositions (worker, context CLI) register the subscription participant.
  There is no second merge process.
- **Repoint.** One set-based
  `UPDATE tenant_subscriptions SET company_id = :survivor WHERE company_id = :loser`.
  It touches the same rows, source references, states, dates and hashes, and
  creates or deletes nothing. Source uniqueness does not involve
  `company_id`, so no duplicates can appear.
- **Provenance.** One `tenant_context_changes` row per moved line:
  - `change_type = merged`, `changed_fields = [companyId]`;
  - the merge's cause, source and correlation id;
  - written by `INSERT … SELECT` in the same transaction.

  Each line's source provenance is kept.

- **Locking.**
  - The merge takes canonical-company advisory locks for the loser and the
    survivor (sorted), after its reference locks and before repointing.
  - Subscription ingestion takes the canonical-company lock (or locks, when a
    line moves between accounts) after its line lock, **before touching any
    subscription row**. It then re-resolves the merge lineage.
  - Result: an import never writes onto a company merged away during it, and
    no lock cycle is possible.
- **Idempotency.**
  - A replayed merge finds no lines on the loser: a no-op with no provenance.
  - Chains (B later into C) move the lines again.
  - A re-delivered source line for a merged-away account resolves to the
    survivor, with an unchanged hash (the hash covers source values only).
- **Cross-system refusal.** Nothing is merged and nothing moves.
- **Foreign keys.** The loser row is kept (never deleted), so RESTRICT FKs
  never block a merge.
- **Snapshots.** Snapshots recorded before a merge are immutable and keep the
  loser's id and their frozen facts. Readers reach them through the merge
  lineage. New evaluations of the loser id resolve to the survivor and return
  `requestedCompanyId` and `evaluatedCompanyId`.
- **Invariant.** A non-deleted subscription on a `merged` company is
  reported by `products:report`, runtime script 60 and a test, as a defect
  signal. Reads never silently re-home it.
- **Feasibility check (done).** The M6 merge already repoints external
  references, people and merge chains in one tenant transaction
  (`ContextStore.repointRefs`). The participant call and the canonical lock
  extend it, with no change to its semantics. Nothing found so far prevents
  this. If implementation finds otherwise, work stops and is reported first.

## Production edge cases (coverage map)

| Edge case                               | Where handled                                                                                           | Test                              |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------- |
| missing / null fields                   | optional fields stay absent, never defaulted; dates or state missing where needed → `unknown` (§4, §11) | unit + import validation          |
| duplicate subscription lines            | unique source reference; per-line lock; re-import is a no-op (§18)                                      | integration (concurrent)          |
| stale / out-of-order updates            | `decideApply` with source times (§18)                                                                   | unit + integration                |
| source tombstones                       | `presence: absent`; full-load tombstone pass; a tombstone is never resurrected by an older snapshot     | integration                       |
| partial imports                         | checkpoint stays incomplete; coverage unchanged; rows written so far are valid facts                    | failure test (killed import)      |
| future-dated subscriptions              | not owned before `startsAt` (§9)                                                                        | unit                              |
| expired + renewed overlap               | multiple lines; owned if any line qualifies at `asOf` (§9)                                              | unit + property                   |
| retired-but-owned products              | owned stays owned; retired is never whitespace (§13)                                                    | unit                              |
| product rename                          | same key, `renamedFrom` declared (K3)                                                                   | validation                        |
| product-key reuse                       | rejected (K1, K2, K4)                                                                                   | validation + mutation             |
| bundle nesting                          | iterative `includes` closure, acyclic by validation (§5, §6)                                            | unit + property                   |
| replacement chains                      | `replaces` is direct-only for supersession; cycles rejected                                             | unit + validation                 |
| rule cycles                             | `requires_cycle`, `supersession_cycle` (§6)                                                             | validation + mutation             |
| conflicting rules                       | `unsatisfiable_requirement`, `contradictory_relationship` (§6)                                          | validation                        |
| failed publication transaction          | one transaction; nothing persisted (§8)                                                                 | failure test                      |
| concurrent publication                  | per-tenant lock + unique version; `concurrent_publish` (§8)                                             | integration (concurrent)          |
| concurrent subscription ingestion       | per-line lock, single writer (§18)                                                                      | integration (concurrent)          |
| account merge after subscriptions exist | [account merge](#account-merge-and-subscriptions)                                                       | integration + race + mutation     |
| evaluation during model activation      | immutable versions selected by `effectiveFrom` (§8)                                                     | integration                       |
| source completeness unknown             | coverage gating → `unknown` (§11)                                                                       | integration + mutation            |
| large catalogue                         | size limits; validation is linear (DFS); model cached per immutable version (§6)                        | unit (limit) + runtime timing     |
| historical snapshots after data changes | frozen inputs and versions; reproduced exactly (§14–15)                                                 | integration                       |
| tenant isolation                        | forced RLS, tenant-scoped keys, cache key includes tenant (§17)                                         | integration + mutation            |
| privacy / retention                     | identifiers only; retention and erasure under technical debt #15/#17 (ADR 0017 §9, ADR 0018 §9)         | none in M7 (deferred, documented) |
| eventual UI needs                       | [future UI contract](#future-ui-contract)                                                               | service contract tests            |

## Future UI contract

M7 is backend and domain work: **no frontend code**. Its service and CLI
contracts must still be enough for the future production operator UI (M14)
to show the following **without reconstructing business logic from logs**:

| UI need                                   | Provided by                                                                              |
| ----------------------------------------- | ---------------------------------------------------------------------------------------- |
| product catalogue                         | `listProducts`, `getProduct` (model version in force)                                    |
| active / retired status                   | product `status`, availability window                                                    |
| product relationships                     | the model's relationships, keyed by product                                              |
| account-owned products                    | `whitespace(…).owned`, with the qualifying lines                                         |
| subscription state and dates              | `accountSubscriptions` (state, `startsAt`, `endsAt`, quantity, `recordState`)            |
| source / provenance                       | source reference and times on each line; the provenance trail (field names, cause, time) |
| eligible whitespace                       | `eligible_whitespace`                                                                    |
| ineligible whitespace                     | `ineligible_whitespace`, with failing checks                                             |
| unknown / missing-data states             | `unknown`, with reason codes (`ownership_not_loaded`, …)                                 |
| exact eligibility reasons                 | `checks[]`: check, rule id, outcome, reason code, facts                                  |
| product model version                     | `modelVersion`, `modelHash`, `evaluatorVersion` on every result                          |
| evaluation timestamp                      | `asOf`, `evaluatedAt`                                                                    |
| persisted historical eligibility evidence | snapshots by account (merge lineage included), product and time                          |

Contract tests assert that these fields exist and are populated. Reason codes
are stable identifiers, and display text is rendered from them.

## Human override of eligibility

**Recommendation: defer. M7 has no eligibility override.**

- **No consumer exists yet.** An override of _eligibility_ only matters when a
  candidate is created (M11) and reviewed (M14). The M14 workspace is where
  overrides, with actor, reason, time and expiry, get a real UI and audit
  flow.
- **The correct M7 fix for a wrong answer is the policy.** If eligibility is
  wrong, the rule or the facts are wrong. Publishing a corrected model version
  is explicit, versioned and auditable. An override instead would hide a
  standing policy error account by account.
- **It would blur facts, rules and decisions.** Distinguishing calculated
  eligibility from an administrative override, with expiry, adds a fourth
  persisted concept before anything uses it.

When it is needed (M11/M14), the design slot is clear: an override is a
separate, append-only record (`account × product`, decision, reason code,
actor, created and expiry times). It is applied **after** the calculated
result, and both are shown. The evaluator stays pure and never reads
overrides. This is recorded in ADR 0018.

## Relationship to later milestones

| Milestone | Uses M7 how                                                                                                                                                                                                                                                                                                                                                |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M8 / M9   | Connectors produce canonical subscription observations, through the single writer and mapping configuration; product external refs live in the model. Backfill completion = ownership coverage. No change to the catalogue, evaluator or schema contract (at most an added `ExternalSystem` value)                                                         |
| M10       | Signals are independent. Eligibility never reads signals, and signals never decide eligibility                                                                                                                                                                                                                                                             |
| M11       | Candidate generation = account + product + **eligible whitespace** + signals. A candidate requires status `eligible` (`unknown` → no candidate, or one flagged needs-data: M11 decides). Its evidence holds the **snapshot id**. M11 adds pursuit and cool-off suppression on top. Renewals and expansions of `owned` products are a separate M11 decision |
| M12       | Qualification judges how strong an eligible candidate is. It **never** re-evaluates product eligibility or reads product relationships. Enforced by a dependency rule (`qualification` may not import `products/eligibility`; it reads only the candidate's snapshot reference)                                                                            |
| M14       | Shows the eligibility explanation (rendered from reason codes) and hosts any future override                                                                                                                                                                                                                                                               |

## Second-customer portability test

Customer B uses Salesforce and Snowflake, with completely different products
and rules:

| Need                                                                 | Handled by                                                                                                    | Change required                                                             |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| B's catalogue, families, bundles, upgrades, exclusions, requirements | B's product model document                                                                                    | configuration only                                                          |
| "customers only" or "prospects only" products                        | `account_attribute` on `customer_status`                                                                      | configuration only                                                          |
| subscriptions from Salesforce Assets or a Snowflake table            | an M8-style connector producing canonical observations, plus mapping configuration                            | connector (expected)                                                        |
| `salesforce` / `snowflake` as source systems                         | add `ExternalSystem` values and widen the CHECKs                                                              | small additive migration (ADR 0012: generalise when a real system needs it) |
| B's status picklist                                                  | connector mapping to canonical states; unmapped → `unknown`                                                   | configuration                                                               |
| region or size eligibility                                           | add `region`/`size` to the canonical account model when a connector supplies them, then to the attribute list | additive code, once per attribute; it is canonical, not per customer        |
| B's account ids                                                      | M6-style external references on canonical companies                                                           | connector                                                                   |

**Result: portable.** Nothing in M7 depends on Juniper, HubSpot product
ownership or any one source. The two items that need code are both additive
and canonical: a new source system value, and a new canonical account
attribute. A design that required per-customer code was rejected in three
places:

- a free-form metadata bag with customer-specific checks;
- a hard-coded "trial counts as owned" rule, which is now the configurable
  `ownedStates`;
- ownership derived from a single source. Lines carry their source, and
  per-source authority is an additive option (§30).

## Explicitly out of scope

- the Sugar connector and the Gainsight CS/PX connectors;
- HubSpot product-ownership assumptions;
- the subscription-source discovery itself;
- signals;
- candidate opportunities, leads, qualification, prioritisation and routing;
- CRM writes;
- frontend;
- Jev, AI, statistical scoring and recommendations to users;
- renewal and expansion evaluation;
- cool-off and "already pursued" suppression (M11);
- eligibility overrides (deferred);
- an HTTP API;
- M8.

## Proposed files and modules

- `apps/api/src/modules/domain/`:
  - `product-model.ts`: the document schema and validated model;
  - `subscription.ts`;
  - `eligibility.ts`: result types, reason and check codes;
  - removal of `ProductOwnership` and `Company.products`.
- `apps/api/src/modules/products/`, a new module:
  - `application/`: catalogue service, ingestion, eligibility service;
  - `domain-logic/`: a pure validator, ownership derivation and the
    evaluator, with no I/O imports (enforced by a dependency rule);
  - `infrastructure/`: model store, subscription store, snapshot store;
  - `cli/`.
- `apps/api/prisma/`: the schema and two migrations, plus `rollback/` scripts.
- `apps/api/test/products/*.int.spec.ts`; unit specs next to the pure code;
  fixtures.
- `scripts/verify-runtime.d/60-product-eligibility.sh`; checks added to
  `verify-docker.sh`.
- `config/examples/`; the tenant template schema (`productModel`).
- Docs:
  - ADRs 0016–0018;
  - `docs/operations/product-eligibility.md`;
  - this record;
  - `docs/architecture.md` and the modules README;
  - technical debt.

## Implementation sequence

1. ADRs 0016–0018 (drafts). **Approval point** for the model, persistence and
   override decisions if the review changes them.
2. The pure core: the product-model schema, validator, ownership derivation
   and evaluator, with unit, property and invalid-configuration tests and the
   mutation proofs. No database yet.
3. Migrations, the schema guard, the `company_products` migration, removal of
   `Company.products`, and the down-scripts.
4. The catalogue service (publish, select, projection, cache) with
   integration tests.
5. The subscription single writer, CSV import, coverage checkpoint and
   provenance, with integration and failure tests.
6. The eligibility service (evaluate, whitespace, snapshots) with
   reproducibility and isolation tests.
7. CLI commands, runtime script 60, Docker checks and the operations guide.
8. The final gates: verify, runtime, Docker, fresh clone, CI, the milestone
   record, the PR, then stop for independent review.

## Rollback strategy

- **No runtime switch is needed.** M7 adds no background processing, and
  nothing calls the evaluator except the CLI.
- **Database:** development and staging use the tested down-scripts. They
  refuse data the M6 schema cannot hold. Production is forward-fix.
- **Product model:** publish a corrected version. Old versions stay, because
  they are the audit trail.

## Approved decisions

From the planning review of 2026-10-02:

- `fast-check` is added as a direct devDependency **during implementation**.
  It is not installed yet.
- Legacy `company_products` is dropped after safe migration into
  subscriptions.
- `Company.products` and `ownsProduct()` are removed.
- Product family is an attribute, not an entity.
- The immutable versioned product model is authoritative, and
  `tenant_products` is its transactional, read-only projection.
- Ownership is derived and never stored.
- Eligibility statuses are `eligible | ineligible | unknown`.
- Hybrid persistence: evaluate on demand, and persist frozen snapshots only
  when relied upon.
- Tenant-level coverage is accepted for M7. It is provisional until the
  discovery gate.
- No generic rule engine and no expression language.
- `requires` supports `anyOf` only. `allOf` needs a demonstrated requirement.

## Points where approval may still be needed

1. Accepting ADRs 0016–0018 (proposed) with the corrections.
2. Approving the plan for implementation.
3. Any change to the M6 merge beyond the participant hook and canonical lock.
   If implementation finds the merge transaction cannot host them safely, work
   stops and the exact reason is reported.
4. The PR and independent review before merge.

## Risks

| Risk                                                             | Mitigation                                                                                         |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| The rule set grows into a rules engine                           | A closed check-type list; a new type needs code, tests, an evaluator version bump and an ADR note  |
| Missing data is read as "eligible whitespace"                    | Coverage gating, `unknown` precedence and its mutation proof                                       |
| The discovery gate finds split authority across systems          | Lines carry their source; a per-source authority filter is additive (§30)                          |
| Juniper's rules need a type M7 lacks (e.g. quantity or term)     | Recorded as `tbc`; added in a later milestone with its own tests. M7 does not guess                |
| Removing `Company.products` breaks a hidden consumer             | Only the company repository and tests use it (checked); the upgrade migration test covers the data |
| Model documents get large                                        | Size limits in validation; models are cached per immutable version                                 |
| Historic `asOf` with current facts is mistaken for a true replay | Documented: true replay is from snapshots; `asOf` only selects the model version and date windows  |
