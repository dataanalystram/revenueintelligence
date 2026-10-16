# ADR 0032: Commercial — price offers, contracts, entitlements, line commercial references and canonical 0.6 (Milestone 10F)

- Status: **Accepted (in review)** — implemented in PR #121 (`m10f-impl` → `integration`, draft; phases 1–3 done,
  V1–V34 and VM1–VM18 (+ VM7b, VM9b) recorded; independent review pending); record
  [M10F](../milestones/M10F-commercial.md)
- Date: 2026-10-16
- Plan: [M10F plan](../milestones/M10F-commercial-plan.md) (PR #120); owner instruction of 2026-10-14: the recommended
  `DEFAULT` answers Q1–Q28 apply unless overridden
- Builds on: ADR 0020 (versioned source mapping and authority), ADR 0024 (Chargebee reference adapter), ADR 0026
  (security foundation), ADR 0027 (canonical versioning and governance), ADR 0028 (generic source references),
  ADR 0029 (account hierarchy, affiliation), ADR 0030 (extension framework), ADR 0031 (account context, incl. the #90
  addendum on explicit-grant confidential reads)
- No SOC 2, GDPR, HIPAA, ISO 27001, PCI or legal-retention claim is made. Invoices and payments stay out of scope.

## Context

Before M10F the canonical model had products and subscription lines but nothing between them and the money: no price
or offer a line is sold at, no contract (agreement header) that groups lines and renews, amends or co-terms, and no
entitlement. E3 §4 / §4.1 / §4.2 / §13 / §14 define those entities, the line's Core `agreement_ref`, the line ↔
contract cardinality and the contract relationship matrix; E8 pressure-tests them against Chargebee (ItemPrice →
price offer; Subscription → contract header + `agreement_ref`), Salesforce and Stripe. The plan requires those
entities without inventing customer schema, with financial classification, explicit-grant confidential reads, the
usual gating by canonical version and module, structural invariants held by the database with race tests, and a hard
boundary so commercial data never feeds ownership or eligibility.

## Decision

1. **Schema (plan §3; migration `20270202120000_m10f_commercial`, no backfill).** `tenant_price_offers`,
   `tenant_contracts`, `tenant_entitlements` (platform UUID + generic source references, no natural key, Q5;
   `record_state = 'active'`, no merge lineage), and the additive line columns `agreement_ref_system` /
   `_object_type` / `_external_id` (all-or-none CHECK), `contract_id`, `price_offer_id`, `supersedes_line_id`. Every
   relation is a direct composite tenant FK (F2); forced RLS, tenant policy, tenant-id immutability, entity-index
   triggers, SELECT / INSERT / UPDATE only (no DELETE). CHECKs: currency shape `^[A-Z]{3}$`, period pair, pricing
   model, amounts ≥ 0, money pair, closed status codes, period order, quantity, no self link / self supersede. Authority
   connection columns `price_offer_connection_id`, `contract_connection_id`, `entitlement_connection_id`.
2. **Contract links are three self-FK columns, not a link table (Q6; refines M10 §2 `tenant_contract_links`).**
   `renews_contract_id`, `amends_contract_id`, `parent_contract_id`. E3 §14 fixes 0..1 per kind, which one column per
   kind makes structural; a link table would need a uniqueness rule per kind for the same guarantee.
3. **Structural invariants held by the database (plan §4).**
   - Contract graph acyclic over the **union** of the three kinds (Q7): `app_contract_graph_guard`, walk ceiling 64,
     serialised by the tenant advisory lock `('contract-graph', tenant)`; REPEATABLE READ / SERIALIZABLE refused.
   - Contract links same account (Q12): deferred constraint trigger on both ends, refusal `contract_link_cross_account`.
   - Line ↔ contract same account and line ↔ offer same product (Q10): deferred constraint triggers on both tables;
     offer `product_key` immutable once a line references it.
   - Line lineage (`supersedes_line_id`, Q11): self refused by CHECK, cycle refused by a trigger, same account.
   - **Line-lineage guard uses the advisory lock, not a row re-read (phase 2a deviation).** The phase-1
     `app_line_lineage_account_guard` re-read the predecessor `FOR SHARE`. The BEFORE lineage trigger waits on the
     `('line-lineage', tenant)` lock while holding its own row lock, so two crossing predecessor writes deadlocked
     (40P01) instead of resolving to `line_lineage_cycle`. The account guard now serialises on the same
     `('line-lineage', tenant)` advisory lock (and refuses REPEATABLE READ), like the contract-link account guard.
     The two-session race test proves the crossing writes resolve to exactly one `line_lineage_cycle`.
4. **Lock order and per-tenant contract-write serialisation (Q16).** In practice: identity locks first —
   `company-canonical` (every writer, the line step and the merge participant) and, for source writes, the
   source-reference triple lock — then `contract-graph` → `line-lineage` → contract rows → offer rows → line rows, rows
   by ascending id. **Every contract write takes `contract-graph`**, so contract writes of one tenant are serialised.
   This is simple and deadlock-free; it has not been measured under load (tech debt #98). The merge participant runs
   after the subscription merge participant has touched line rows; this is safe because every commercial writer takes
   the account lock first. Race tests: crossing links, crossing predecessors, concurrent header syncs (V34) and the
   V19 merge race with contract and line writes on the loser — no 40P01 in any of them.
5. **Canonical 0.6 and module `commercial` (plan §11).** 0.1–0.5 hashes reproduced from frozen `_0_5` lists (pinned
   0.6 hash `c266c16c…ad169f8`); 0.6 adds the three entity / change / reference / extension-target kinds, the
   mapping entities, the line targets and the three optional authority facts. 0.5 becomes `supported`. Module
   `commercial` is available at 0.6, disabled by default, `depends_on []`. Every commercial write needs adopted ≥ 0.6
   **and** the module; reads work whatever the gate (Q19 / Q20). **`agreement_ref` is Core** (Q2): written at ≥ 0.6
   without the module, never an identity, never a source-reference row, never creates a contract. Rollback 0.6 → 0.5
   with the module on is allowed: data kept and readable, writes refused, `modulesStranded: ['commercial']`, stored
   `agreement_ref` kept.
6. **Single writers (plan §5).** `PriceOfferWriter`, `ContractWriter` (contracts and their links),
   `EntitlementWriter` (E3 fields only), `CommercialLineReferenceStep` (the line's `agreement_ref`, `contract_id`,
   `price_offer_id`, `supersedes_line_id`), `CommercialMergeParticipant`. Operator writes (`canonical.human_entry`, one
   audit event each, codes / ids only) hold the attributes they set until `release` (Q17); a disagreeing source value
   is recorded as `commercial_human_override_disagrees`. A contract status change never touches its lines. A retired
   offer refuses new line assignments (writer rule, not a constraint). The commercial module depends on domain,
   tenancy and governance only; context imports commercial (the merge participant is injected after
   `AccountContextMergeParticipant`, before `ExtensionMergeParticipant`), and products never imports commercial (the
   line sync reaches the step through the `LineAfterWrite` port, wired from sources).
7. **Mapping (plan §6).** Blocks `priceOffer`, `contract`, `entitlement` (routed like M10E `accountContext`;
   `MappingEntitySchema` unchanged; value-map values checked against the frozen vocabularies at publish,
   `invalid_enum_map`) and line targets `subscription.agreement`, `subscription.priceOfferRef`,
   `subscription.supersedesRef`. Objects and offer / predecessor references need 0.6 **and** the module
   (`commercial_mappings_not_enabled`); `subscription.agreement` needs 0.6 only. Any M10F statement makes the version's
   `canonical_version_min` 0.6. Each object needs its authority fact (`authority_conflict`).
8. **Agreement confirmation shape (Q4).** `subscription.agreement` needs
   `confirmation: { semantics: 'agreement_header', confirmedBy, note? }` on the relationship entry. It is a new member
   of a union on the existing `confirmation` field, not a separate key, so every existing document parses to the same
   value and keeps its hash. An ordinary M8 `{ by, note }` confirmation does not count
   (`unconfirmed_consequential_entry`); conversely, consequential targets still need an M8 confirmation, which an
   agreement confirmation is not.
9. **Deal-grouping refusal (Q4, E3 §4.1).** Publish refuses `agreement_ref_deal_grouping` when the field name, the
   field's `relatesTo` or the header object matches the token list `opportunit`, `deal`, `pipeline`, `quote`, **or**
   the header object is mapped in the document as anything but `contract`; an unknown header object is
   `unknown_source_object`. A plain `relatesTo` is **not** refused outright: Chargebee
   `SubscriptionItems.subscription_id` relates to `Subscriptions`, the plan's own header example. The token list is a
   guardrail; the confirmation is the control.
10. **Sync (plan §6.3).** Order accounts → people → contexts → price offers → contracts → **second pass** → lines (+
    the line step through the port) → entitlements → custom objects, full and incremental; each commercial entity only
    with its authority fact (`<entity>_not_authoritative`, decided by the run as M10E D13 — not re-checked in the
    writers). Source-path gate refusals and record outcomes are counted on the run (codes only), not audited per
    record; operator refusals are audited (`@AuditFailures` / `ModuleGate` denial).
    - **Empty references never clear.** Empty or malformed line references (agreement, offer, predecessor) and empty
      contract link fields are "not stated"; clearing is operator-only (`--clear-target`, `--clear`), the M10E D14
      pattern. A mapped-but-empty agreement still hashes as `agreementRef: null`.
    - **`field_hash` (V4).** The line's `agreementRef` is hashed only when the mapping states `subscription.agreement`,
      so existing mappings keep identical hashes; the step, not `SubscriptionIngestionService`, stores it.
    - **Second-pass placement.** `agreement_ref → contract_id` resolution runs inline for lines of the same run; the
      second pass runs after contracts and before lines (plan §6.3 wording) for active lines with that
      `agreement_ref` and `contract_id IS NULL` (agreement-ref index), one transaction per line through the step. It
      also re-runs lines refused for a company mismatch; they stay refused (`contract_resolution_company_mismatch`).
    - **Unknown account → `contract_reference_unresolved`.** A contract or entitlement whose account reference does not
      resolve is rejected (`account_unknown`) with a `contract_reference_unresolved` conflict naming the entity kind; no
      dedicated conflict kind exists. An unresolved `agreement_ref` leaves `contract_id` NULL with the same conflict
      kind (entity kind subscription) and never creates a contract.
    - **`contract_duplicate_source` heuristic (Q14).** After each present contract write, other contracts of the same
      account with identical non-null `starts_at` / `ends_at` known only through a different source system open one
      conflict per pair (canonical ids sorted). Nothing is merged (no contract merge in M10F), and a pair that stops
      matching is not auto-resolved (tech debt #97).
    - A context same-account mismatch from a source is a skip (`contextSkipped: context_mismatch`), not a conflict.
11. **Contract `terminated` is the retirement (E3 §13).** There is no `retired` contract status; CLI `contract retire`
    is an operator write of `status: terminated`. No contract is ever deleted.
12. **Read model, confidential gate and CLI (plan §10, Q22 / Q23).** `CommercialReadModel` (price offers by product,
    contracts by account with incoming `linkedFrom` and `lineIds`, lines of a contract, entitlements by account;
    ≤ 500 keys, ≤ 1000 rows `truncated`, constant query count; capability `data.commercial.read`, policy v8; exactly
    one `commercial.read` audit event per call). Confidential columns (`list_amount_minor`, `renewal_date`,
    `total_value_minor`, `total_value_currency`; financial, ≥ confidential) are withheld by default.
    - **Withheld semantics.** `withheld` names only confidential attributes that hold a value (M10E behaviour); this
      reveals presence, not value — the trade-off accepted in #90.
    - **`includeConfidential` needs `data.commercial.read_confidential`** — grant-only (no actor kind), held through an
      explicit tenant-scoped `tenant_capability_grants` row by another operator (#90 path; `GRANTABLE_CAPABILITIES` and
      the DB CHECK name it). It is authorized for the read's own actor before any read (no existence oracle). Without
      the grant the read is **refused**, never redacted, with one `denied` event naming that capability. **Entitlement
      reads refuse the flag too** without the grant although no entitlement column is confidential: the flag never
      means something weaker on one entity (`releasedKeys: []` when granted).
    - **Released key naming.** The granted read's single event is recorded under the confidential capability with
      `includeConfidential` and `releasedKeys` that are **entity-qualified** (`contract.totalValueMinor`,
      `price_offer.listAmountMinor`; ≤ 50, `releasedKeysTruncated`), unlike M10E's bare keys, because one call can span
      entities.
    - CLI `commercial`: `price-offer list|show|write|retire`, `contract list|show [--lines]|write|link|unlink|retire`,
      `entitlement list|show|write`, `line assign-contract|assign-price-offer|set-supersedes`, `release`; exit 2 on
      refusals.
13. **Extension targets enabled (Q21).** `price_offer`, `contract`, `entitlement` are extension targets at 0.6
    (phase 1 had deferred the definitions). Registry publish / dry run, value writes, reference values and either
    relationship end naming a commercial kind need 0.6 + module `commercial`. `extension values show
--include-confidential` over a commercial target needs `data.commercial.read_confidential` (no bypass via
    `data.extension.read`); a read spanning account_context and commercial targets needs both grants and is recorded
    under the commercial capability with flags naming both.
14. **History (plan §9, Q18).** Change records with entity kinds `price_offer`, `contract`, `entitlement`
    (`subscription` for line references; change types unchanged). Value history on line `contract_id` /
    `price_offer_id`, offer status / list amount, contract status / dates / renewal date, entitlement status / dates.
    The manifest's declared `history: 'value_free'` (renewal date, list amount) is honoured by `decideValueHistory`:
    recorded without values whatever the policy; `isSensitiveForHistory` is unchanged.
15. **Integrity (plan §15; CLI only, #65).** Six read-only checks: `commercial_line_contract_company_mismatch`,
    `commercial_line_price_offer_product_mismatch`, `commercial_contract_link_cycle`,
    `commercial_contract_link_cross_account`, `commercial_line_lineage_cycle`, `commercial_agreement_contract_drift`.
    **Drift-check skip:** drift is checked only with the module enabled, ignores lines whose agreement resolves to
    another account's contract (that is the refused `contract_company_mismatch` case) and lines with an unreleased
    human change naming `contractId` (operator override, not drift).
16. **Ownership / eligibility boundary (Q27).** Dependency-cruiser rule
    `commercial-never-feeds-ownership-or-eligibility` (products and the eligibility / coverage / holding domain files
    import nothing commercial) plus a non-vacuous static scan for commercial table / column / Prisma names, plus
    snapshot equality of eligibility with and without offers and entitlements (V15).
17. **Chargebee TEST mapping (plan §6.5; fixture only).** ItemPrices → offers, Subscriptions → contract headers (seven
    status codes mapped), SubscriptionItems → lines with a confirmed `agreement_ref`. **`started_at` → `startsAt`:**
    the fake emits `started_at`, not the plan's `start_date` (both are declared by the adapter); swap if the live read
    shows `start_date` is the agreement start. **No Chargebee amount (Q9):** the adapter declares no item-price amount,
    so `list_amount_minor` stays NULL from Chargebee; declaring one is a separate adapter change with its own live gate
    (tech debt #96). The live TEST-site read (Q26) was **not run**: CI exposes no Chargebee secrets and none were added
    (tech debt #95; M9B precedent).
18. **Runtime proof (`91-commercial.sh`).** An operator CLI round trip against the real API / worker / PostgreSQL /
    Redis: adoption, module gate, writes, cycle / cross-account / secret-like refusals, confidential redaction /
    refusal / grant / release / revoke with audit, integrity (the six checks at 0 in the recorded run's `checks` JSON),
    app-role refusals, rollback 0.6 → 0.5 and back, and a probe scan of logs, CLI output / stderr and every persisted
    surface. **No sync leg:** a fake-Chargebee → mapping → worker sync leg was not added (it needs a second fake,
    worker and mapping-publish flow like `80-chargebee`); sync is covered by `commercial-sync.int.spec.ts` and
    `chargebee-commercial.int.spec.ts` (V28). **Metrics not scanned:** process metrics are in-process OpenTelemetry
    with no exporter endpoint in this stack, and the commercial CLI emits none; the scan covers logs, output and the
    persisted surfaces instead. Both gaps are tech debt #99.

## Consequences

- With the module disabled (the default) and no 0.6 target mapped, every existing flow is unchanged (V4: quality,
  lines incl. `field_hash`, change records and mapping hashes byte-identical against 0.5).
- Nothing is seeded or inferred: no offer, contract, entitlement, currency list, status map or source field. A tenant
  can roll back to 0.5 without losing data.
- Commercial data is informational: it never changes ownership, eligibility, coverage or holding (structural boundary
  plus snapshot equality).
- Contract writes of one tenant are serialised by `contract-graph` (#98).
- Inherited and extended: #15 (no commercial column is `restricted`), #65 (integrity CLI only), #71, #72, #79, #93
  (asserted grant ids apply to the new grant too), #94 (not widened: the financial columns are value-free).
- New tech debt #95–#99.
