# ADR 0018: Eligibility and whitespace (Milestone 7)

- Status: accepted (M7 implementation, 2026-10-02; plan approved with
  changes the same day). "As built" notes at the end record where the
  implementation refines the plan.
- Date: 2026-10-02

## Context

Whitespace is not "the account does not own product X" (charter §7). The
platform must decide, deterministically and explainably, whether an account
may newly acquire a product, using the product model (ADR 0016) and the
subscription facts (ADR 0017).

Later milestones rely on the answer:

- M11 candidate generation;
- M12 qualification, which must not repeat it;
- the M14 operator UI.

## Decision

1. **A pure evaluator**:
   `evaluateEligibility({model, account, ownership, productKey, asOf})`.
   It does no I/O and reads no clock; `asOf` is always passed in.
2. **Checks.**
   - **Built-in**, always on, versioned with the evaluator:
     `product_available`, `not_already_owned` (directly or via `includes`),
     `not_superseded`, `not_excluded`, and one `requirements_met` per
     `requires`.
   - **Configured**: `account_attribute` conditions.
   - Each check yields `pass | fail | unknown | not_applicable`, a stable
     reason code, the rule id if configured, and the facts it read.
3. **Status** ∈ `eligible | ineligible | unknown`. Every check is always
   evaluated, in a fixed order, with no short-circuit. Any `fail` makes the
   result `ineligible`. Otherwise any `unknown` makes it `unknown`. Otherwise
   it is `eligible`.
   - `unknown` means the facts cannot decide. Its reasons are:
     - `ownership_not_loaded`;
     - `subscription_state_unknown`;
     - `subscription_state_conflict` (a cancelled or expired line whose term
       is still running: the source contradicts itself, so ownership is not
       decided either way);
     - `attribute_missing`.
   - `unknown` never defaults to eligible.
4. **Whitespace** groups every catalogue product into `owned`,
   `eligible_whitespace`, `ineligible_whitespace` and `unknown`, each with its
   reasons.
   - "Not already pursued" (open leads or opportunities) and cool-off belong
     to M11 suppression.
   - Renewal and expansion of owned products are a separate M11 decision.
   - There is no scoring.
5. **Persistence: hybrid.**
   - Evaluate on demand.
   - Persist an append-only, frozen **eligibility snapshot** only when a
     consumer relies on the result: CLI `--record` now, M11 candidates later.
   - A snapshot holds the complete result, the frozen input facts, the
     `modelVersion`/`modelHash`, `evaluatorVersion`, `factsHash`, `asOf`,
     `evaluatedAt`, purpose and correlation id.
   - Re-running the evaluator on a snapshot's inputs reproduces it exactly.
     Later fact or model changes never alter it.
   - After an account merge, a snapshot keeps its original company
     (ADR 0017).
6. **Explainability contract.** A result alone answers:
   - which account (requested and evaluated ids) and which product;
   - which facts;
   - which rules and versions;
   - what result, why, and when.

   Text for people is rendered from the reason codes; it is never stored as
   the explanation.

7. **Boundaries.**
   - **M10**: signals are independent of eligibility.
   - **M11**: a candidate requires `eligible` and cites the snapshot id.
   - **M12**: qualification judges the strength of an eligible candidate. It
     **never** re-evaluates eligibility or reads product relationships.
     Dependency rules stop qualification code from importing the products
     module or the eligibility/product-model domain files
     (`qualification-never-reevaluates-eligibility`), and the reverse
     (`eligibility-is-not-qualification`).
8. **No eligibility override in M7.** A wrong answer is fixed by publishing a
   corrected model version. If M11/M14 need overrides, they will be a separate
   append-only record (account × product, decision, reason, actor, time,
   expiry), applied after the calculated result and shown alongside it. The
   evaluator never reads overrides.
9. **Tenant deletion.** Snapshots are append-only (no UPDATE; DELETE refused
   by trigger in normal operation). Removing them together with a tenant is
   deferred to the platform's tenant-deletion and data-retention policy
   (technical debt #15, #17). That policy will define a privileged,
   audited purge path; M7 provides none.
10. **UI-ready contract.** The services return everything the future operator
    UI needs without reconstructing logic from logs:
    - catalogue, status and relationships;
    - owned products;
    - subscription state, dates and provenance;
    - each whitespace category;
    - exact reasons;
    - model version and evaluation time;
    - persisted snapshots.

## Consequences

- Eligibility is testable exhaustively without external systems, and each
  check has a mutation proof.
- M11 builds on stable, explainable, reproducible evidence. M12 cannot
  duplicate M7 logic.
- No decision table goes stale; snapshots exist only where they are needed.

## Alternatives considered

- **A boolean eligible flag.** Rejected: it hides missing data and gives no
  reasons.
- **Persisting every evaluation.** Rejected: stale rows, unbounded growth,
  and decisions mistaken for facts.
- **On-demand evaluation only.** Rejected: downstream evidence could not be
  reproduced once facts changed.

## As built (M7)

- **Checks.** `ownership_coverage` is the first built-in check (unknown with
  `ownership_not_loaded` until coverage is known), followed by
  `product_available`, `not_already_owned`, `not_superseded`, `not_excluded`,
  `requirements_met` (one per `requires`) and configured `account_attribute`
  checks. `EVALUATOR_VERSION = 1`. Whitespace classifies every product from
  one evaluation context (ownership derived once); the service loads the
  account, coverage and facts once per request (no N+1) and caches the
  indexed model per version.
- **Consistency.** `EligibilityService` reads model, account, coverage and
  facts in one `REPEATABLE READ` transaction, so a concurrent import or
  publish is seen entirely or not at all; the snapshot is inserted in the same
  transaction.
- **Snapshots.** `result` holds the checks and the frozen input
  (`account {companyId, customerStatus}`, `ownership` with the subscription
  facts, `asOf`), canonical JSON, ≤ 64 KiB (CHECK). Replay
  (`eligibility:replay`) re-evaluates the frozen input against the stored
  model version and reports `reproduced`, `evaluator_changed`,
  `model_hash_mismatch`, `facts_hash_mismatch` or `result_differs`; it never
  reads current subscriptions.
- **CLI.** `eligibility:evaluate --company --product [--as-of]
[--record --purpose <code> --execute]`, `eligibility:whitespace`,
  `eligibility:replay --snapshot`, `products:report` (exit 3 when the
  merged-company invariant is violated). `--company` takes a platform id or
  `system:objectType:id`.

## As built (M8)

- **`ownership_incomplete`** (ADR 0020 §15). The unknown-coverage ownership
  input carries an optional reason: absent = `ownership_not_loaded`
  (tenant-level, unchanged), `ownership_incomplete` = this account holds a
  line whose product cannot be known (an ownership gap of the connection
  authoritative for `subscription_lines`). Every product of such an account is
  `unknown` with that reason: no not-owned inference, no eligible whitespace.
  The reason is part of the frozen facts and of `factsHash` (a gap and "not
  loaded" never hash alike; existing `not_loaded` hashes are unchanged).
- **`EVALUATOR_VERSION = 2`.** Snapshots recorded by evaluator 1 replay as
  `evaluator_changed` and are never reinterpreted (integration-tested).
