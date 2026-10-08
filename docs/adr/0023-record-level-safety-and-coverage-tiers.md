# ADR 0023: Record-level safety, reviewed holding domains and structural coverage tiers (Milestone 9A)

- Status: accepted for implementation (M9A plan approved; implementation awaiting independent review)
- Date: 2026-10-08
- Plan: [M09A plan](../milestones/M09A-source-data-profiling-plan.md) §8–§11 (decisions A2–A5)
- Supersedes nothing; amends ADR 0017 (coverage), ADR 0018 (eligibility, evaluator v3) and ADR 0020 (holding filter, tombstones)

## Context

M8 could turn uncertainty into deletion or into a false fact:

- a full run tombstoned every active line whose key was not accepted in the
  run, including lines whose record **was read but rejected** (a value it
  could not interpret, an unreviewed filter value);
- the holding filter compared values literally; an empty value was "not a
  member", so `not_in` **admitted** empty or brand-new values as holdings;
- coverage was a boolean: absence from any completed full load meant
  `not_owned`, even when the load's completeness was only operator-declared
  (a CSV file) and not proven against the source.

## Decision

1. **Seen-but-rejected protection (§9).** A sync run keeps a protection set
   keyed exactly like `holdingIds` (`object|recordId`); a key is in at most one
   of the two (a later accepted occurrence moves it). The tombstone pass
   deletes a line only when its key is in **neither**. The decision per
   outcome is a pure function `protectionFor(code)` with **default
   protect** for unknown codes. Confident exclusions (`filtered_out` on a
   reviewed non-holding value, `non_subscription_product`) remain
   tombstonable. A protected record gives its account an ownership gap
   (attributed by its account reference, else by its existing line), so
   eligibility for that account is `unknown` (`ownership_incomplete`). A
   **value** rejection that cannot be attributed fails the run
   (`rejected_record_unattributable`) before any tombstone: no tombstones, no
   gap replacement, coverage unchanged. M8 reference-integrity skips with no
   existing line keep M8 handling. Record-level protection has **no
   threshold**.
2. **Reviewed holding-filter domain (§10).** Every holding filter carries a
   versioned `reviewedDomain` in the immutable mapping document: every value
   it can meet classified `holding` or `non_holding`, with an explicit empty
   entry (`value: null`). Publication requires it to cover every declared
   option and every observed value, to agree with the filter list, and to be
   reviewed against the mapping's snapshot. At runtime a value outside the
   domain is `unreviewed` under `in` and `not_in` alike: the record is
   protected and its account gets a gap; only a **new mapping version** can
   classify it (no acknowledgement path). Versions published before M9A are
   refused at run start (`mapping_requires_republish`, A3); classifications
   are never derived automatically.
3. **Structural coverage tier (§11, A2).** Coverage carries a tier derived
   **only** from the proof method of the run that established it:
   `count` (source count reconciliation) and `manifest` →
   `externally_grounded`; `operator_full_file` (CSV imports),
   `double_enumeration` and `success_marker` → `stable_snapshot`; nothing →
   `none`. The newest qualifying run decides (a weaker newer run lowers the
   tier); a stored tier is ignored and re-derived from the method; no
   configuration or acceptance can promote a tier. Adapter-declared stable
   methods need an operator acceptance on the authority version
   (`proof_acceptances`, which can only accept `stable_snapshot`); CSV imports
   need none. Pre-M9A runs are inferred without data rewrite (versioned →
   `count`, imports → `operator_full_file`).
4. **Downstream semantics.** `externally_grounded`: M7/M8 rules. Under
   `stable_snapshot`, positive ownership is unchanged but every `not_owned`
   becomes `unknown` (`coverage_tier_insufficient`); presence-based failures
   (already owned, excluded) still win; **no eligible whitespace** and, for
   M11+, presence-based opportunity generation only. The tier flows through
   coverage → `OwnershipInput` → `EligibilityResult.coverageTier` → the facts
   hash and frozen snapshots; consuming code switches exhaustively with a
   `never` check. `EVALUATOR_VERSION = 3`: older snapshots replay as
   `evaluator_changed`.
5. **Structural B guards (A4).** Before writes (once 20 records are seen) and
   before tombstones/coverage (whole run), a run fails when ≥ 50% of records
   miss the identity, account or product reference (`identity_field_absent`),
   or ≥ 50% of a consequential field's values are in a class
   (`type_incompatible`) or representation (`representation_incompatible`) the
   mapping cannot read. Thresholds are code constants; E and B classes can
   never be disabled or demoted by configuration.

## Consequences

- Intended behaviour changes (listed in the M9A record): CSV coverage no
  longer yields `not_owned` or whitespace; `not_in` no longer admits empty
  values; M8 test mappings carry a reviewed domain; evaluator version 3.
- A source with one unreadable record never loses that line; its account is
  honestly `unknown` until the record is readable again or a new mapping
  version classifies its value.
- The protection set lives in worker memory, like `holdingIds` (tech debt 31
  extended).
- A producer-verified manifest or row count is the path for a file source to
  reach `externally_grounded` later.
