# Milestone 10A1 — Security Foundation: implementation plan

- Status: **APPROVED PLAN (2026-10-09)**, with the owner's decisions Q1–Q6 and two amendments applied (§21).
  Implementation follows `BUILD → TEST → VERIFY → MUTATION PROOF → FRESH CLONE → RUNTIME → DOCKER → INDEPENDENT REVIEW
→ USER APPROVAL → MERGE` on a fresh branch from `main`. M10A2 does not start until M10A1 is independently reviewed,
  merged and closed.
- Parent: [M10 plan](M10-canonical-architecture-implementation-plan.md) (approved, revision 3). M10A1 is the first
  sub-milestone (F1). No canonical writer for a new entity is created before these primitives exist.
- Base: `main` after the merge of the approved M10 plan.
- Two acceptance sections apply: `Canonical / business correctness` (§17) and `Security & Data Governance` (§18).
- No SOC 2, GDPR, HIPAA or other compliance claim is made. M10A1 builds technical foundations only.

## 0. What exists today (`IMPLEMENTED TODAY`, from inspection)

| Area               | Fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tenant context     | `TenantContext` is issued only by the tenancy module (dependency-cruiser `tenant-context-issued-only-by-tenancy`). `TenantDatabase.transaction(ctx, work)` sets `app.current_tenant` with `set_config(…, true)` and re-checks that the tenant is `active`. Repositories receive `TenantTransaction`.                                                                                                                                                                                           |
| Writers            | Context: `ContextIngestionService` (single writer, enforced by `context-store-only-from-ingestion`). Products: `SubscriptionIngestionService`, `SubscriptionMergeParticipant`, product model / eligibility services. Sources: `SourcesRepository`, `ProfilesRepository`, `ProfilePurgeStore` (owner connection). Tenancy: tenant config repository, registry `setStatus`, `TenantDatabase.provision`, OAuth grant store, OAuth state service. Identity repositories. HubSpot webhook receipts. |
| Human entry points | CLIs only (`context`, `products`, `sources`, `provision-tenant`, `hubspot-*`); writes need `--execute`. `products` and `sources` take a free-form `--actor` (default `cli`) written to `published_by`, `captured_by`, `requested_by` or the purge `actor` (CHECK `^[A-Za-z0-9_.:@-]{1,128}$`). Other CLIs record no operator. **No authentication.**                                                                                                                                           |
| HTTP               | `POST /webhooks/hubspot` (HubSpot v3 signature), `GET /oauth/hubspot/callback` (signed single-use state), health. No auth guard; no user identity.                                                                                                                                                                                                                                                                                                                                             |
| Audit              | Only `tenant_source_profile_purges` (append-only; written by the owner-path purge).                                                                                                                                                                                                                                                                                                                                                                                                            |
| Immutability       | `app_refuse_change` triggers on product model versions, products (no delete), eligibility snapshots, schema snapshots, mapping versions, authority versions, profile purges; M9A profile triggers; tenant-id and slug immutability triggers on every tenant table.                                                                                                                                                                                                                             |
| Privileges         | `lip_app` holds SELECT/INSERT/UPDATE/DELETE on all tables by default privileges; table-specific REVOKEs exist only for `connector_kinds` and the M9A profile tables. The schema-guard check "app role can use every table" uses `has_table_privilege(…, 'SELECT,INSERT,UPDATE,DELETE')`, which is true if **any** privilege is held, so it does not assert an exact matrix. Exact privileges are asserted only for the M9A tables.                                                             |
| Functions          | One `SECURITY DEFINER` function (`app_route_oauth_account`, owned by `lip_webhook_router`); `app_jsonb_has_secret_like_key` (IMMUTABLE) already guards JSON configuration keys.                                                                                                                                                                                                                                                                                                                |
| Secrets            | `SecretProvider` (`get`/`find`), `Secret` redacts in `toString`/`toJSON`/`inspect`; key pattern `^[a-z0-9]+(?:[._-][a-z0-9]+)*$`; tenant credential keys `tenant.<slug>.<system>.<name>` with ownership CHECK on `tenant_credential_refs`; resolution through `TenantCredentialsService.resolve`.                                                                                                                                                                                              |
| Encryption         | `TokenCipher`: AES-256-GCM, `v1:` + base64url(iv \| ct \| tag), single key `platform.token_encryption_key`, HKDF labels `lip:token-encryption:v1` and `lip:oauth-state:v1`, AAD `tenant_oauth_tokens\|<tenant>\|<system>\|<column>`. No key identifier.                                                                                                                                                                                                                                        |
| Privacy            | M9A detectors (`piiHits`, `isSensitiveName`, `assertNoRawValues`) in `domain/profiling/privacy.ts`; logger redaction paths; tests asserting no values in logs, errors, profiles and runtime logs.                                                                                                                                                                                                                                                                                              |
| Observability      | `MetricsService` (`lip_*` counters, label pattern `^[a-z0-9_.:-]{1,64}$`), nestjs-pino logs, OTel, Sentry for errors only. No security events.                                                                                                                                                                                                                                                                                                                                                 |

## 1. Scope

In scope:

1. actor identity;
2. authorization model and permission catalogue;
3. audit-event model, including denied attempts;
4. append-only protections and an exact database privilege matrix;
5. field sensitivity and data-category model with a classification manifest;
6. retention-policy model (classes and product defaults) and the audit-event purge;
7. secret-detection and refusal boundaries;
8. connector credential handling (kept; hardened by tests and audit);
9. key-identified encryption and key rotation;
10. security-event model;
11. the data-subject map (control 17: hooks only).

