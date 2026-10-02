# ADR 0017: Subscriptions, ownership and account merges (Milestone 7)

- Status: proposed (M7 plan approved with changes, 2026-10-02; becomes
  accepted with the M7 implementation)
- Date: 2026-10-02

## Context

Eligibility needs facts about what each account holds. The source of those
facts is **not yet known**: the pre-M8 Subscription Source Discovery gate
decides it, and the platform must not assume Sugar, Gainsight, billing, a
warehouse or HubSpot.

M1/M2 left an ownership model, `company_products` (a single row per company
and product, holding status and dates), embedded in the Company aggregate as
`Company.products` with an `ownsProduct()` helper. It has no source, no
history, no provenance and no room for several lines per product.

M6 canonical companies can be **merged** (ADR 0014):

- the loser becomes `record_state = merged` with `merged_into_id`;
- its external references, people and merge chain are repointed to the
  survivor in one transaction (`ContextStore.repointRefs`);
- canonical rows are never deleted.

## Decision

1. **A subscription is one source line**: an account holds a product. It is
   stored in `tenant_subscriptions` with:
   - a platform UUID;
   - the canonical company and product key;
   - a canonical `state` (`active` | `trial` | `expired` | `cancelled` |
     `unknown`);
   - optional `startsAt`, `endsAt` and `quantity`;
   - a unique source reference (`source_system`, `source_object_type`,
     `source_record_id`);
   - a tombstone (`record_state`, `deleted_at`), source and observed times,
     a field hash, first/last seen, and a link to its last provenance row.
2. **Ownership is derived, never stored.** A product is owned at `asOf` when
   a non-deleted line for it meets all three conditions: its state is in the
   model's `ownedStates`, `startsAt` ≤ `asOf` (or is absent), and `endsAt` >
   `asOf` (or is absent). Owned products are then closed over `includes`.
   Several lines can coexist: renewals, overlapping expired and renewed
   terms, a trial then a paid line. The product is owned if any line
   qualifies. A future-dated line is not owned yet.
3. **One writer**: `SubscriptionIngestionService.ingest`, enforced by a
   dependency rule. It has the M6 guarantees:
   - one tenant transaction and a per-line advisory lock;
   - `decideApply`: newer source time wins, stale updates are ignored, an old
     snapshot cannot resurrect a tombstone, and an unchanged hash is a no-op;
   - provenance (`tenant_context_changes`, `entity_kind = subscription`,
     field names only) in the same transaction.

   The **field hash covers source-provided values only**: the source account
   and product identifiers, never the resolved canonical company. Canonical
   reassignment (8) therefore never makes a re-delivered line look changed.

4. **The canonical observation contract** (what any source maps into):
   - `source {system, objectType, recordId}`;
   - `companyRef`, resolved through M6 external references and merge lineage;
     an unresolved account means the line is rejected as `unknown_account`;
   - `productRef`, resolved through the model's `externalRefs` or used as a
     key; an unknown product is rejected as `unknown_product`;
   - `state`, mapped by connector configuration; an unmapped value is
     `unknown`;
   - dates, quantity, `sourceUpdatedAt`, `observedAt`;
   - `presence` (`present` | `absent`).

   Duplicate lines are not possible, because the source reference is unique.
   Missing or null optional fields stay absent and are never defaulted.

5. **Ownership coverage.** Ownership is _known_ for a tenant only after a
   **full** load has completed (`tenant_sync_checkpoints`,
   `kind = subscription`, `status = completed`). Until then every evaluation
   is `unknown` (`ownership_not_loaded`). A partial or failed load leaves
   coverage unchanged. A full load tombstones that source's lines it did not
   see. Coverage is per tenant, and this is **provisional until the discovery
   gate**, which may require coverage per source or per account.
6. **Input before M8**: a CSV import through the admin CLI (dry run by
   default) and generic fixtures. There is no fake connector. Import cause is
   always `import`, so imports cannot pass for connector data.
7. **Legacy migration**: `company_products` rows become subscriptions:
   - `source_system = import`, `source_object_type = legacy_company_product`;
   - `churned` becomes `cancelled`;
   - each with a provenance row.

   The table is then dropped. `Company.products`, `ProductOwnership`,
   `OwnershipStatus` and `ownsProduct()` are removed.

