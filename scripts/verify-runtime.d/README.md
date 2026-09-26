# Milestone-specific runtime checks

`scripts/verify-runtime.sh` sources every `*.sh` file in this directory, in
name order, after its core checks and before shutdown. There are none yet.

Conventions for a check file (e.g. `20-hubspot.sh`):

- Use the helpers and variables the main script defines: `check "<name>" <cmd…>`,
  `pass`, `fail`, `compose`, `API_URL`, `API_DIR`, `APP_DB_URL`, `OWNER_DB_URL`,
  `REDIS_URL`, `WORK` (log directory).
- Needs no real credentials. External systems are exercised against local
  fakes; live checks belong to `pnpm test:live`.
- Leaves nothing running: any process it starts must be stopped before the
  file returns.