Out of scope (later sub-milestones): canonical versioning, registries, module enablement, entity index, value
history (M10A2); user authentication and roles (M15); export/erasure features; purge jobs for tables other than audit
events; any new canonical entity.

## 2. Actor identity

- **Domain type** (pure, `domain/security/actor.ts`):

  ```
  Actor = { kind: ActorKind; id: ActorId; assurance: Assurance }
  ActorKind = 'source_sync' | 'system' | 'operator' | 'human_user' | 'ai'
  ActorId   = /^[A-Za-z0-9_.:@-]{1,128}$/   (same pattern as the existing CHECKs)
  Assurance = 'system' | 'asserted' | 'authenticated'
  ```

- **Kinds and how each is established:**

  | Kind          | Who                                                                                                                          | `id` example                               | Assurance                                                                   |
  | ------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------- |
  | `source_sync` | a sync or ingestion run (Sugar, Chargebee, HubSpot, CSV import executed by a run)                                            | `run:<run-id>` / `receipt:<id>`            | `system`                                                                    |
  | `system`      | platform processes: webhook intake, OAuth callback (proved by the signed state), job processors, migrations' backfill writes | `worker`, `api:oauth-callback`             | `system`                                                                    |
  | `operator`    | a person running a CLI                                                                                                       | the value of `--actor` / `LIP_OPERATOR_ID` | **`asserted`**: the platform cannot verify it (no authentication until M15) |
  | `human_user`  | reserved for authenticated users (M15)                                                                                       | —                                          | `authenticated`; **refused in M10A1** (no authenticator)                    |
  | `ai`          | reserved for AI-originated writes (later)                                                                                    | —                                          | refused in M10A1                                                            |

- **Honesty rule:** audit events and change records store `assurance`. An `asserted` operator id is never presented
  as authenticated.
- **CLI operator id (Q1, approved):** every CLI operation with `--execute` requires `--actor <id>` or
  `LIP_OPERATOR_ID`; without one it is refused (`operator_id_required`) before any write. Dry runs are exempt. Until
  authenticated operator identity exists (M15), the assurance is stored as `asserted`, never `authenticated`. The
  runtime scripts and docs are updated to pass `--actor`.
- **Where it is recorded:** every audit event; the change record (`actor_kind`, `actor_id`, `actor_assurance`,
  nullable for pre-M10A1 rows); the existing `published_by` / `captured_by` / `requested_by` / purge `actor` columns
  keep receiving the same id (no column change).

## 3. Authorization model

- **Capability-based, deny by default.** A write is allowed only if the actor's kind is granted the capability by a
  versioned, code-defined policy (`domain/security/policy.ts`, pure, `POLICY_VERSION = 1`).
- **`AuthorizedContext` token:**
  - `WriteAuthorizer.authorize(tenantCtx, actor, capability)` returns an `AuthorizedContext` (tenant context + actor +
    capability + correlation id) or throws `AuthorizationDeniedError`;
  - `AuthorizedContext` is a branded type with no public constructor. Only the security module can issue it
    (dependency-cruiser rule `authorized-context-issued-only-by-security`, mirroring
    `tenant-context-issued-only-by-tenancy`);
  - every privileged service method takes an `AuthorizedContext` **for its own capability** (typed per capability), so
    a missing or wrong authorization is a **compile error**, not only a runtime one.
- **Enforcement point:** the application-service entry of every write path in §0 (not the stores). Stores keep
  taking `TenantTransaction`.
- **Two complementary checks:**
  - compile time: the typed token;
  - test time: a static test lists every public write method of the services in §0 and asserts its first parameter is
    an `AuthorizedContext<…>`; a new write method without it fails the test.
- **Tenant binding:** the token carries the tenant context it was issued for. Services use it for
  `TenantDatabase.transaction`, so authorization and tenant scope cannot diverge.
- **Platform-level operations** (provisioning, tenant status): authorized for `operator` only, against the target
  tenant (the audit event is written to that tenant, §5).

## 4. Permission catalogue (closed)

