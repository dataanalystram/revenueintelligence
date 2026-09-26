# ADR 0004 — Product scope and coexistence with a Fuelius implementation

- Status: Accepted
- Date: 2026-09-26

## Context

The Fuelius brief describes a HubSpot → Sugar lead handover. We must not assume
Fuelius has completed a production build. Juniper may still have parts of it
in place.

## Decision

1. The Fuelius documents are the **business/process baseline and the
   requirements we must support**, not a description of existing software.
2. The platform can:
   - reproduce the HubSpot → Sugar handover end to end
   - extend it with Gainsight PX/CS signals
   - add qualification and intelligence
   - sync outcomes back
   - become a reusable Wigmore product for other customers
3. **Coexistence or replacement per tenant.** Each integration capability is
   enabled per tenant (tenant configuration, M2). For example:
   - `handover.hubspotToSugar = off`: an existing integration owns the sync.
     We only read and match via cross-references (M8), and never write.
   - `handover.hubspotToSugar = on`: we own the sync.
     Switching owner is a configuration change plus a reconciliation run. No
     code changes.
4. We never assume which fields another integration writes. Before enabling
   writes for a tenant, read-only discovery (M16/M17) compares the actual CRM
   schema with our configured mappings.

## Consequences

- Cross-reference matching must handle records created by someone else, not
  only records we created ourselves.
- A capability matrix per tenant is part of the tenant model (M2).
