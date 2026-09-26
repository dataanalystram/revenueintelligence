# ADR 0009: HubSpot read connector (Milestone 3)

- Status: accepted
- Date: 2026-09-26

## Context

Milestone 3 must prove, against a HubSpot developer test account, that the
platform can authenticate and read the objects and metadata the Juniper
integration will need, without writing to any HubSpot account. HubSpot's
platform changed substantially in 2025–2026:

- **Date-based API versions** replaced v1–v4 path versions. The first was
  `2026-03`; `2026-09` became generally available on 8 September 2026. Each
  version is supported for 18 months, with releases every March and September.
- The **developer platform** (projects, 2025.2 and later) frames apps by
  distribution (private or marketplace) and by auth (static token or OAuth).
  Legacy apps and v1–v3 APIs go unsupported from September 2027.
- The **Leads** object (`0-136`, path `leads`) is available only with Sales
  Hub Professional or Enterprise.

## Decision

1. **Connector module `src/modules/hubspot`**: the only code that knows
   HubSpot payloads. Business code gets vendor-neutral read models
   (`ExternalPersonSnapshot`, `ExternalCompanySnapshot`, `ExternalLeadSnapshot`,
   `ExternalFieldDefinition`, `ExternalAssociation[Type]`, in `domain`).
2. **API version `2026-09`**, set by `HUBSPOT_API_VERSION` (process
   configuration, not tenant data). CRM paths are
   `/crm/objects/{v}/{type}`, `/crm/properties/{v}/{type}`,
   `/crm/associations/{v}/{from}/{to}/labels`, and
   `POST /crm/associations/{v}/{from}/{to}/batch/read`. Account details use
   `/account-info/v3/details`, which has no date-based version yet.
3. **Read-only by construction.** The transport refuses everything except GET
   and POST to an allow-listed batch _read_ path, before any request is sent.
   There are no write methods. Writes to customer systems need explicit approval
   and a later milestone.
4. **Tenant-scoped access.** `HubSpotConnector.forTenant(ctx)` (and
   `connect(ctx)`, which also returns the account) does three things before
   returning a reader:
   - requires the tenant's HubSpot integration to be enabled, with a
     configured `portalId`;
   - resolves only that tenant's `hubspot.access_token` credential, through
     `TenantCredentialsService` and the `SecretProvider` (ADR 0003, 0008);
   - verifies that the token belongs to that `portalId`.

   Rate budgets are per tenant.

5. **Authentication for M3: a static access token** from a private-distribution
   app installed in the developer test account. HubSpot recommends this for
   single-account apps, and it needs no public callback URL. OAuth, the
   multi-account install that Juniper will use, arrives with the connector
   abstraction (M4) and real validation (M16). The reader takes a `Secret`
   token, so only the way the token is obtained changes.
6. **Failure handling.** Every response is validated with Zod. Per-record
   failures in a 207 batch response are returned to the caller, never
   dropped. Errors are
   classified as 401, 403 (with HubSpot's `requiredGranularScopes`), 404, 400,
   429 (`DAILY` is never retried; burst limits honour `Retry-After`), 5xx,
   timeout, network or invalid payload. Only transient failures are retried,
   with capped, jittered backoff. Errors and logs never contain the token or
   record values.
7. **Discovery refuses production.** `hubspot:discover` runs only against
   `DEVELOPER_TEST` or `SANDBOX` accounts unless explicitly overridden. Its
   report holds schema, counts and sampled record ids, never record field
   values.

## Consequences

- The rate limiter is per process. A shared (Redis) limiter comes with the
  queue work (M6).
- Record-level association reads use POST because HubSpot's batch read does.
  The allow-list is exact and tested; adding a path is a reviewed change.
- The date version must be bumped deliberately before `2026-09` reaches end of
  life (about March 2028), re-running the live tests.
- Lead webhooks, OAuth install and writes are open items (see
  `docs/integrations/hubspot/discovery-findings.md`).
