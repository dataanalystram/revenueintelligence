# Project rules — Juniper / Wigmore Lead Intelligence Platform

Production system intended for delivery to a real client. Correctness,
evidence, security and reproducibility beat speed.

## Delivery discipline

- **One milestone at a time** (roadmap: `docs/milestones/README.md`). Never start
  the next milestone without the user's explicit approval.
- Every milestone: **inspect → plan → implement → test → verify → commit → PR → stop**.
- **Never claim completion without evidence**: exact commands and their output.
  Run the `verify` skill (`.claude/skills/verify/SKILL.md`), which covers
  `pnpm verify`, runtime verification, Docker and a **fresh-clone run**. The
  fresh-clone run is mandatory before a milestone is reported complete.
- **Prove critical checks can fail.** For safety and verification guarantees
  (tenant isolation, role guard, locking, shutdown, cleanup), temporarily break
  the mechanism and show that the check fails for the right reason. A failure
  caused by something else (build error, Docker down) is not evidence. A
  passing script that has never been seen to fail is not evidence either.
- Record each milestone in `docs/milestones/Mxx-*.md` (scope, Definition of
  Done, evidence, open questions). Architectural decisions go in `docs/adr/`.
- After scripted/bulk edits (sed, python, regex replace), **confirm each edit
  applied** (grep for the new text). Prettier reformatting has silently broken
  text replacements before.

## Architecture invariants

- Preserve module boundaries (`apps/api/.dependency-cruiser.cjs`). The domain
  stays pure. External systems are reached only through connector modules.
  Business code uses canonical types, never vendor payloads.
- **Tenant isolation** (ADR 0008): tenant data only via
  `TenantDatabase.transaction(ctx, …)`. Every new table needs `tenant_id`, a
  forced RLS policy and tenant-scoped keys; the schema-guard test enforces this.
  Never weaken the app's non-privileged database role.
- Validate every external payload with Zod at the connector boundary.
- Qualification (AI) classifies; deterministic code decides SLA, routing and
  CRM actions. Human overrides win.

## Never

- Invent customer schemas, field names or picklist values. Unknown = `tbc`
  in configuration.
- Invent, request in chat, commit or log credentials. Secrets go through
  `SecretProvider`; tell the user which variable to set and where.
- Enable production writes to customer systems without explicit approval.
- Skip, disable or weaken a test or check to get green.
