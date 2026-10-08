# ADR 0020: Versioned source mapping, source authority and coverage (Milestone 8)

- Status: accepted (M8 implementation; plan approved 2026-10-02, `a8b61fb`)
- Date: 2026-10-03

## Context

A source's records must become canonical facts through governed tenant
configuration, written by the existing single writers (M6
`ContextIngestionService`, M7 `SubscriptionIngestionService`), with
provenance, and without a scripting or ETL layer. The sanitized Sugar
evidence (`docs/discovery/`) shows a source can hold strong identities and
relationships while its state and date fields are unreliable, and that a
source object can mix holdings with lost or open deals.

## Decision

### Mapping documents

1. One immutable **mapping version** per source connection publication
   (`tenant_source_mapping_versions`): document, content hash, base version,
   schema snapshot hash, authority version validated against, publisher,
   validation summary. A trigger refuses UPDATE and DELETE; a correction is a
   new version.
2. Entry kinds in M8: `identity`, `core`, `relationship`, `ignored`. The
   `attribute` kind is reserved and refused (`attribute_mappings_not_enabled`)
   until the attribute registry exists. Targets are typed references into code
   catalogues (`subscription.state`, `subscription.account`, …), never free
   paths. Source objects and fields are validated against the schema snapshot.
3. **Closed transforms**, fixed order: null handling (empty, whitespace,
   declared sentinels such as a literal `'NULL'`) → normalise (trim, collapse,
   case) → parse (`date`/`datetime` with a declared format and time zone;
   `number`; `boolean` with declared true/false sets) → value map with an
   explicit unmapped policy. No expressions, regular-expression capture,
   arithmetic, conditionals or code.
4. **Explicit "no source"**: a required target may be stated as
   `explicit: unknown` (targets with an `unknown` value, e.g.
   `subscription.state`) or `explicit: null` (optional targets). Nothing is
   defaulted silently.
5. **Consequential entries need a recorded confirmation** (who, note):
   identity entries that are not declared unique, state value maps, date
   entries, the holding filter and a relationship fallback.

### Holding filter

6. A `subscription` object may declare one **holding filter**:

   ```json
   { "field": "<field on the mapped object>", "operator": "in" | "not_in",
     "values": ["…"], "confirmation": { "by": "…", "note": "…" } }
   ```

   Exactly one source field, one membership predicate. No nested conditions,
   no AND/OR, no expressions, no scripting, no SQL fragments, no cross-field
   comparison. Values are validated against the snapshot's enum options when
   the field has them. Records outside the filter are counted
   (`filtered_out`) and never ingested. No source value is hard-coded in any
   adapter.

7. **Limitation (accepted).** M8 holding filters operate **only on fields
   present directly on the mapped source object**. A filter on a parent or
   related object's field (for example `OpportunityLineItem` qualified by its
   parent `Opportunity.StageName`) is **not supported** and needs future design
   work; M8 does not solve relational holding filters.

### Source authority

8. Authority is declared per **business fact**, versioned per tenant
   (`tenant_source_authority_versions`), each fact assigned to one connection
   or left unassigned. The closed set is exactly:
   `account_profile`, `person_profile`, `subscription_lines`,
   `subscription_state`, `subscription_terms`. Identity is not an authority
   fact (every source keeps its own external references); product identity is
   governed by the product model's external references. There is no field-level
   precedence, priority chain or voting.
9. A connection may write a fact only if it is that fact's authority;
   validation refuses otherwise (`authority_conflict`). A connection becomes
   authoritative for `subscription_lines` only with a **confirmed holding
   filter** or an **explicit confirmed declaration that every mapped record is
   a holding** (`holding_filter_required`).
10. **Cross-source limitation (accepted).** Lines created from one source are
    not updated by another source's facts: combining, say, state from source B
    with lines from source A needs stable cross-source line matching, deferred
    to M9 or later. Until then an unassigned fact stays `unknown`/empty.

### Publication

11. Publishing a mapping version or an authority version **requires**
    `expectedBaseVersion` at the service layer (`0` for the first). A stale base
    gets `concurrent_publish`. Publication is serialised per tenant and
    connection by an advisory lock. Product model publication is hardened the
    same way (ADR 0016 note).

### Coverage, ownership gaps and full reads

12. **Tenant coverage** is known only after a completed full synchronisation
    of the connection authoritative for `subscription_lines`, under a published
    mapping, that passed the full-read proof. It is never known after a partial,
    failed or unstable read, after schema drift, after a product configuration
    gap, or while `subscription_lines` authority is unassigned. Sources never
    self-report coverage. M7 CSV imports keep establishing coverage for tenants
    whose authority is the `import` connection.