| Capability                       | Covers (today's write paths)                                                                                                   | Granted to (policy v1)  |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------- |
| `canonical.source_sync`          | `ContextIngestionService.ingest / retireAbsentWithin / ingestMerge`; subscription ingestion from sync runs; merge participants | `source_sync`, `system` |
| `canonical.import`               | CSV subscription import / cancel                                                                                               | `operator`              |
| `processing.receipt`             | webhook receipt record / claim / finish / reset; checkpoints; dead-letter recording                                            | `system`                |
| `processing.dead_letter.resolve` | dead-letter discard / replay                                                                                                   | `operator`              |
| `config.tenant.provision`        | `provision-tenant`                                                                                                             | `operator`              |
| `config.tenant.status`           | tenant status change                                                                                                           | `operator`              |
| `config.integration`             | HubSpot configure; credential refs save/delete; flow settings; lead-source mappings                                            | `operator`              |
| `config.oauth.install`           | OAuth install state issue                                                                                                      | `operator`              |
| `config.oauth.grant`             | OAuth callback grant store/delete (signed state) and token refresh                                                             | `system`                |
| `config.policy`                  | policies, qualification config                                                                                                 | `operator`              |
| `config.product_model.publish`   | product model publish                                                                                                          | `operator`              |
| `config.source.connection`       | source connection configure / test                                                                                             | `operator`              |
| `config.source.schema`           | schema snapshot capture                                                                                                        | `operator`              |
| `config.mapping.publish`         | mapping version publish                                                                                                        | `operator`              |
| `config.authority.publish`       | authority version publish                                                                                                      | `operator`              |
| `data.sync.run`                  | starting a sync run (full / incremental)                                                                                       | `operator`, `system`    |
| `data.profile.run`               | profile run                                                                                                                    | `operator`, `system`    |
| `data.eligibility.record`        | recorded eligibility evaluation                                                                                                | `operator`              |
| `data.purge`                     | profile purge; audit-event purge                                                                                               | `operator`              |
| `security.key.rotate`            | re-encryption CLI                                                                                                              | `operator`              |
| `security.audit.read`            | audit CLI read                                                                                                                 | `operator`              |
| `canonical.human_entry`          | reserved (operator entry of canonical records, later sub-milestones)                                                           | none in v1              |

- `human_user` and `ai` hold no capability in policy v1.
- A2 adds `config.registry.publish`, `config.module.change`, `config.canonical.adopt`, `migration.execute`,
  `security.integrity.run` through a policy version bump.
- Reads remain governed by tenant isolation (RLS); only the audit read is capability-gated in M10A1.

## 5. Audit-event model

- **Table `tenant_audit_events`** (tenant-owned, forced RLS, `tenant_id` first in every key):

  | Column                                      | Type / rule                                                                                                                                                           |
  | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `tenant_id`                                 | uuid, NOT NULL                                                                                                                                                        |
  | `id`                                        | uuid, primary key `(tenant_id, id)`                                                                                                                                   |
  | `seq`                                       | bigint, per-tenant monotonic (assigned under a per-tenant advisory lock); unique `(tenant_id, seq)`                                                                   |
  | `occurred_at`                               | timestamptz, DB default `now()`                                                                                                                                       |
  | `actor_kind`, `actor_id`, `actor_assurance` | as §2; CHECKs on closed sets and the id pattern                                                                                                                       |
  | `capability`                                | closed set (§4) CHECK                                                                                                                                                 |
  | `action`                                    | closed set CHECK (e.g. `mapping.publish`, `tenant.provision`, `credential_ref.save`, `profile.purge`)                                                                 |
  | `outcome`                                   | `allowed` / `denied` / `failed`                                                                                                                                       |
  | `reason_code`                               | required for `denied` / `failed`; closed set (e.g. `capability_not_granted`, `actor_kind_not_supported`, `secret_like_value`, `stale_base_version`)                   |
  | `target_kind`, `target_ref`                 | identifier only (connection id, mapping version, product model version, run id); CHECK pattern                                                                        |
  | `correlation_id`                            | uuid linking the audit event with the change records and run records of the same operation                                                                            |
  | `policy_version`                            | integer                                                                                                                                                               |
  | `details`                                   | jsonb; validated by a closed per-action Zod schema (identifiers, codes, counts, hashes only); DB CHECKs: size ≤ 4 KB and `NOT app_jsonb_has_secret_like_key(details)` |
  | `prev_hash`, `hash`                         | tamper-evidence chain per tenant (Q2, §5.1); unique `(tenant_id, prev_hash)` and unique `(tenant_id, hash)`                                                           |

- **What is audited:** every operation that requires a capability in §4 except per-record ingestion (`canonical.source_sync`
  and `processing.receipt` are audited **per run / per receipt batch** via run start and finish, because each record
  already has a change record). Concretely: all `config.*`, `data.*`, `security.*`, `canonical.import`,
  `processing.dead_letter.resolve`, plus run start/finish for `data.sync.run` / `data.profile.run`.
- **Atomicity:** an `allowed` event is written **in the same transaction** as the change it describes. If the audit
  insert fails, the operation fails (fail closed).
- **Multi-transaction operations** (sync runs, profile runs): an `allowed` event at start and a `completed` /
  `failed` event at finish, linked by `correlation_id`.
- **No values:** `details` never carries source values, names, emails or secrets. The details schema per action is
  part of the code and reviewed.

### 5.1 Audit hash chain (Q2, approved; deliberately simple)

- **One linkage per tenant:** each event stores `prev_hash` (the previous event's `hash`, or the tenant's genesis
  value `0…0` (64 hex zeros) for the first event, or the purge anchor after a purge) and its own `hash`.
- **Deterministic canonical payload:** `hash = sha256_hex(prev_hash ‖ "\n" ‖ canonical_json(payload))`, where
  `payload` is the fixed field list (`tenant_id`, `id`, `seq`, `occurred_at` in UTC ISO-8601 with milliseconds,
  `actor_kind`, `actor_id`, `actor_assurance`, `capability`, `action`, `outcome`, `reason_code`, `target_kind`,
  `target_ref`, `correlation_id`, `policy_version`, `details`) and `canonical_json` sorts object keys recursively,
  uses no insignificant whitespace and represents absent values as `null`. `occurred_at` is set by the writer (not a DB
  default) so the hashed value equals the stored value.
- **Same transaction:** the writer takes `pg_advisory_xact_lock` on the tenant's audit scope, reads the latest
  `(seq, hash)`, computes the new event and inserts it, all inside the transaction that writes the audited change (or
  the denial transaction).
- **No fork possible, even if the lock were bypassed:** unique `(tenant_id, prev_hash)` means two events can never
  extend the same predecessor; unique `(tenant_id, seq)` keeps the order dense. A concurrent writer that loses the
  race waits on the lock; without the lock it would fail on the unique constraint rather than fork.
- **Verification:** `security audit-verify --tenant <slug>` (read-only) walks the chain from the genesis or anchor,
  recomputes every hash and reports the first broken link (codes and ids only).
- **No blockchain or ledger complexity:** no external anchoring, no Merkle trees, no signatures in M10A1.

## 6. Denied-attempt auditing

- A denial is decided **before** any business transaction starts.
- The denial event is written in **its own** tenant transaction (so it survives), then `AuthorizationDeniedError` is
  thrown. The CLI exits non-zero with the reason code.
- If the tenant cannot be resolved or is not active, there is no tenant to attach the event to: a security event is
  emitted instead (§13) and nothing is written.
- If writing the denial event fails, the denial still stands, and a `audit_write_failed` security event is emitted.
- Denials are rate-protected: repeated identical denials within one process minute are coalesced into one event with
  a count (prevents audit flooding by a looping caller).
- Failures after authorization (`failed`) are written in a separate transaction after the business transaction rolls
  back, with a reason code only.

## 7. Append-only protections

Every append-only table gets **both**:

1. **privileges:** `lip_app` has INSERT and SELECT only (REVOKE UPDATE, DELETE, TRUNCATE);
2. **trigger:** `app_refuse_change` on UPDATE/DELETE, which also stops the owner by accident (purge paths use an
   explicit, audited owner-only switch, as M9A does).

| Table                              | Today                  | M10A1                                                                                                                         |
| ---------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `tenant_audit_events` (new)        | —                      | INSERT/SELECT; trigger; purge only through the owner path with `lip.audit_purge = 'on'` and not in the app role (mirrors M9A) |
| `tenant_product_models`            | trigger                | + REVOKE UPDATE/DELETE/TRUNCATE                                                                                               |
| `tenant_eligibility_snapshots`     | trigger                | + REVOKE UPDATE/DELETE/TRUNCATE                                                                                               |
| `tenant_source_schema_snapshots`   | trigger                | + REVOKE UPDATE/DELETE/TRUNCATE                                                                                               |
| `tenant_source_mapping_versions`   | trigger                | + REVOKE UPDATE/DELETE/TRUNCATE                                                                                               |
| `tenant_source_authority_versions` | trigger                | + REVOKE UPDATE/DELETE/TRUNCATE                                                                                               |
| `tenant_products`                  | delete-refusal trigger | + REVOKE DELETE/TRUNCATE                                                                                                      |
| `tenant_context_changes`           | no protection          | INSERT/SELECT + trigger (Q4; inspection result below)                                                                         |
| M9A profile tables, purge table    | REVOKEs + triggers     | unchanged                                                                                                                     |

Each REVOKE is applied only after a code inspection shows no update/delete path for the app role, and is proved by
the full suites passing.

**Q4 inspection result for `tenant_context_changes` (2026-10-09, on `main` `d2285df`):**

- Application code: the only writes are inserts (`ContextStore.insertChange` in
  `context/infrastructure/context-store.ts`, `SubscriptionStore.insertChange` in
  `products/infrastructure/subscription.store.ts`). No service, merge participant, retirement or CLI path updates
  or deletes change records. Reads: `context-read-model.ts` (groupBy) and tests.
- Owner-only, dev/staging rollback paths (not application paths):
  - the M7 down-script deletes subscription change records while rolling M7 back;
  - one M8 rollback test sets up a refusal scenario with an owner `UPDATE … SET source_connection_id`.
  - Both run with the owner role and **after** the M10A1 down-script (down-scripts run newest first), which removes
    the trigger and restores the privileges first, so they are unaffected. The M8 test setup is adjusted only in its
    ordering (apply the M10A1 down-script before its setup statement); its assertion is unchanged.
- Conclusion: no legitimate update/delete path exists, so append-only semantics apply. If implementation finds one
  (for example a failing suite), work stops and it is reported instead of forcing append-only.

## 8. Database role and privilege matrix

| Role                        | Login | Purpose                        | Privileges after M10A1                                                                                                                                                                                                                  |
| --------------------------- | ----- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| owner (`lip` / Azure admin) | yes   | migrations; owner-path purges  | DDL; used only by `prisma migrate deploy`, the M9A profile purge and the M10A1 audit purge (both refuse if the session is in `lip_app`)                                                                                                 |
| `lip_app`                   | no    | application privileges         | **exact per-table matrix** (manifest `security/privilege-manifest.ts`): DML on mutable tables; INSERT/SELECT on append-only tables; SELECT on `connector_kinds`; nothing on `_prisma_migrations`; EXECUTE on the allow-listed functions |
| `lip_api` (runtime login)   | yes   | API, worker, CLI               | member of `lip_app` only; `NOSUPERUSER NOBYPASSRLS` (role guard unchanged)                                                                                                                                                              |
| `lip_webhook_router`        | no    | owns `app_route_oauth_account` | unchanged column-level grants                                                                                                                                                                                                           |

- **Schema-guard change:** the weak "can use every table" check is replaced by an **exact matrix assertion**: for every
  table and every privilege (`SELECT`, `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `REFERENCES`, `TRIGGER`), the app
  role's `has_table_privilege` equals the manifest. A new table without a manifest entry fails.
- **Owner-function allow-list:** the "exactly one SECURITY DEFINER function" assertion becomes an explicit allow-list
  (still one entry in M10A1; A2 adds the entity-index trigger functions deliberately).
- No new role, no new LOGIN, no `BYPASSRLS`, no new grant beyond DML on the new table.

## 9. Field sensitivity and data-category model

- **Vocabulary (F3):** sensitivity `public` / `internal` / `confidential` / `restricted` (exactly one); categories
  `personal`, `financial`, `communication`, `operational`, `commercial`, `security` (one or more). Floors as in the
  M10 plan §16.1. `personal` is never a sensitivity.
- **Classification manifest** (`security/classification-manifest.ts`, typed):
  - one entry per column of every table (except `_prisma_migrations`): `{ sensitivity, categories, kind, retentionClass, historyPolicy, subjectLink? }`;
  - `kind`: `identifier` / `reference` / `code` / `free_text` / `number` / `timestamp` / `json` / `ciphertext` /
    `hash`; drives where secret detection applies (§11);
  - `historyPolicy`: `full` / `value_free` / `none` (used from A2);
  - `subjectLink`: for control 17 (§14);
  - **`tbc` (Q6, approved):** a small explicit list is allowed. A `tbc` entry is treated operationally as
    `restricted`, and must carry a `reason` and an `owner` (who classifies it); the record lists every `tbc` entry. No
    unlisted column is allowed: a column with no manifest entry at all fails the guard.
- **Guard test:** reads `information_schema.columns` for all tables and asserts the manifest covers exactly the same
  columns (no missing, no stale entries), respects the floors (a `personal` column below `confidential` fails), and
  that every `tbc` entry has a reason and an owner.
- **Candidate revision:** E4 §2 sensitivity list updated to sensitivity + categories (documented candidate revision;
  stricter, not weaker).
- **Use in M10A1:** documentation, guard, secret-detection scope, retention class metadata, data-subject map. No read
  filtering yet (roles come in M15).

## 10. Retention-policy model

- **Retention classes** (code catalogue, `security/retention.ts`), each with a product default and an enforcement
  status:

  | Class                       | Product default                     | Enforced in M10A1                                                     |
  | --------------------------- | ----------------------------------- | --------------------------------------------------------------------- |
  | `security_audit`            | 365 days                            | class + purge mechanism built and tested; **execution disabled** (Q3) |
  | `operational_diagnostics`   | 90 days                             | metadata only; purge jobs per table later                             |
  | `rejected_candidate`        | ≤ 30 days                           | metadata only (table arrives in M10L)                                 |
  | `raw_rejected_value`        | disabled                            | structural: no column exists                                          |
  | `raw_communication_content` | disabled                            | structural: no column exists                                          |
  | `sensitive_value_history`   | disabled unless an approved policy  | metadata (value history arrives in M10A2)                             |
  | `canonical_lifecycle`       | entity lifecycle and history policy | not a TTL; records follow their lifecycle                             |
  | `profile_statistics`        | existing M9A retention              | unchanged (M9A purge)                                                 |
  | `configuration_version`     | kept while referenced               | not purged (immutable versions)                                       |

- `RetentionPolicyProvider` port returns platform defaults in M10A1; A2 makes it read the tenant data policy.
- The defaults are **product defaults, not SOC 2, GDPR, HIPAA or legal-retention claims.**
- **Audit purge (Q3, partial yes):**
  - the `security_audit` retention class (365-day product default) and the purge mechanism are implemented and tested;
  - **dry-run / report mode first:** `security audit-purge --tenant <slug>` (no `--execute`) reports how many events
    are older than the class period and the anchor that would result, and changes nothing;
  - **execution is disabled:** `--execute` is refused (`audit_purge_disabled`) unless the code-level switch
    `AUDIT_PURGE_EXECUTION_APPROVED` is true; it is `false` and stays `false` until the formal privacy/retention policy is
    approved (tech debt #15). Tests exercise the execution path through an explicit test-only override that the
    production configuration cannot set (refused when `NODE_ENV=production`);
  - no scheduled or automatic purge exists;
  - when enabled later: owner credentials (`MIGRATION_DATABASE_URL`), refused inside `lip_app`, deletes only events
    older than the class period, records the last purged `hash` as the new chain anchor, and writes one audit event
    (`audit.purge`, counts only).

## 11. Secret detection and refusal boundaries

- **Structural guarantee (primary):** secrets are never meant to be stored in canonical, configuration or extension
  columns. They live only in the `SecretProvider`; the database holds secret **names** (`tenant_credential_refs`) and
  ciphertext (`tenant_oauth_tokens`). The classification manifest has no column of category `security` with kind
  `free_text` that could hold credential material.
- **Detection (secondary, best-effort):** `domain/security/secret-like.ts`, pure:
  - explicit patterns only (decision Q5): PEM private-key blocks; JWT-shaped tokens; `Bearer` tokens;
    well-known vendor key prefixes (for example `AKIA…`, `sk_live_…`, `xox…`, `ghp_…`, HubSpot `pat-…`); URL
    credentials (`scheme://user:password@`); `password=` / `secret=` / `api_key=` key-value pairs;
  - no entropy heuristic for refusal (it would reject legitimate long identifiers); entropy may be counted as a metric
    only.
- **Where it applies:**
  - columns classified `kind = free_text` in the manifest (names, descriptions, reasons, purposes) on every write path;
  - JSON configuration (`config`, policies, flow and qualification documents, audit `details`): existing
    `app_jsonb_has_secret_like_key` key check stays, plus value pattern checks in the writer;
  - CLI arguments that are stored (`--reason`, `--purpose`, `--actor` is already pattern-constrained).
- **Where it does not apply:** identifier, reference, code, hash and ciphertext columns (they are pattern-constrained
  or opaque by design).
- **Behaviour on a hit:**
  - operator/config writes: the operation is refused (`secret_like_value`), audited as `denied`, no value logged;
  - source ingestion (amendment, approved): **never silently dropped**:
    - the affected **field** is rejected and held: the canonical value is not overwritten (the previous accepted
      value, if any, stays), and the rejection is recorded; if the field is required or identity-bearing, the
      **record** is rejected through the existing seen-but-rejected path (no tombstone, no reference retirement);
    - a safe reason code `secret_like_value` is recorded in the run's quality counters and rejection list, and a
      `secret_like_refused` security event is emitted;
    - source coordinates and identity are preserved (connection, object type, record id, field path);
    - the raw value is never persisted, and never appears in logs, metrics, audit details or diagnostics;
    - test S22 proves this end to end.
- **Tests never contain real secrets:** test fixtures build pattern-shaped strings at runtime (so repository secret
  scanners are not triggered and nothing real is ever used).

## 12. Connector credential handling

- Unchanged mechanism: name-only `tenant_credential_refs` with the ownership CHECK; `TenantCredentialsService.resolve`
  re-checks ownership; adapters receive a resolver, never a stored value.
- M10A1 adds:
  - audit events for credential-ref save/delete (`config.integration`);
  - security events for resolution failures (`credential_not_found`, `credential_not_owned`), codes only;
  - a test that no table (via the manifest) has a column that could hold a credential value, and that credential refs
    hold only names matching the key pattern;
  - a test that `Secret` values never reach logs, errors, audit `details` or metrics.
- **Rotation of connector credentials** needs no database change: rotate the value in the secret store; the ref
  (name) stays.
- Chargebee: only `TENANT_CBLIVE_CHARGEBEE_CHARGEBEE_API` and `TENANT_CBLIVE_CHARGEBEE_CHARGEBEE_NOCATALOG` are used for
  live verification; no write operation exists or is added.

## 13. Encryption: key id and rotation contract

- **Format v2:** `v2:<kid>:<base64url(iv ‖ ciphertext ‖ tag)>`; `kid` matches `^[a-z0-9-]{1,32}$`.
- **Keyring from the `SecretProvider`:**
  - `platform.token_encryption_key_id` (configuration, not secret): the current `kid`;
  - `platform.token_encryption_key.<kid>`: the 32-byte key for each `kid` (env `PLATFORM_TOKEN_ENCRYPTION_KEY_<KID>`);
  - backward compatibility: if no keyring is configured, the legacy `platform.token_encryption_key` is the current
    key under the fixed `kid` `legacy`.
- **Derivation:** HKDF-SHA256 with labels that include the `kid` (`lip:token-encryption:v2:<kid>`,
  `lip:oauth-state:v2:<kid>`). AAD unchanged.
- **Reading:** `v1:` → legacy key; `v2:<kid>:` → that key; unknown `kid` → `TokenKeyError` + security event.
- **Writing:** always `v2` with the current `kid`.
- **OAuth state HMAC:** signs with the current key; verifies with the current and previous keys (states are
  short-lived).
- **Rotation procedure:** add the new key → switch the current `kid` → CLI `security rekey --tenant <slug> [--execute]`
  re-encrypts rows still on old `kid`s in tenant transactions (audited, counts only) → `security key-usage` reports rows
  per `kid` → remove the old key only when its count is 0.
- **Database role password rotation:** unchanged (documented in `docs/operations/database-roles.md`).

## 14. Tenant isolation

- `tenant_audit_events`: forced RLS on `app_current_tenant()`, tenant-scoped keys, tenant-id immutability trigger;
  the schema guard covers it automatically.
- Denial and failure events are written only to the tenant the request was bound to; a request cannot write an event
  into another tenant (RLS `WITH CHECK`).
- `AuthorizedContext` binds the tenant; services cannot switch tenant after authorization.
- Adversarial tests: tenant B cannot read, insert into or purge tenant A's audit events; the purge path sets the
  tenant and RLS still applies.
- **Data-subject map** (hooks for future export/erasure): from the manifest's `subjectLink`, per table, which columns
  link a row to a Person or Account and the intended action (`export`, `erase`, `pseudonymise`, `retain`). A test
  asserts every table with a `personal` column has an entry. No export or erasure feature is built.

## 15. Security-event model

- **Closed catalogue** (`security/security-events.ts`): `authz_denied`, `audit_write_failed`, `secret_like_refused`,
  `credential_resolution_failed`, `token_key_unknown`, `token_decrypt_failed`, `oauth_state_invalid`,
  `webhook_signature_invalid`, `tenant_inactive_access`, `role_guard_refused`, `audit_purge_completed`,
  `key_rotation_completed`, `privilege_manifest_mismatch` (runtime check).
- **Shape:** `{ event, outcome, tenant (slug or none), actor_kind, capability?, reason_code, correlation_id }` —
  codes and identifiers only, never values.
- **Sinks:** structured pino log at `warn` (`security_event: true`) and the counter
  `lip_security_events_total{event, outcome}`; denials are also audit events (§6). Sentry stays errors-only.
- Existing signals (`webhook_signature_invalid`, OAuth state failures, role guard) are routed through the same
  emitter without changing their behaviour.

## 16. Migrations

One forward migration, `m10a1_security_foundation`:

1. `tenant_audit_events` (table, CHECKs, indexes `(tenant_id, occurred_at)`, `(tenant_id, correlation_id)`,
   `(tenant_id, seq)`), forced RLS + policy, tenant-id immutability trigger, `app_refuse_change` trigger with the
   owner-path purge switch, privileges INSERT/SELECT for `lip_app`.
2. Change record: `actor_kind`, `actor_id`, `actor_assurance` (nullable; CHECKs; existing rows stay NULL = pre-M10A1).
3. Privilege tightening (REVOKE only) per §7, each preceded by an inspection note in the record.
4. No data change, no backfill of invented actors.

- Down-script (dev/staging): refuses while any audit event exists; otherwise restores the exact previous schema and
  privileges. Tests: up, rerun, down-refusal, exact restore, re-apply.
- Prisma schema updated; the drift test stays green.

## 17. Acceptance — Canonical / business correctness

- Ingestion on the Sugar and Chargebee fakes produces **identical** canonical results before and after (regression).
- All M6–M9B suites pass unchanged.
- Every existing CLI command works with an operator actor (subject to Q1); dry runs unchanged.
- Webhook intake, OAuth callback and token refresh work, with `system` actors.
- Existing `v1` OAuth grants decrypt; new writes are `v2`.
- Change records written after M10A1 carry actor attribution.

## 18. Acceptance — Security & Data Governance

- Every privileged operation is authorized through `AuthorizedContext` and writes exactly one `allowed` audit event in
  its own transaction; every refusal writes one `denied` event.
- `human_user` and `ai` actors are refused.
- Audit events are immutable for the app role (privilege + trigger) and for the owner except through the audited purge.
- The privilege matrix equals the manifest exactly; append-only tables have no UPDATE/DELETE for `lip_app`.
- Every column is classified; floors hold; `tbc` columns listed.
- Secret-like values are refused at every listed boundary; no value appears in logs, errors, audit details or metrics.
- Key rotation works end to end (encrypt k1 → rotate → read k1 → rekey → read k2 → retire k1).
- Tenant isolation of audit events holds under adversarial tests.
- Security events are emitted for every catalogue entry exercised by tests, without values.
- No compliance claim appears in code, docs or the record.

## 19. Tests and mutation proofs

Tests (unit, integration with Testcontainers as the app role, runtime):

| #   | Test                                                                                                                                                                                                                                                                                                                                                                 | Level                      |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| S1  | policy: every capability × actor kind decision matches the table in §4                                                                                                                                                                                                                                                                                               | unit (exhaustive)          |
| S2  | every public write method of the listed services takes an `AuthorizedContext` (static)                                                                                                                                                                                                                                                                               | unit (static)              |
| S3  | allowed operation writes one audit event in the same transaction; rollback removes both                                                                                                                                                                                                                                                                              | integration                |
| S4  | denied operation writes one `denied` event and no business change; CLI exit code and reason                                                                                                                                                                                                                                                                          | integration                |
| S5  | audit write failure makes the operation fail (fail closed)                                                                                                                                                                                                                                                                                                           | integration                |
| S6  | audit `details` schema refuses values; DB CHECK refuses secret-like keys and > 4 KB                                                                                                                                                                                                                                                                                  | unit + integration         |
| S7  | audit append-only: app role UPDATE/DELETE/TRUNCATE → permission denied; owner UPDATE → trigger refusal                                                                                                                                                                                                                                                               | integration                |
| S8  | hash chain verifies; a tampered row (owner, test DB) is detected                                                                                                                                                                                                                                                                                                     | integration                |
| S9  | exact privilege matrix equals the manifest                                                                                                                                                                                                                                                                                                                           | integration (schema guard) |
| S10 | classification manifest covers exactly all columns; floors hold                                                                                                                                                                                                                                                                                                      | integration (schema guard) |
| S11 | secret-like detector: positive and negative corpora (identifiers, long ids, emails are not secrets)                                                                                                                                                                                                                                                                  | unit (property)            |
| S12 | secret-like refusal on config writes and stored CLI arguments; field rejection on ingestion                                                                                                                                                                                                                                                                          | integration                |
| S13 | no secret or value in logs, errors, audit details, metrics (extends existing assertions)                                                                                                                                                                                                                                                                             | unit + runtime             |
| S14 | token cipher v1 read, v2 write, unknown kid refusal, rotation + rekey + key-usage                                                                                                                                                                                                                                                                                    | unit + integration         |
| S15 | OAuth state signed with the new key verifies; old-key state verifies during overlap                                                                                                                                                                                                                                                                                  | unit                       |
| S16 | audit tenant isolation (read/insert/purge across tenants)                                                                                                                                                                                                                                                                                                            | integration (adversarial)  |
| S17 | audit purge: refuses in app role; removes only older than the class; anchor kept; purge audited                                                                                                                                                                                                                                                                      | integration                |
| S18 | data-subject map covers every table with `personal` columns                                                                                                                                                                                                                                                                                                          | unit                       |
| S19 | regression: identical canonical results on the fakes; M6–M9B suites unchanged                                                                                                                                                                                                                                                                                        | integration                |
| S20 | migration up / rerun / down-refusal / exact restore / re-apply                                                                                                                                                                                                                                                                                                       | integration                |
| S21 | runtime script `85-security.sh`: CLI denial → audit row, allowed publish → audit row, key rotation, security events in logs without values                                                                                                                                                                                                                           | runtime                    |
| S22 | ingestion of a secret-shaped field value (Sugar fake and Chargebee fake): field rejected and held (previous value kept), required field → record rejected via seen-but-rejected, reason code and source coordinates recorded, security event emitted, and a scan of every table, log line, metric label, audit detail and run diagnostic finds no trace of the value | integration                |
| S23 | audit hash chain concurrency: two simultaneous audited writes for the same tenant (two connections, released together) both succeed (serialized), `seq` is dense, the chain validates end to end with no fork; repeated 20 times                                                                                                                                     | integration                |
| S24 | `--execute` without `--actor` / `LIP_OPERATOR_ID` refused before any write; dry run without actor allowed; stored assurance is `asserted`                                                                                                                                                                                                                            | integration                |
| S25 | audit purge: report mode changes nothing; `--execute` refused while execution is not approved, including in production configuration                                                                                                                                                                                                                                 | integration                |

Mutation proofs (break → the named test fails for that reason → restore → green):

| #    | Mutation                                                                    | Must fail                                                |
| ---- | --------------------------------------------------------------------------- | -------------------------------------------------------- |
| SM1  | grant `canonical.import` to `source_sync` in the policy                     | S1                                                       |
| SM2  | a service write method takes `TenantContext` instead of `AuthorizedContext` | S2 (and typecheck)                                       |
| SM3  | skip the audit insert on an allowed operation                               | S3                                                       |
| SM4  | write the denial in the business transaction (rolled back)                  | S4                                                       |
| SM5  | swallow the audit insert error                                              | S5                                                       |
| SM6  | drop the audit immutability trigger                                         | S7                                                       |
| SM7  | `GRANT UPDATE ON tenant_audit_events TO lip_app`                            | S7, S9                                                   |
| SM8  | add an unclassified column / lower a `personal` column to `internal`        | S10                                                      |
| SM9  | disable one detector pattern (e.g. PEM)                                     | S11, S12                                                 |
| SM10 | decrypt ignoring the `kid` (always current key)                             | S14                                                      |
| SM11 | omit the hash of the previous event                                         | S8                                                       |
| SM12 | purge without the app-role refusal                                          | S17                                                      |
| SM13 | policy RLS on audit table relaxed to `true`                                 | S16                                                      |
| SM14 | remove the per-tenant advisory lock from the audit writer                   | S23 (a concurrent insert fails on the unique constraint) |
| SM15 | remove the lock **and** the unique `(tenant_id, prev_hash)` constraint      | S23 (fork) and S8 (verifier reports the broken link)     |
| SM16 | ingestion writes the secret-shaped value instead of rejecting it            | S22                                                      |
| SM17 | accept `--execute` without an operator id                                   | S24                                                      |
| SM18 | set the purge execution switch to `true` in production configuration        | S25                                                      |

## 20. Verification gates

- `pnpm verify` (format, lint, typecheck, dependency-cruiser incl. the new rule, unit, integration).
- `pnpm verify:runtime` with the new `85-security.sh` (and all existing scripts green).
- `pnpm verify:docker` (images unchanged apart from code; new env vars optional; no secrets baked in).
- Live: Chargebee TEST-site read-only regression with the two approved secrets, if available; otherwise recorded as not
  run. Live Sugar stays pending.
- Mutation proofs SM1–SM18 recorded with the failing test output.
- **Fresh-clone run** before reporting completion.
- Independent review (`review-milestone`), then PR, CI green, merge only on approval.
- Record `docs/milestones/M10A1-security-foundation.md` with evidence; ADR 0026 (security foundation: actors,
  capabilities, audit, classification, key ids).

## 21. Owner decisions (2026-10-09)

| #   | Decision                                                                                                                                                                                                            | Applied in                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| Q1  | YES: `--actor` or `LIP_OPERATOR_ID` required for every CLI `--execute`; dry runs exempt; assurance stored as `asserted`, never `authenticated`, until authenticated operator identity exists                        | §2, S24, SM17             |
| Q2  | YES: per-tenant audit hash chain, deliberately simple (one previous-hash linkage, deterministic canonical payload, same transaction, no ledger complexity), with proof that concurrent writes cannot fork           | §5.1, S8, S23, SM14, SM15 |
| Q3  | PARTIAL YES: retention class and purge mechanism implemented and tested, 365-day default supported, dry-run/report first; **execution disabled** until the formal privacy/retention policy is approved              | §10, S17, S25, SM18       |
| Q4  | YES, conditional on inspection: append-only via privilege restriction and trigger; stop and report if a legitimate update path exists. Inspection found none (§7)                                                   | §7                        |
| Q5  | YES: explicit secret patterns only; no entropy-based refusal                                                                                                                                                        | §11                       |
| Q6  | small `tbc` list allowed: treated as `restricted`; each entry has a reason and an owner; no unlisted column; the guard fails on a truly missing classification                                                      | §9, S10                   |
| A1  | Amendment: secret-looking ingestion values are never silently dropped; field/record rejected or held with a safe reason code and security event, source coordinates preserved, raw value never persisted or emitted | §11, S22, SM16            |
| A2  | Amendment: concurrency test for the audit hash chain (two simultaneous writes for one tenant; both succeed or serialize; chain validates with no fork)                                                              | §5.1, S23                 |

## 22. Open items (unchanged)

- tech debt #15 (privacy decision), #62, #63, #64;
- live Chargebee mutations M09/M10 not run;
- V6, V9, V10, V11;
- Chargebee incremental sync disabled;
- live Sugar verification pending.
