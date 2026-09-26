# ADR 0006 — Lead creation ownership, requalification and source attribution

- Status: Accepted
- Date: 2026-09-26

## Who creates Leads

| Origin                                                                                                                           | Creator                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HubSpot marketing sources: forms, demo requests, book a call, webinar registrations, downloads, contact us, lead score threshold | **HubSpot** (its workflows). The platform ingests, enriches, qualifies and syncs these; it does not create a second Lead.                                |
| Gainsight PX usage, Gainsight CS account/expansion signals, future enrichment sources                                            | **The platform**, through a `LeadCandidate` that passes the duplicate/requalification checks. The Lead is then created in HubSpot through the connector. |

## Duplicate and requalification checks (explicit, tested; M11/M14)

Before creating a platform-sourced Lead, a `LeadCandidate` is **suppressed**
if an equivalent Lead already represents the same:

- person, **and**
- account, **and**
- product / opportunity, **and**
- recent qualifying event

and that Lead is still **open** (New / Attempting / Connected), or was
disqualified for the same product within a tenant-configured cool-off period.
The exception is a genuinely new compelling event, which Juniper's working doc
also requires.

Juniper's requirement that **one Contact can produce multiple Leads over time**
still holds: a new qualifying event outside these conditions creates a new
Lead.

The equivalence key (person, company, product) and the suppression reasons are
canonical domain concepts (M1). The windows and thresholds are tenant policy
configuration (M14). The decision function lives in signal aggregation (M11)
and is unit-tested across every branch.

## Source attribution

Every Lead keeps its **true origin**, and it never changes after creation:

- `origin`: `hubspot`, `gainsight_px`, `gainsight_cs`, `external_enrichment`
  or `manual`
- `channel`: form submission, demo request, webinar, lead score, product
  usage, CS expansion, …
- campaign / form references and a human label (the brief's "heat indicator")

Gainsight-sourced Leads are therefore attributable, so Juniper can report the
revenue and conversion the intelligence layer generates. Which channels each
origin may produce is validated in the domain model.