8. **Account merge: subscriptions follow the canonical account, as the same
   source facts.**
   - **Where.** Inside the existing M6 merge transaction
     (`ContextIngestionService.merge`), at the point where `repointRefs` moves
     a same-system loser to the survivor. A **merge participant hook** runs
     there: `onCompanyMerged(tx, {loserId, survivorId, mergeChange})`. Context
     defines the port. The products module implements it, so only the
     subscription module writes subscriptions. `ContextModule.register`
     **requires** a `mergeParticipants` list. Both compositions that can run
     a merge (worker, context CLI) must pass the subscription participant,
     and a test enforces it. There is **no separate "subscription merge"
     process**.
   - **What.** One set-based
     `UPDATE tenant_subscriptions SET company_id = survivor WHERE company_id = loser`.
     It is the **same rows**, with the same source references, states, dates
     and hashes. No synthetic rows are created, nothing is deleted, and
     source-line uniqueness is untouched (it never involved `company_id`).
     The survivor may then hold several lines for one product. That is the
     truth, and ownership derivation (2) handles it.
   - **Provenance.** One `tenant_context_changes` row per moved subscription,
     written set-based in the same transaction:
     - `change_type = merged`, `changed_fields = [companyId]`;
     - the **merge's** cause, source reference and correlation id;
     - the subscription's own source provenance is unchanged.
   - **Locking (no corruption, no deadlock).** Both paths take a
     **canonical-company advisory lock**
     (`lockKey(tx, 'company', <canonical id>)`):
     - The merge takes it for the loser and the survivor (sorted by id),
       after its existing reference locks and before repointing.
     - Subscription ingestion takes it after its line lock and **before
       touching any subscription row**: for the resolved company, and also
       for the line's current company when the source moves a line to
       another account (both sorted). It then re-resolves the company and
       follows the merge lineage. If the company was merged meanwhile, it
       writes to the survivor.
     - So an import can never write onto a company merged away during it.
       Because ingestion holds no subscription row lock while it waits for a
       company lock, the merge's UPDATE never waits on it: no lock cycle.
   - **Replay and idempotency.** A replayed or duplicate merge finds no rows
     left on the loser. That is a no-op, with no provenance row. A later
     merge of the survivor into a third company moves the lines again (merge
     chains). A re-delivered source line for a merged-away account resolves
     to the survivor and is unchanged (3).
   - **Cross-system merge refusal.** When M6 records a `merge_across_systems`
     conflict and merges nothing, subscriptions are untouched.
   - **Foreign keys never block a merge.** The loser row is kept (`merged`,
     never deleted), so `RESTRICT` FKs from subscriptions and snapshots stay
     valid. Deleting a company with subscriptions stays refused, as with
     people.
   - **Eligibility snapshots recorded before a merge stay immutable.** They
     keep the loser's `company_id` and their frozen inputs: what was true
     when recorded. Readers find them through the merge lineage (snapshots of
     companies merged into X). New evaluations of a merged-away id resolve to
     the survivor and report both ids (`requestedCompanyId`,
     `evaluatedCompanyId`).
   - **Safety net (detection, not repair).** An invariant check flags any
     non-deleted subscription on a `merged` company, in `products:report`, in
     runtime verification and in an integration test. It is a defect signal,
     never silent re-homing at read time.

   **Feasibility.** The M6 merge already repoints dependants (references,
   people, chains) in one tenant transaction. Adding the participant call and
   the canonical lock is an extension, not a redesign. Large repoints are one
   set-based UPDATE and INSERT … SELECT within the existing transaction
   timeout.

9. **Privacy and retention.** Subscriptions, their provenance and import
   records hold business identifiers, not personal data. Their retention, and
   any erasure, will fall under the platform-wide privacy and data-retention
   policy tracked in technical debt #15 (and #17). M7 implements no GDPR
   erasure.

## Consequences

- Connectors (M8/M9) add an adapter and mapping configuration only. The
  catalogue, evaluator, writer and merge behaviour stay unchanged.
- Whitespace is never inferred from missing data (coverage gating).
- An account merge moves facts atomically, with provenance, and never invents,
  duplicates or loses them.
- Context gains one small port, and M6's merge takes one more lock.

## Alternatives considered

- **Resolve merge lineage at read time instead of repointing.** Rejected as
  the primary mechanism: every reader would have to remember lineage, and a
  merged company would keep "owning" products. It is kept only as a
  detect-only invariant.
- **Copy subscriptions to the survivor.** Rejected: it invents facts and
  breaks source uniqueness.
- **A separate subscription-merge job.** Rejected: a second process with a
  window in which ownership is wrong.
- **Store ownership per account and product.** Rejected: it duplicates
  derived state and goes stale.
