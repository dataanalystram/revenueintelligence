# M10A1 — Security Foundation (record)

- Status: **CLOSED on merge of this closure record.** Owner-approved and merged to `main` (PR #22, merge
  `8a26171`, reviewed head `651f444`); independent review `PASS WITH FINDINGS`; see [Closure](#closure). M10A2
  starts only after this record is merged, plan first.
- Plan: [M10A1 plan](M10A1-security-foundation-plan.md) (approved, PR #21, merge `08260fe`); owner decisions
  Q1–Q6, amendments A1 (ingestion) and A2 (chain concurrency)
- ADR: [0026 Security foundation](../adr/0026-security-foundation.md)
- Branch: `claude/blissful-mendel-urbh4r` from `main` `08260fe`
- These are engineering controls. **No SOC 2, GDPR, HIPAA or legal-retention claim is made.**

## Scope delivered

| Area                   | Delivered                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Actors and policy      | `SecurityActor` (5 kinds, assurance per kind), closed catalogue of 22 capabilities, pure deny-by-default policy v1 (`domain/security`)                                                                                                                                                                                                                                                                                                                                               |
| Authorized writes      | `WriteAuthorizer` → `AuthorizedContext<C>` (branded, runtime re-check); privileged service writes take it; worker and callback entry points (receipt processing, webhook intake, OAuth callback and token refresh, due reconciliations) authorize their own system or source-sync actor inside (S2 static test classifies every public method of 20 services); `PlatformAuthorization` for provisioning/status; dependency-cruiser rule `authorized-context-issued-only-by-security` |
| CLI operator identity  | `--actor` or `LIP_OPERATOR_ID` required for every `--execute` (Q1); dry runs exempt; refusal recorded as `denied` (`operator_id_required`); stored assurance `asserted`                                                                                                                                                                                                                                                                                                              |
| Audit trail            | `tenant_audit_events` + `tenant_audit_anchors`; per-tenant hash chain under an advisory lock, same READ COMMITTED transaction; unique `seq`/`prev_hash`/`hash`; denials in their own transaction, coalesced 60 s; fail closed; `security audit-verify`                                                                                                                                                                                                                               |
| Append-only            | app role INSERT/SELECT only on audit, change records (Q4), product models, eligibility snapshots, schema snapshots, mapping and authority versions; `tenant_products` no DELETE; triggers kept                                                                                                                                                                                                                                                                                       |
| Manifests and guards   | classification manifest (414 columns, 36 tables), privilege manifest (exact matrix), SECURITY DEFINER allow-list, data-subject map; schema guard asserts all three; runtime `PrivilegeManifestCheck` emits `privilege_manifest_mismatch`                                                                                                                                                                                                                                             |
| Secret-like values     | explicit patterns (Q5); configuration writes (policy, integration settings, qualification, lead-source mapping, source connection label/config, mapping and authority documents) refused, audited `denied` (`secret_like_value`), emitted                                                                                                                                                                                                                                            |
| Ingestion amendment A1 | secret-shaped free-text field held (previous value kept), run quality `secret_like_value` + `secret_like_held` coordinates (object, record id, field, pattern), `secret_like_refused` event; value never stored, logged or counted                                                                                                                                                                                                                                                   |
| Retention and purge    | retention classes and defaults (audit 365 days); `security audit-purge` reports; `--execute` refused (`audit_purge_disabled`) while `AUDIT_PURGE_EXECUTION_APPROVED = false` (Q3); mechanism tested through a test-only override refused in production                                                                                                                                                                                                                               |
| Token keys             | `v2:<kid>:` ciphertexts, `v1:` read with the legacy key, keyring from the `SecretProvider`, OAuth state verified with every key in the ring; `security rekey` / `security key-usage`                                                                                                                                                                                                                                                                                                 |
| Security events        | closed catalogue; `warn` log + `lip_security_events_total`; existing signals routed: webhook signature, OAuth state, inactive tenant, role guard                                                                                                                                                                                                                                                                                                                                     |
| Isolation default      | tenant transactions state READ COMMITTED explicitly (a REPEATABLE READ role default no longer applies)                                                                                                                                                                                                                                                                                                                                                                               |

## Migration

`20261201120000_m10a1_security_foundation` (+ down-script). Adds the two audit tables (forced RLS, tenant-scoped
keys, tenant-immutable and append-only triggers, value CHECKs), actor columns on `tenant_context_changes` (NULL =
before M10A1; no invented backfill), the REVOKEs above, and widens the token ciphertext CHECKs to accept
`v2:<kid>:`. The down-script refuses while audit events, anchors, actor-attributed change records or v2
ciphertexts exist; otherwise it restores the M9B schema exactly (tested, S20).

## Q4 inspection (append-only change records)

No application update/delete path exists for `tenant_context_changes` (inserts only: `ContextStore.insertChange`,
`SubscriptionStore.insertChange`). Owner-only rollback paths run after the M10A1 down-script. Append-only applied.

## `tbc` classifications (Q6)

Nine columns, one reason, treated as `restricted`. Owner: platform owner (Wigmore). Reason: operator ids are
free-form asserted identifiers (an email is allowed); whether they are personal data depends on the operator-id
convention, decided with authenticated identity (M15).

`tenant_audit_events.actor_id`, `tenant_audit_anchors.actor`, `tenant_context_changes.actor_id`,
`tenant_product_models.published_by`, `tenant_source_mapping_versions.published_by`,
`tenant_source_authority_versions.published_by`, `tenant_source_schema_snapshots.captured_by`,
`tenant_source_profile_runs.requested_by`, `tenant_source_profile_purges.actor`.

Personal columns (category `personal`, `confidential`, subject `person`/`erase`): `persons.primary_email`,
`additional_emails`, `first_name`, `last_name`, `job_title`, `roles`.

## Tests S1–S25

| #   | Where                                                                                                                                                                         |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | `domain/security/security.spec.ts` (exhaustive policy)                                                                                                                        |
| S2  | `tenancy/security/authorized-writes.spec.ts` (static, 20 services; "authorize inside" entry points are listed and covered by integration assertions, not by the static check) |
| S3  | `test/security/audit-trail.int.spec.ts` (one event; rollback removes both)                                                                                                    |
| S4  | same (policy denial, `human_user`, coalescing) + runtime 85 (CLI exit and reason)                                                                                             |
| S5  | same (insert failure fails the operation; REPEATABLE READ refused)                                                                                                            |
| S6  | same + migration test (DB CHECKs: secret keys, > 4 KB, operator ⇒ asserted)                                                                                                   |
| S7  | `security-operations.int.spec.ts` (app role) + migration test (owner meets the trigger)                                                                                       |
| S8  | `security-operations.int.spec.ts` (tamper detected; independent hash recomputation) + runtime 85                                                                              |
| S9  | schema guard: exact privilege matrix                                                                                                                                          |
| S10 | schema guard: classification covers every column; `manifests.spec.ts` floors and `tbc`                                                                                        |
| S11 | `security.spec.ts` (positive and negative corpora, built at runtime)                                                                                                          |
| S12 | `audit-trail.int.spec.ts` (config refusal → `denied`, never stored) + runtime 85                                                                                              |
| S13 | S22, S12, runtime 85 (no value in tables, logs, metrics, events, outputs)                                                                                                     |
| S14 | `token-cipher.spec.ts` + `security-operations.int.spec.ts` (k1 → rotate → read k1 → rekey → read k2 → retire k1; v1 row; unknown kid) + runtime 85                            |
| S15 | `token-cipher.spec.ts` (state signed with new key; old-key and pre-M10A1 states verify)                                                                                       |
| S16 | `audit-trail.int.spec.ts` (B cannot read/insert A's events; context binds the tenant)                                                                                         |
| S17 | `audit-trail.int.spec.ts` + `security-operations.int.spec.ts` (older only, anchor, audited, owner only)                                                                       |
| S18 | `manifests.spec.ts` (data-subject map)                                                                                                                                        |
| S19 | full integration suite (M6–M9B unchanged in behaviour) + live Chargebee regression                                                                                            |
| S20 | `migrations.int.spec.ts` "M10A1 security foundation migration"                                                                                                                |
| S21 | `scripts/verify-runtime.d/85-security.sh` (12 checks)                                                                                                                         |
| S22 | `test/security/secret-ingestion.int.spec.ts` (Sugar and Chargebee fakes)                                                                                                      |
| S23 | `security-operations.int.spec.ts` (2 concurrent writes × 20, dense seq, no fork, chain verifies)                                                                              |
| S24 | `security-operations.int.spec.ts` + runtime 85 + Docker                                                                                                                       |
| S25 | `security-operations.int.spec.ts` + runtime 85                                                                                                                                |

Security events exercised by tests: `authz_denied`, `secret_like_refused`, `token_key_unknown`,
`audit_chain_broken`, `key_rotation_completed`, `audit_purge_completed`, `oauth_state_invalid`,
`webhook_signature_invalid`, `tenant_inactive_access`, `role_guard_refused`, `privilege_manifest_mismatch`.
Emitted but not directly asserted: `audit_write_failed`, `credential_resolution_failed`, `token_decrypt_failed`.

## Mutation proofs (break → named test fails for that reason → restore → green)

Harness: one exact replacement, the named tests, `git checkout` restore (all restores verified clean).

| #    | Mutation                                                               | Failed (reason)                                                                                            |
| ---- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| SM1  | `canonical.import` granted to `source_sync`                            | S1 "pins the grants": `['operator','source_sync']` ≠ `['operator']`                                        |
| SM2  | `savePolicy` takes `TenantContext`                                     | S2: `TenantConfigService.savePolicy` `'TenantContext'` ≠ authorized pattern; typecheck TS2345 ×4           |
| SM3  | skip the audit insert                                                  | S3 "one event per write" (+3 dependent)                                                                    |
| SM4  | denial never reaches a committed transaction                           | S4 denial test: `[]` ≠ two denied events; coalescing test                                                  |
| SM5  | swallow the audit insert error                                         | S5: "promise resolved … instead of rejecting"                                                              |
| SM6  | drop the audit append-only trigger                                     | S20/S7: owner UPDATE "resolved … instead of rejecting"                                                     |
| SM7  | `GRANT UPDATE ON tenant_audit_events TO lip_app`                       | S9 privilege matrix ≠ manifest; S7 app-role UPDATE no longer "permission denied"                           |
| SM8  | (a) unclassified column added; (b) personal column lowered to internal | (a) S10 "columns without a classification"; (b) floors test                                                |
| SM9  | PEM pattern disabled                                                   | S11 "detects pem"                                                                                          |
| SM10 | decrypt ignores the `kid` (always current key)                         | S14 unit "a previous key stays readable"                                                                   |
| SM11 | hash omits the previous hash                                           | unit "hash covers every field"; S23 independent recomputation `seq 1` hash mismatch                        |
| SM12 | purge without the app-role refusal                                     | S17: expected "schema owner credentials", got "permission denied" (privilege still holds)                  |
| SM13 | audit RLS policy relaxed to `true`                                     | S16: B sees A's events (`1` ≠ `0`)                                                                         |
| SM14 | chain lock removed                                                     | S23: `['fulfilled','rejected']` (the losing insert fails on a unique key)                                  |
| SM15 | lock **and** unique `seq` + `prev_hash` removed                        | S23: fork — `seq` `[1,2,3,4,4,5,5,6,6,…]` not dense                                                        |
| SM16 | (a) hold disabled; (b) held value written anyway                       | S22: (a) quality lacks `secret_like_value`; (b) name changed to the value and table scan finds `companies` |
| SM17 | `--execute` accepted without an operator id                            | S24: "resolved AuthorizedContext instead of rejecting"                                                     |
| SM18 | `AUDIT_PURGE_EXECUTION_APPROVED = true`                                | S25: purge executed ("resolved { dryRun: false … }")                                                       |

Note on SM15: with only the lock and `(tenant_id, prev_hash)` removed, the `(tenant_id, seq)` key still refuses
the concurrent insert (as in SM14); the fork appears only when every chain key is removed, which is what SM15
records. Each key alone prevents a fork.

## Verification evidence

| Gate                  | Command                                                                                                                       | Result                                                                                                                                                                          |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deterministic suite   | `pnpm verify`                                                                                                                 | on `5dd1b5e`: format, lint, typecheck, dependency-cruiser clean; unit 959/959; integration 497/497                                                                              |
| Runtime               | `pnpm verify:runtime`                                                                                                         | on `5dd1b5e` (fresh clone): 175 passed, 0 failed (incl. 12 checks of `85-security.sh`)                                                                                          |
| Docker                | `LIP_DOCKERFILE=<sandbox Dockerfile> LIP_DOCKER_BUILD_ARGS="--network host --build-context ca=/root/.ccr" pnpm verify:docker` | on `5dd1b5e`: 29 passed, 0 failed (incl. the two M10A1 checks); sandbox Dockerfile differs only by the proxy CA                                                                 |
| Live Chargebee (TEST) | `CHARGEBEE_LIVE_SITE=… pnpm --filter @lip/api test:live test/live/chargebee-baseline.live.spec.ts`                            | 2 passed (4 owner-run replays skipped by design); see below                                                                                                                     |
| Fresh clone           | `git clone` → `pnpm install --frozen-lockfile && pnpm verify && pnpm verify:runtime`                                          | **`5dd1b5e`: green** — verify (959 unit, 497 integration, no dependency violations) and runtime 175/175, exit 0. Two earlier fresh-clone runs failed and were fixed (see below) |

Live regression (read-only, approved secrets only, sanitized): Key A connection `ok` (`v2:pc2`); profile
completed; full run completed with `double_enumeration` → `stable_snapshot` (passed), repeat run 0 changes;
18 live subscriptions, 21 active lines (identical to the post-M08 baseline); Key B `forbidden` /
`source_forbidden`, no change. Neither key appears in the report or the log (checked).

## Independent review and resolution

First review (read-only subagent, `08260fe..47d74f9`): **FAIL — changes required**, no blockers.

| Finding                                                                    | Resolution                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M1 `failed` events never written (plan §6)                                 | `@AuditFailures(action, targetKind)` on 34 privileged writes: a failure after authorization is written as `failed` in its own transaction (reason `stale_base_version` / `validation_failed` / `operation_failed`); refusals already recorded as `denied` are not duplicated. Failed sync/profile runs finish with outcome `failed`                                                                                                                                            |
| M2 `processing.receipt` and token refresh unenforced/unaudited             | webhook intake authorizes `system:api:webhook-intake` for `processing.receipt` and audits each tenant batch (`webhook.receipts.store`, counts) in the receipts' transaction; token refresh authorizes `system:oauth-refresh` for `config.oauth.grant` and audits `oauth.grant.refresh` (`rotated` only) in the grant's transaction. Receipt **processing** (claim/finish) stays covered per record by the change records and per batch by `context.receipts.process` (plan §5) |
| M3 secret-like refusal missing on product models and provisioning          | product model publish → `refuseSecretLike` (denied event); provisioning checks the tenant name and the template documents (no tenant trail yet: security event + refusal, nothing created)                                                                                                                                                                                                                                                                                     |
| M4 retirement change records without actor                                 | `retireAbsentWithin` takes the run's `AuthorizedContext<'canonical.source_sync'>`; contextMeta carries the actor; CB20 asserts the retirement change record's actor                                                                                                                                                                                                                                                                                                            |
| m1 profile-purge audit and `installUrl` audit not atomic with their change | **not changed** (documented): the profile purge runs on the owner connection and writes its own purge row in that transaction; the audit event follows it. `installUrl` issues a state (expiring, single-use) then audits                                                                                                                                                                                                                                                      |
| m2 purge did not verify the chain first                                    | the purge refuses a chain that does not verify (`audit_chain_broken`); the refused attempt is recorded as `failed`                                                                                                                                                                                                                                                                                                                                                             |
| m3 capability/action CHECKs were format regexes                            | closed-set CHECKs; the schema guard asserts they equal the code catalogues                                                                                                                                                                                                                                                                                                                                                                                                     |
| m4 A1 required/identity field branch                                       | **not applicable today**: the held fields (company name; person first/last name, job title) are nullable and not identity-bearing; identity values (ids, emails, domains) are pattern-constrained and not free text. Record-level rejection would use the existing seen-but-rejected path when a required free-text field exists                                                                                                                                               |
| m5 keys not scanned                                                        | secret-shaped keys are found and never echoed (`[key]` in paths); audit detail keys mirror the database secret-key rule                                                                                                                                                                                                                                                                                                                                                        |
| m6 coalescing map unbounded                                                | pruned beyond 1000 entries (expired windows dropped)                                                                                                                                                                                                                                                                                                                                                                                                                           |
| m7 `recordPlatform` did not assert                                         | asserts `PlatformAuthorization`                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| m8 evidence incomplete                                                     | full suites re-run after the fixes; fresh-clone result below                                                                                                                                                                                                                                                                                                                                                                                                                   |

Review-fix mutation proofs (each failed for the stated reason, restored clean):

| #    | Mutation                                   | Failed                                                   |
| ---- | ------------------------------------------ | -------------------------------------------------------- |
| RM1  | `@AuditFailures` removed from `savePolicy` | failed-event test: `[]` ≠ one `failed` event             |
| RM2a | webhook batch audit not written            | webhook receipts test: no `webhook.receipts.store` event |
| RM2b | refresh audit not written                  | rotated-refresh test: no `oauth.grant.refresh` event     |
| RM3a | product model not scanned                  | publish "resolved … instead of rejecting"                |
| RM3b | provisioning not scanned                   | provisioning "resolved … instead of rejecting"           |
| RM4  | retirement actor dropped                   | CB20: `actor_kind: null` ≠ `source_sync`                 |
| RMm2 | purge skips chain verification             | broken-chain purge "resolved … instead of rejecting"     |
| RMm3 | an action added in code only               | closed-set guard: 45 ≠ 46 actions                        |

Re-review (`47d74f9..258cc0e`): **PASS WITH FINDINGS** — M1–M4 confirmed fixed, no major or blocker. Follow-ups:

| Finding                                                                 | Resolution                                                                                                                                                                            |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| m-a stale tenant-config versions recorded as `operation_failed`         | `version_conflict` / `Concurrency…` map to `stale_base_version`; the integration test asserts the exact code (RMa: reverting the pattern fails it)                                    |
| m-b failed events extended a broken chain                               | `audit_chain_broken` is a refusal: nothing is appended to a chain that does not verify (test asserts no new row)                                                                      |
| m-c nested audited calls recorded twice                                 | only the outermost audited operation records the failure (AsyncLocalStorage); unit test                                                                                               |
| m-d plain evaluation recorded as a failed snapshot write                | `evaluate` records failures only with `options.record`; unit test of the condition                                                                                                    |
| m-e webhook intake now takes the tenant's chain lock per batch          | **accepted, documented**: fail closed by design (an audit failure returns 5xx and HubSpot retries); audit volume grows with webhook batches, latency shares the per-tenant chain lock |
| m-f purge verifies the chain before taking the lock, in another session | **accepted, documented**: the remaining window can only be used by the schema owner, who could bypass the triggers anyway                                                             |

Fresh-clone findings (why the mandatory run matters): the run on `ed61db1` failed `pnpm lint` (an `any`-typed
decorator argument; fixed in `aba2674`); the run on `aba2674` failed typecheck because a mutation-proof restore
(`git checkout` of the mutated file) had discarded uncommitted edits to `audit-failures.ts` before they were
committed. They were reapplied in `5dd1b5e`, and the mutation harness now refuses to run on a dirty tree. All
other mutation runs had been on clean, committed trees.

## Deviations and notes

- `PLATFORM_TOKEN_ENCRYPTION_PREVIOUS_KEY_IDS` (configuration) names the key ids kept readable after a rotation;
  the plan named the current-id and per-id key variables but not how previous ids are discovered.
- The purge deletes only a contiguous chain prefix entirely older than the cut-off (never a newer event with a
  skewed timestamp).
- Integration test fix (pre-existing latent flake): the Chargebee profile test searched for the bare string
  `1111`, which random UUIDs can contain; it now searches for the masked card number and the quoted last four.
- The REPEATABLE READ concurrency test now proves the role default is REPEATABLE READ on a raw connection and
  that tenant transactions run READ COMMITTED.

## Open items (unchanged)

tech debt #15 (privacy decision; purge execution stays disabled), #62, #63, #64; live Chargebee mutations
M09/M10 not run; V6, V9, V10, V11; Chargebee incremental sync disabled; live Sugar pending; authenticated operator
identity (M15).

## Closure

| Item                      | Value                                                                                                                                                                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner approval            | 2026-10-10: "M10A1 is approved for merge" for PR #22 at reviewed head `651f4449825409be3d55661850bbc35f8ff626fa`                                                                                                                      |
| Pre-merge checks          | head exactly `651f444…`; base `main` unchanged at `08260fe` (the PR's base, so the reviewed diff stood); CI green on that head; no reviews, review comments or issue comments                                                         |
| Merge                     | head-pinned merge (`sha=651f444…`, merge commit): **`8a26171321478e2a9d71047906f7be2f127e97dc`**                                                                                                                                      |
| CI on the reviewed head   | Lint, typecheck, boundaries, unit tests ✓; Integration tests (Testcontainers) ✓; Runtime verification ✓; Docker images build and start ✓                                                                                              |
| Final local verification  | `pnpm verify` on `5dd1b5e` (unit 959/959, integration 497/497, dependency-cruiser clean); fresh clone of `5dd1b5e` green (verify + runtime 175/175); `pnpm verify:docker` 29/29; `651f444` differs from `5dd1b5e` only in this record |
| Live (read-only)          | Chargebee TEST site baseline: 2 passed, identical to the post-M08 baseline; approved secrets only; no key in report or log                                                                                                            |
| Mutation proofs           | SM1–SM18, RM1–RM4, RMm2, RMm3, RMa: each failed for the stated reason and was restored clean                                                                                                                                          |
| No changes after approval | none: the merged tree is the reviewed head                                                                                                                                                                                            |

**Independent review result: `PASS WITH FINDINGS`.**

- **Major findings — all fixed** (first review: FAIL, four majors, no blocker; confirmed fixed by the re-review):
  - M1 `failed` audit events after authorization;
  - M2 webhook intake (`processing.receipt`) and token refresh (`config.oauth.grant`) authorized and audited;
  - M3 secret-like refusal on product models and provisioning;
  - M4 retirement change records carry the source-sync actor.
- **Minor findings fixed:** m2 (purge verifies the chain first), m3 (closed-set CHECKs), m5 (secret-like keys),
  m6 (bounded coalescing map), m7 (`recordPlatform` asserts), m8 (evidence completed), m-a (stale reason code),
  m-b (a broken chain is not extended), m-c (nested failures recorded once), m-d (only recording evaluations).
- **Minor findings accepted and documented (not changed):**
  - m1: the profile-purge audit event follows the owner-path purge transaction, and `installUrl` issues the
    (expiring, single-use) state before auditing it — neither is atomic with its change;
  - m4: the A1 "required or identity-bearing field → record rejected" branch is not applicable today (every held
    field is nullable and not identity-bearing);
  - m-e: webhook intake takes the tenant's audit-chain lock per batch (fail closed; audit volume grows with
    webhook batches);
  - m-f: the purge verifies the chain before taking the lock, in a separate session (usable only by the schema
    owner).

**Open limitations and tech debt (preserved, unchanged):**

- tech debt #15 — formal privacy/retention policy; audit purge **execution stays disabled**
  (`AUDIT_PURGE_EXECUTION_APPROVED = false`);
- tech debt #62, #63, #64;
- authenticated operator identity (M15) — operator assurance stays `asserted`; the nine operator-id columns stay
  `tbc` (restricted);
- live Chargebee mutations M09/M10 not run; V6, V9, V10, V11 open; Chargebee incremental sync disabled;
- live Sugar verification pending;
- security events `audit_write_failed`, `credential_resolution_failed`, `token_decrypt_failed` are emitted but not
  directly asserted by tests;
- no compliance (SOC 2, GDPR, HIPAA, legal-retention) claim is made.

**Next:** M10A2 — Canonical Versioning & Governance Foundation. A detailed implementation plan is returned for
owner approval before any schema or code change; nothing of M10A2 starts before this closure record is merged.
