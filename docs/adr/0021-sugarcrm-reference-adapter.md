# ADR 0021: SugarCRM reference adapter (Milestone 8)

- Status: accepted (M8 implementation; plan approved 2026-10-02, `a8b61fb`)
- Date: 2026-10-03
- Live status: **LIVE SUGAR VERIFICATION: PENDING**

## Context

SugarCRM is the first adapter behind the generic port (ADR 0019). The
sanitized discovery ([local evidence](../discovery/sugarcrm-local-evidence.md),
[platform alignment](../discovery/sugarcrm-platform-alignment.md), 16
synthetic fixtures in `fixtures/sugarcrm/sanitized/`) gives verdict **B**:
strong identities and relationships, no reliable subscription state, ambiguous
dates and renewals. Historical Python code (Sugar → CSV → S3 → Gainsight) is
knowledge only.

## Decision

1. **Module `sugar`** implements the generic port; only composition roots and
   the CLI import it (dependency rule). Sugar module and field names appear
   only there, in fixtures and in tenant configuration.
2. **Read-only transport guard**: only `GET` requests and the OAuth token
   `POST` leave the adapter; anything else throws before sending.
3. **Authentication**: OAuth2 password grant with refresh against
   `/rest/{version}/oauth2/token`; client id/secret, username and password are
   credential names resolved through `SecretProvider`; the API version is
   connection configuration (the historical `v11_20` is a placeholder).
4. **Reads**: `GET /{Module}` with `fields` (mapped fields only), `filter`,
   `order_by`, `max_num`, `offset`; stop on a short or empty page.
   `GET /{Module}/count` is used for full-read count reconciliation when
   available. `GET /{Module}/fields` provides schema metadata;
   `GET /{Module}/{id}` is optional. Full runs read the bounded set
   `date_modified <= runStart` ordered by `date_modified, id`; incremental runs
   filter `date_modified >= watermark − overlap`.
5. **Retries**: 429 and 5xx retried with backoff honouring `Retry-After`, a
   per-connection rate limiter, timeouts; other 4xx are permanent.
6. **Identity and relationships** (evidence-backed): `Accounts.id`,
   `Contacts.id`, product catalogue `id` (never `name`: 8.8% duplicates),
   `RevenueLineItems.id`; `account_id`, `opportunity_id`,
   `product_template_id` and contact `account_id` as relationships. `Users` are
   classified internal and cannot map to people.
7. **No inference**: the adapter never derives state. An RLI's existence, a
   Closed Won opportunity, a positive amount or present dates never produce
   `active`. Without a confirmed state mapping, `subscription.state` is
   `unknown`.
8. **Renewals**: each RLI is one source line; renewal links (`renewal_rli_id`,
   `renewal`, `renewal_parent_id`, ~34% each, two coexisting mechanisms) are not
   used in M8.
9. **Deletes**: delete visibility is `none` until proven live (the export had
   no deleted rows). If the API returns `deleted = true` rows, they map to an
   absence. Otherwise deletions come from the full-run tombstone pass.
10. **Not reused**: CSV/S3/Gainsight destinations, rolling 7/14/90-day
    windows, the historical retry gap, "Closed Won ⇒ active".

### Live verification gate (pending)

`REQUIRES LIVE SUGAR VERIFICATION`, each recorded in
`docs/integrations/sugar/live-verification.md`: API version; auth flow
(password and refresh-token grants, token lifetime, platform parameter);
`/ping`; `/{Module}/fields` shape; module and field API names (including the
product catalogue module: `ProductCatalog` in the export, `ProductTemplates`
in standard Sugar); permissions; list reads, ordering and filters; the count
endpoint; `date_modified` precision and time zone; `GET /{Module}/{id}`; rate
limits and `Retry-After`; delete visibility; duplicate ids from the API;
current custom fields; live counts against a full run; read-only proof.

No real Sugar tenant may be enabled until this gate passes. M8 may be
**IMPLEMENTATION COMPLETE** with this gate pending.

## Consequences

- The adapter is proven against a deterministic fake built from the evidence
  and companion fixtures; no live behaviour is claimed.
- Juniper business decisions (holding stages, date pair and time zone, any
  state meaning, renewal semantics, non-subscription products, authority) are
  configuration, not code.
