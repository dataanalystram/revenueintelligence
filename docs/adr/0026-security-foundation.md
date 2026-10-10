# ADR 0026: Security foundation — authorized writes, hash-chained audit, governance manifests, key ids (Milestone 10A1)

- Status: **accepted and implemented — M10A1 CLOSED on merge of its closure record** (PR #22, merge `8a26171`,
  reviewed head `651f444`; independent review `PASS WITH FINDINGS`)
- Date: 2026-10-09
- Plan: [M10A1 plan](../milestones/M10A1-security-foundation-plan.md) (approved, PR #21, merge `08260fe`),
  owner decisions Q1–Q6 and the ingestion amendment A1
- Amends: ADR 0008 (append-only privileges for the app role; explicit READ COMMITTED tenant transactions),
  ADR 0010 (token ciphertext format v2 with key ids; OAuth state verified against the keyring)

## Context

Before M10A1 every service write trusted its caller: there was no actor, no authorization decision and no
audit trail beyond free-text `actor` columns on a few version tables. The app role could update or delete
rows of tables that were meant to be immutable (protected only by triggers), the schema guard asserted
"some privilege" instead of an exact matrix, columns had no recorded sensitivity, and the token cipher had no
key identifier, so a key could not be rotated without downtime.

## Decision

1. **Actors and policy.** Every write names a `SecurityActor` (`source_sync`, `system`, `operator`;
   `human_user` and `ai` exist and hold nothing in policy v1). A closed capability catalogue (22 entries) and
   a pure, deny-by-default policy decide. CLI operators are identified by `--actor` or `LIP_OPERATOR_ID`,
   required for every `--execute` (Q1) and stored with assurance `asserted`, never `authenticated`.
2. **Authorized context.** `WriteAuthorizer` is the only issuer of `AuthorizedContext<C>` (a branded class
   with a module-private token, re-checked at runtime). Every privileged service write takes the context typed
   for its capability, so a missing authorization does not compile; a static test (S2) keeps the list complete.
   A dependency-cruiser rule forbids issuing contexts outside the security code.
3. **Audit trail.** `tenant_audit_events`: identifiers, codes and counts only (details ≤ 4 KB, no secret-like
   keys or values), forced RLS, append-only by privilege **and** trigger. Each tenant's events form a hash
   chain (`sha256(prev_hash ‖ canonical payload)`), appended under a per-tenant advisory lock in the same
   READ COMMITTED transaction as the change; unique `(tenant_id, seq)`, `(tenant_id, prev_hash)` and
   `(tenant_id, hash)` make a fork impossible even if the lock were bypassed (Q2). Denials are written in their
   own transaction (coalesced within a minute); a failure after authorization is written as `failed` in its
   own transaction (reason code only); an audit failure fails the operation (fail closed).
   `security audit-verify` recomputes the chain.
4. **Append-only tables.** `lip_app` holds INSERT/SELECT only on the audit, change-record (Q4: inspection found
   no update/delete path) and immutable version/snapshot tables; triggers remain behind the privileges. The
   schema guard asserts the exact per-table privilege matrix from a manifest and an allow-list of SECURITY
   DEFINER functions.
5. **Governance manifests.** Every column of every table has a classification (sensitivity + categories,
   kind, retention class, history policy, subject link); `tbc` entries carry a reason and an owner and count as
   `restricted` (Q6). The schema guard fails on an unclassified or stale column. The data-subject map is
   derived from the manifest (no export/erasure feature yet). E4's sensitivity list is revised accordingly
   (candidate revision R1).
6. **Secret-like values.** Explicit patterns only, no entropy heuristics (Q5). Configuration writes carrying
   a secret-like value are refused, audited as `denied` (`secret_like_value`) and emitted as a security event.
   Source ingestion never drops silently (A1): the free-text field is held (previous value kept), counted under
   `secret_like_value` with its source coordinates in the run quality, and emitted; the value is never stored,
   logged or counted.
7. **Retention and purge.** Retention classes with product defaults (security audit 365 days). The audit purge
   exists and is tested (owner credentials only, contiguous prefix older than the cut-off, anchor recorded,
   purge audited) but **execution is disabled** (`AUDIT_PURGE_EXECUTION_APPROVED = false`) until the formal
   retention policy is approved (Q3); the CLI reports only.
8. **Token keys.** Ciphertexts are `v2:<kid>:…`; `v1:` rows stay readable with the legacy key. The keyring is
   read from the `SecretProvider` (`PLATFORM_TOKEN_ENCRYPTION_KEY_ID`, `PLATFORM_TOKEN_ENCRYPTION_KEY_<KID>`,
   `PLATFORM_TOKEN_ENCRYPTION_PREVIOUS_KEY_IDS`); OAuth states are signed with the current key and verified
   with every key in the ring. `security rekey` re-encrypts per tenant (audited, counts only) and
   `security key-usage` reports rows per key id.
9. **Security events.** A closed catalogue, emitted as structured `warn` logs and the counter
   `lip_security_events_total{event, outcome}`; codes and identifiers only.

## Consequences

- Every write path changed signature; tests obtain contexts from the real authorizer (`test/support/security.ts`).
- Tenant transactions now state READ COMMITTED explicitly (a role or server default can no longer change it).
- An unknown token key id fails closed with a security event; rotation needs the old key until `key-usage`
  reports zero rows for it.
- These are engineering controls, **not** SOC 2, GDPR, HIPAA or legal-retention claims.
- Deferred: authenticated operator identity (M15), tenant data policy driving retention (A2), purge execution
  (tech debt #15), export/erasure features.
