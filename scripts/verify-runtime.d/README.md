# Milestone-specific runtime checks

`scripts/verify-runtime.sh` sources every `*.sh` file in this directory, in
name order, after its core checks and before shutdown.

| File                        | Milestone | Checks                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `20-hubspot.sh`             | M3        | HubSpot CLIs against a local fake: read-only setup, discovery, refusals                                                                                                                                                                                                                                                                                                                                                                                           |
| `30-hubspot-oauth.sh`       | M4        | OAuth install via a second API process: callback, single-use state, encrypted grant, CrmReader discovery, one refresh across processes, no leaks                                                                                                                                                                                                                                                                                                                  |
| `50-context-processing.sh`  | M6        | Webhooks → receipts → BullMQ → worker read-back → canonical records, references, provenance; eligibility; worker killed mid-job and restarted; dead letter → `context:replay`; checkpointed backfill with an unchanged state hash on rerun; graceful worker shutdown; no HubSpot write; no values or secrets in logs                                                                                                                                              |
| `40-hubspot-webhooks.sh`    | M5        | Signed webhook deliveries through a real API process: v3 signature, freshness, Host never trusted, v1/v2 refused, body limit, atomic de-duplication, routing (static tenant never, unknown never guessed), identifiers only, no leaks, no HubSpot calls                                                                                                                                                                                                           |
| `60-product-eligibility.sh` | M7        | Example model and CSV through the real CLIs: dry runs write nothing, atomic publish, K1 refusal, coverage gating (no eligible whitespace before a full load), malformed CSV writes nothing, full import → coverage, evaluate/whitespace, recorded snapshot replays after the facts change, tombstone pass, `products:report` invariants, RLS, no account names in output                                                                                          |
| `70-source-connectors.sh`   | M8        | Fake Sugar (synthetic fixtures, TEST mapping) through the real CLIs and a dedicated worker: connection via SecretProvider credential name, metadata-only snapshot, dry runs write nothing, terms refused without authority, stale bases refused, full sync on `lip-sources` with the fixture-matrix quality counts, ownership gaps, provenance linkage, coverage known, `ownership_incomplete`, read-only transport, RLS, no values or credentials in output/logs |

Conventions for a check file (e.g. `20-hubspot.sh`):

- Use the helpers and variables the main script defines: `check "<name>" <cmd…>`,
  `pass`, `fail`, `compose`, `API_URL`, `API_DIR`, `APP_DB_URL`, `OWNER_DB_URL`,
  `REDIS_URL`, `WORK` (log directory).
- Needs no real credentials. External systems are exercised against local
  fakes; live checks belong to the connector's live suite (see the verify
  skill, section 4).
- Leaves nothing running: any process it starts must be stopped before the
  file returns.
