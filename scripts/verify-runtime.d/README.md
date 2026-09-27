# Milestone-specific runtime checks

`scripts/verify-runtime.sh` sources every `*.sh` file in this directory, in
name order, after its core checks and before shutdown.

| File                  | Milestone | Checks                                                                                                                                           |
| --------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `20-hubspot.sh`       | M3        | HubSpot CLIs against a local fake: read-only setup, discovery, refusals                                                                          |
| `30-hubspot-oauth.sh` | M4        | OAuth install via a second API process: callback, single-use state, encrypted grant, CrmReader discovery, one refresh across processes, no leaks |

Conventions for a check file (e.g. `20-hubspot.sh`):

- Use the helpers and variables the main script defines: `check "<name>" <cmd…>`,
  `pass`, `fail`, `compose`, `API_URL`, `API_DIR`, `APP_DB_URL`, `OWNER_DB_URL`,
  `REDIS_URL`, `WORK` (log directory).
- Needs no real credentials. External systems are exercised against local
  fakes; live checks belong to the connector's live suite (see the verify
  skill, section 4).
- Leaves nothing running: any process it starts must be stopped before the
  file returns.