13. **Full-read proof**: a run starts with a boundary (`runStart`), reads the
    bounded set (`source modified <= runStart`) in deterministic order, and
    reconciles counts at start, at end and records read where the source
    supports counting; otherwise the run fails `unstable_read`.
14. **Product catalogue phase first**: a full run reads the source's product
    references before any line. A product present in the source but absent from
    the product model and not ignored is a configuration gap: the run fails
    before processing lines (`unmodelled_product_reference`), coverage
    unchanged. The connector never changes the product model.
15. **Per-account ownership gaps**: a holding line whose product reference is
    missing (`missing_product_reference`) or absent from the source's own
    catalogue (`orphan_product_reference`) is not ingested, and its account is
    recorded in `tenant_ownership_gaps`. Because the product is unknown, the gap
    covers the whole account. Evaluation treats a gapped account as
    `ownership_incomplete` (ADR 0018 note): ownership conclusions stay `unknown`,
    no not-owned inference, no eligible whitespace.
16. **Invalid terms keep the holding**: an unparseable date or an end before
    its start empties both terms, forces state `unknown` and counts
    `invalid_period`. A valid holding is never dropped for bad dates.
17. **Incremental runs** use a durable watermark `(source modified, source id)`
    with a connection-configurable overlap, advance it only after a successful
    run, never establish coverage and never infer deletion. Deletions come from
    the full-run tombstone pass (or a delete feed only once a connector proves
    one).

### Provenance

18. `tenant_context_changes` and checkpoints gain `source_connection_id` and
    `mapping_version`; every mapped write records connection, source object,
    record id, mapping version, source timestamp, cause, checkpoint and
    correlation. Values are never recorded.

### Legacy table

19. `tenant_field_mappings` (M2) is retired. Juniper's ten Sugar **Leads**
    rows were outbound write intent, not inbound mappings; they are preserved
    verbatim as an M15 input (`docs/integrations/sugar/lead-handover-field-intent.md`)
    and are not converted.

## Consequences

- Tenants configure sources without code; every canonical fact is traceable to
  a mapping version.
- Sources with unreliable state are ingested honestly (`unknown`), and
  unattributable holdings cannot create false whitespace.
- Relational holding filters, cross-source line matching and field-level
  precedence are explicit future work.

## As built (M8)

- **Governance order** for a new source: publish a mapping whose
  subscription objects have confirmed holdings and state terms/state
  explicitly → publish authority (lines, and terms if confirmed) → publish the
  next mapping version with the confirmed date mapping. Mapped state, terms and
  profiles are refused until the connection holds that fact; lines are gated
  at run start (`not_authoritative_for_lines`) and by the authority holding
  gate. Authority also refuses `cross_source_unsupported` (state/terms from a
  connection other than the lines') and `authority_not_supported` (a
  code-mapped kind for a fact it cannot provide).
- **Authority version 1** is seeded for every tenant: subscription facts →
  `import` (keeps M7 CSV coverage behaviour for every tenant), profiles → the
  HubSpot connection where configured; provisioning seeds the same (profiles
  unassigned).
- **Unmodelled products** are detected at catalogue level (any catalogue
  product neither modelled nor ignored), before any line is processed; the
  ignore list therefore also carries inactive catalogue entries (tech debt).
- **Resume**: a full run interrupted by a transient failure restarts its read
  under the same boundary (writes are idempotent); an incremental run resumes
  from its stored position.
- **Wire precision**: the Sugar adapter sends second-precision timestamps
  (LIVE); the incremental window start is floored, so reads only start
  earlier.

## As built (M9A amendment, ADR 0022 / ADR 0023)

- **Holding filters** carry a `reviewedDomain` (every value `holding` or
  `non_holding`, explicit empty entry). The M8 rule "an empty value is never
  a member" no longer applies: under `not_in` an empty or unknown value is
  never admitted. Versions published before M9A are refused at run start
  (`mapping_requires_republish`).
- **Publication** additionally requires a covering profile of the same
  snapshot, acknowledgements of review-required findings on consequential
  fields, and a reviewed domain; the validation document records
  `coveringProfileIds` and `acknowledgements`.
- **Tombstones** delete a line only when its key is neither a holding of the
  run nor in its seen-but-rejected protection set; protected records give
  their account an ownership gap (new reasons `observation_rejected`,
  `holding_filter_value_unreviewed`, `account_reference_orphaned`).
- **Coverage** has a structural tier from the proof of the establishing run;
  authority versions gain `proof_acceptances` (stable-snapshot acceptances
  only; the content hash is unchanged while empty).
- **B guards** (fixed thresholds) refuse structurally broken runs before
  writes and before tombstones.
