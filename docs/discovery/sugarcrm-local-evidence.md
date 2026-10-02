# SugarCRM Discovery — Local Evidence Report

Status: DISCOVERY ONLY. No M8 implementation. No canonical model changes. No repo comparison (repo not available in this environment — see §0).
Branch: `spike/sugarcrm-local-discovery`
Author context: prepared for the Revenue Opportunity Intelligence platform team.

Legend used throughout: **[HISTORICAL CODE EVIDENCE]** = observed directly in `new_updated_code_secure_v11`. **[JUNIPER DATA EVIDENCE]** = computed directly from the real CSV extracts via streaming aggregate queries (counts/rates only, no raw values retained). **[CURRENT OFFICIAL DOCS]** = SugarCRM's own current documentation, cited. **[INFERENCE]** = my reasoning connecting the above; flagged explicitly as inference, not fact.

---

## 0. Repo comparison — NOT AVAILABLE

No local clone of the "Revenue Opportunity Intelligence" repo was provided. Every item in the brief that calls for comparing against `docs/architecture/canonical-extension-and-source-mapping.md`, M0–M7 code, or the existing canonical model is marked **NOT AVAILABLE — repo not accessible in this environment** rather than fabricated. All canonical-mapping-candidate tables in §16 are therefore *candidates in a vacuum* — they describe what Sugar concepts look like and what they could plausibly map to in a generic subscription/revenue model, not a verified mapping against the platform's actual canonical schema.

---

## 1. Historical codebase architecture **[HISTORICAL CODE EVIDENCE]**

Location: `new_updated_code_secure_v11` (not committed; inspected in place).

- **Runtime**: Python 3.8+, async (`aiohttp`), driven by shell scripts (`full_sync.sh`, `delta_sync.sh`, `full_sync_parallel.sh`, `run_one_module.sh`).
- **Entry points**: one `extract_<module>.py` script per SugarCRM module, duplicated under `scripts/full_sync/` (no date filter) and `scripts/delta_sync/` (date-filtered). Modules: Users, Accounts, AccountLinks, Contacts, Opportunities, ProductCatalog, RevenueLineItems, Calls, Meetings, Emails, Notes.
- **Core library** (`src/`):
  - `services/sugarcrm_client.py` — OAuth2 client (`SugarCRMClient`).
  - `services/sync_orchestrator.py` — coordinates extract → transform → CSV → S3 per table.
  - `services/data_transformer.py`, `services/csv_generator.py` / `enhanced_csv_generator.py` / `enhanced_csv_safe_writer.py` — field mapping + CSV writing, with a separate "safe" writer (suggests prior encoding/escaping issues were patched).
  - `services/s3_uploader.py` / `custom_s3_uploader.py` — S3 upload (two implementations exist; only one path is live per `CHANGES.md`).
  - `services/config_manager.py` — loads `config/field_mappings.yaml` and `config/revenue_line_items_mapping.yaml`, validates them against a Pydantic schema.
  - `core/config.py` — Pydantic `BaseSettings`, reads `.env` or real environment variables (container-friendly per `CHANGES.md`).
  - `core/logging_config.py`, `core/error_handler.py` — structured logging (`api_logger`, `sync_logger`), JSON log format configurable.
- **Config-driven transform**: field mappings are declarative YAML (source Sugar field → target CSV column, type, transform e.g. `clean_currency`/`title_case`/`lowercase`, validation rules). This is a real strength — adding a field is a config change, not new code.
- **Output pipeline**: Sugar REST → in-memory records → field-mapped transform → CSV file (configurable delimiter/quoting/encoding) → S3 upload into `GAINSIGHT_S3_BUCKET` → (implicitly) Gainsight ingests from S3. No direct Gainsight API call was found in the inspected code — the integration is file-drop, not API-push.
- **Scheduling**: cron-string fields present in YAML (`sync_schedule: "0 6,18 * * *"`) and a `scheduler.py` service, but the actual trigger observed in practice is external (cron/CI calling the shell scripts), not an in-process scheduler daemon being clearly wired to `sync_orchestrator`.
- **CHANGES.md** documents a real prior bug: all four shell scripts used to hard-fail if no literal `.env` file existed, even when credentials were already present as real environment variables (container/ECS/K8s secrets) — fixed to accept either source. This confirms the code has been iterated on for container deployability, not just local dev.

## 2. SugarCRM API usage inventory **[HISTORICAL CODE EVIDENCE]**

From `src/services/sugarcrm_client.py`:

| Capability | Implementation detail |
|---|---|
| Auth | `POST {base_url}/oauth2/token`, `grant_type=password`, `client_id="sugar"`, `client_secret=""` (empty — typical of Sugar's default `sugar` OAuth client). Bearer token used on all subsequent calls. |
| Token refresh | Proactive refresh 5 minutes before `expires_in`; reactive refresh on HTTP 401 mid-pagination with one retry of the same page. |
| Pagination | Offset/limit style: `max_num` (batch size) + `offset`, incremented by `batch_size` each page; loop stops when a page returns fewer records than `batch_size` or zero records. `order_by=date_modified` is always set. |
| Incremental filter | `filter[date_modified][$gt]=<ISO8601 no offset>` appended when a `last_sync_time` is supplied. |
| Retry/backoff | A flat `asyncio.sleep(0.1)` between pages (rate-limit courtesy, not exponential backoff); on non-200/401 it raises immediately — no retry-with-backoff loop was found in this client for generic 5xx/429 responses (contradicts the "MAX_RETRIES=3" env var's apparent promise — that value does not appear to be consumed inside `sugarcrm_client.py` itself; it may be used elsewhere, e.g. shell-script-level retry, not verified here). |
| Schema discovery | `GET {base_url}/{table_name}/fields` → `get_table_schema()`. This is a real, working `describeSchema`-equivalent call against the historical API version. |
| Connectivity test | `GET {base_url}/ping` with bearer token → `test_connection()`. |
| Read records | Implicit via `extract_table_data` (list endpoint only) — no single-record `GET /{module}/{id}` call was found in this client; `readRecord` (singular) is not demonstrated by the historical code, only `readRecords` (list/paginated). |
| Deletes/tombstones | No explicit tombstone-aware call (e.g. a `deleted=true` filter) was found in the client; `deleted` is just a normal field coming back in list payloads. |

## 3. Current official SugarCRM API — research findings **[CURRENT OFFICIAL DOCS]**

Sources (via web search, Oct 2026):
- SugarCRM REST API — Sugar Developer Guide, multiple versions: https://support.sugarcrm.com/Documentation/Sugar_Developer/Sugar_Developer_Guide_12.1/Integration/Web_Services/REST_API/ and the 14.0/14.2 equivalents (https://support.sugarcrm.com/documentation/sugar_developer/sugar_developer_guide_14.0/.../how_to_filter_a_list_of_records/, https://support.sugarcrm.com/documentation/sugar_developer/sugar_developer_guide_14.2/integration/web_services/rest_api/).
- Sugar RESTful API Collection (interactive reference): https://rest.apidocs.sugarcrm.com/

Findings:
- The OAuth2 `POST /rest/<version>/oauth2/token` pattern with `grant_type=password|refresh_token` remains current — the historical client's auth flow is structurally consistent with current docs.
- Current docs confirm `date_modified`/date filters expect ISO 8601, consistent with the historical code's format.
- "How to Filter a List of Records" is a maintained, versioned cookbook page across 11.0 → 14.2, implying the filter DSL (`filter[field][$operator]=value`) the historical client uses is a long-lived, stable pattern across many Sugar versions — a positive compatibility signal.
- I could not, within this research pass, confirm from primary docs text (vs. search snippets) whether `v11_20` specifically is still a supported API version line today, or whether SugarCRM has since moved customers to a newer default API major version. **This is flagged as a live-verification gap (§20), not assumed either way.**
- I did not find, in this pass, authoritative current-docs confirmation of rate-limit thresholds or the exact retry semantics Sugar's platform enforces server-side — needs live verification against the actual tenant.

## 4. Old-vs-current compatibility matrix

| Capability | Historical code (v11_20 assumed from `.env.example` comment) | Current official docs | Assessment |
|---|---|---|---|
| OAuth2 password grant | Implemented | Documented, current | COMPATIBLE |
| Token refresh via `refresh_token` grant | NOT implemented (client re-authenticates with password instead) | `refresh_token` grant documented as the preferred path | PARTIAL — works, but not best-practice; **NEEDS LIVE VERIFICATION** whether password-grant-on-every-refresh is still permitted/rate-limited the same way |
| List + paginate (`max_num`/`offset`) | Implemented | Documented | COMPATIBLE |
| Filter by `date_modified` | Implemented | Documented, stable across 11.0–14.2 | COMPATIBLE |
| Schema discovery (`/{module}/fields`) | Implemented | Exists in docs lineage; exact endpoint shape **NEEDS LIVE VERIFICATION** per version | LIKELY COMPATIBLE |
| Single-record read (`GET /{module}/{id}`) | NOT exercised in code (list-only) | Documented | UNVERIFIED BY CODE — current docs support it, old code doesn't use it |
| Connectivity test (`/ping`) | Implemented | Not independently confirmed in this research pass | NEEDS LIVE VERIFICATION |
| API version `v11_20` currently supported | Assumed from `.env.example` placeholder comment only, not a real tenant value | Not confirmed current in this pass | **NEEDS LIVE VERIFICATION** |

---

## 5. Juniper CSV inventory **[JUNIPER DATA EVIDENCE]**

All numbers below come from streaming CSV-aware parsing (Python `csv` module with `csv.field_size_limit` raised), not raw `wc -l`/`awk` on quoted fields — those undercount/overcount due to embedded newlines and commas inside quoted text fields. This mismatch is itself a data-quality finding (§14).

| File | True row count (parsed) | Naive `wc -l` (misleading) | Columns (approx) |
|---|---|---|---|
| ACCOUNTS_SYNC | 36,035 | 86,778 | ~60 |
| CONTACTS_SYNC | 153,946 | 187,894 | ~60 |
| OPPORTUNITIES_SYNC | 164,813 | 372,215 | ~60 |
| REVENUELINEITEMS_SYNC | 255,684 | 255,684 (matched — few embedded newlines) | ~170 |
| PRODUCTCATALOGUE_SYNC | 1,203 | 1,410 | ~65 |
| USERS_SYNC | 491 | 491 | ~150+ (truncated in review) |
| CALLS_SYNC | 109,451 | 182,998 | ~60 |
| MEETINGS_SYNC | 31,447 | 381,027 | ~60 |
| NOTES_SYNC | 50,000 | 50,000 | ~55 |
| EMAILS_SYNC | 10,694 | 736,802 | ~44 |

Candidate keys: `id` is the primary key on every entity table and is **unique with zero or near-zero duplicates** (Accounts: 0 dup; Contacts: 59 dup of 153,946; Opportunities: 4 dup of 164,813; RLI: 15 dup of 255,684; Users/ProductCatalogue: 0 dup). Duplicate rates are low (<0.04%) but non-zero — treat `id` as STRONG but not perfectly unique; dedupe-on-load required.

Candidate FKs identified by name + confirmed by join-rate testing (§6): `Opportunities.account_id`, `Contacts.account_id`, `RevenueLineItems.account_id`, `RevenueLineItems.opportunity_id`, `RevenueLineItems.product_template_id`/`product_id`, `Calls/Meetings/Notes/Emails.parent_id`+`parent_type` (polymorphic), `Notes.account_id`/`opportunity_id`/`contact_id`/`product_id` (Notes carries multiple direct FKs, not just polymorphic parent).

Candidate status/timestamp fields: Opportunities (`sales_stage`, `sales_status`, `date_closed`), RLI (`sales_stage`, `status`, `service`, `renewal`, `service_start_date`, `service_end_date`, `revenue_start_date_c`, `revenue_end_date_c`, `date_support_starts`, `date_support_expires`), ProductCatalogue (`active_status`, `status`, `renewable`, `service`).

---

## 6. Relationship graph + join-success-rate evidence **[JUNIPER DATA EVIDENCE]**

```
Users (491)
  ← assigned_user_id / created_by / modified_user_id (internal actor FKs, not customer identity)

Accounts (36,035) ── id
   ▲ account_id (99.2% match, 0.8% null, 0% orphan)        Opportunities (164,813)
   ▲ account_id (90.0% match, 10.0% null, 0% orphan)       Contacts (153,946)
   ▲ account_id (99.5% match, 0.5% null, <0.1% orphan)     RevenueLineItems (255,684)

Opportunities ── id
   ▲ opportunity_id (100.0% match, ~0% null, <0.01% orphan)  RevenueLineItems

ProductCatalogue (1,203) ── id
   ▲ product_template_id (96.5% match, 2.1% null, 1.4% orphan)  RevenueLineItems

Calls / Meetings / Notes / Emails
   → parent_id + parent_type (polymorphic; not separately re-verified per type in this pass — join rate NOT measured, flagged below)
   Notes also carries direct account_id / opportunity_id / contact_id / product_id columns (not polymorphic for these)
```

Proven join rates (exact, computed, not estimated):

| Edge | Match | Null FK | Orphan FK |
|---|---|---|---|
| Opportunities.account_id → Accounts.id | 99.2% | 0.8% | 0.0% |
| Contacts.account_id → Accounts.id | 90.0% | 10.0% | 0.0% |
| RLI.account_id → Accounts.id | 99.5% | 0.5% | <0.1% |
| RLI.opportunity_id → Opportunities.id | 100.0% | ~0.0% | <0.01% |
| RLI.product_template_id → ProductCatalogue.id | 96.5% | 2.1% | 1.4% |

Not measured in this pass (time-boxed): Calls/Meetings/Emails `parent_id`→Account/Opportunity/Contact join rates by `parent_type` bucket. **Flagged as a follow-up, not fabricated.**

---

## 7. Account identity candidate classification

| Candidate field | Class | Evidence |
|---|---|---|
| `Accounts.id` | **STRONG** | Unique PK, 0 duplicates observed, 99%+ of Opportunities/RLI resolve against it. |
| `Opportunities.account_id` | **STRONG** (as an FK, not identity) | 99.2% match rate, near-zero orphans. |
| `Accounts.name` | **WEAK** | Free text, title-cased by the transform layer, not validated for uniqueness; not independently tested for dup-name collisions in this pass. |
| `Accounts.duns_num` / `ticker_symbol` | **UNSUITABLE as primary identity for this dataset** | Present as columns but not inspected for population rate in this pass — likely sparse for a UK education-sector customer base (unverified); do not assume usable without checking null rate first. |
| `Accounts.parent_id` (hierarchy) | **MEDIUM** | Present and could represent multi-site/group structures (e.g. school groups), but hierarchy semantics not verified. |

---

## 8. Contact → canonical Person mapping (no PII exposed)

Structural findings only:
- `Contacts.account_id` links to Accounts with 90.0% match, 10.0% null — meaning 1 in 10 Contacts in this extract has no Account link. This caps how reliably Contacts can be used to infer Account-level canonical Person records without an Account anchor.
- `email1` is the mapped identity-ish field in the historical transform config (`field_mappings.yaml` lowercases and validates it as a required email), suggesting the historical integration already treats work email as the de facto person key — consistent with typical canonical-Person matching strategies, but this is **[INFERENCE]**, not proven against a live canonical model (unavailable).
- Duplicate `id` rate in Contacts is low (59 of 153,946, ~0.04%) — acceptable as a join key once deduped.
- No raw contact names/emails/phones are reproduced anywhere in this report or committed anywhere in this repo.

## 9. Product Catalogue — stable product identity

- 1,203 rows [parsed], 1,097 distinct `name` values → **106 duplicate-name rows** (~8.8%), meaning `name` is not a safe identity key.
- `id` is unique (0 duplicates) — the only STRONG identity candidate.
- `active_status`: Inactive 725 (60.3%), Active 371 (30.8%), Retired 107 (8.9%) — most catalogue rows are not currently active, consistent with years of historical SKUs accumulating.
- `renewable`: True 450 (37.4%) / False 753 (62.6%) — a real signal distinguishing recurring-capable products from one-time products, **MEDIUM confidence** candidate for recurring-vs-one-time classification (see §11).
- `type_name` has a real `'NULL'` *string* value (171 rows) distinct from true-empty — a parsing/export artifact worth flagging as a data-quality issue (§14), since consumers must not treat the literal string `"NULL"` as data.

## 10. Opportunity semantics classification

Classification: **PARTIALLY USEFUL**, with real **ENTITLEMENT EVIDENCE** leaking through via custom `service_*` and `renewal_parent_id` fields — not a pure "sales funnel only" object.

Evidence:
- Core fields (`sales_stage`, `sales_status`, `probability`, `amount`, `date_closed`, `commit_stage`) are classic sales-process fields → SALES PROCESS ONLY in isolation.
- But the schema also carries `service_start_date`, `service_duration_value`/`unit`, `renewal_parent_id`, `renewal_parent_name`, `closed_won_revenue_line_items`, `service_open_revenue_line_items`, `total_revenue_line_items` — these are **entitlement/service bookkeeping fields bolted onto the Opportunity object**, strongly suggesting Opportunities in this Sugar instance double as a loose proxy for "deal that created/renewed a service period," not just a sales pipeline record.
- `renewal_parent_id` is populated in 34.2% of Opportunities (56,398 of 164,813) — real evidence that a meaningful fraction of Opportunities are explicitly modeled as renewals of a prior Opportunity.
- 0.8% of Opportunities have no `account_id` at all — these cannot anchor any entitlement inference.

## 11. Revenue Line Item deep analysis

**Can one RLI represent one canonical Subscription source line? → PARTIALLY, with real evidence on both sides.**

Supporting YES:
- RLI carries its own start/end dates (`service_start_date`/`service_end_date`, `revenue_start_date_c`/`revenue_end_date_c`), its own `quantity`, `base_rate`, `mrr_c`/`arr_c`/`tcv_c` financial fields (per config mapping), and its own `renewable`/`service`/`recurring_one_off_c` flags — this is a line-level, not opportunity-level, granularity that matches a subscription line's shape.
- 100.0% of RLIs resolve to a real Opportunity (near-zero orphan rate) and 99.5% to a real Account — strong anchoring.
- 96.5% resolve to a real ProductCatalogue entry via `product_template_id` — strong product anchoring.

Supporting PARTIALLY/NO (why not a clean 1:1):
- `renewal_rli_id` (an RLI-to-RLI renewal link) is populated in only 33.6% of rows — meaning for two-thirds of RLIs there is no explicit successor/predecessor chain recorded at the line level; renewal continuity for those lines, if it exists, is not expressed as a canonical chain in this field.
- `recurring_one_off_c`: Recurring 178,810 (70.0%), Non Recurring 66,650 (26.1%), One Off 115 (0.05%), null 10,109 (4.0%) — three overlapping/inconsistent category labels on what should be a binary concept (recurring vs not), itself a data-quality flag, not a clean source of truth.
- `status` field (named exactly like a state field) is **99.5% null**, and where populated (0.5%) holds *lead-qualification* values ("Qualifying", "CRL Qualifying", "MQL", "Dead") that look like they belong to a different module's picklist bleeding through — **this field is NOT a usable subscription-state field**, LOW confidence, likely mis-populated/legacy.
- `juniper_id_c` and `subscription_urn_c` — both present as columns, **both 100% null** across all 255,684 rows. These look like fields that were added for a prior integration attempt (plausibly named for exactly this kind of external-system linkage) but were never actually populated. Important negative finding: do not assume these exist as usable keys.

**Recurring vs one-time/service/license/support distinguishing fields (MEDIUM confidence, not authoritative):**
- `recurring_one_off_c` (messy but directionally useful, see above)
- `service` flag on RLI (True 66.6% / False 33.4%) and on ProductCatalogue (True 52.9% / False 47.1%)
- `renewable` flag on ProductCatalogue (True 37.4% / False 62.6%)
- `support_name`/`support_term` fields on both RLI and ProductCatalogue suggest a distinct "support/license" sub-category not cleanly separated from "subscription" in the schema as inspected.

**Date semantics discovered (none assumed equal to each other):**
- RLI: `date_closed` (deal-level), `date_entered`/`date_modified` (system), `service_start_date`/`service_end_date` (33.5% null each — one-third of lines have no service period at all, consistent with non-service product lines), `revenue_start_date_c`/`revenue_end_date_c` (8.6% null each — more consistently populated than `service_*`), `date_support_starts`/`date_support_expires` (100% null — unused in this extract).
- Opportunity `date_closed` is a deal-closure date and must **not** be assumed equal to a Subscription `startsAt` — the RLI-level `service_start_date`/`revenue_start_date_c` are the more specific candidates, and even those disagree with each other in population rate, implying they are not simply duplicates of one field.

**Renewal pattern — new Opportunity vs new/updated RLI vs linked record (data-distribution evidence, not a conclusion):**
- Opportunity-level renewal chaining exists: `renewal_parent_id` populated in 34.2% of Opportunities.
- RLI-level renewal chaining exists: `renewal_rli_id` populated in 33.6% of RLIs, and a boolean `renewal` flag is populated 100% of the time (True 35.1% / False 64.9%) — roughly consistent in magnitude with the `renewal_rli_id` population rate.
- Both mechanisms co-exist in the data; this Sugar instance does not use a single consistent renewal pattern — **UNKNOWN which (if either) is authoritative without live SME/business confirmation (§21).**

**Multi-line ownership (counts only):**
- 18,752 Accounts have at least one RLI.
- 2,118 (11.3%) have exactly one RLI (single-line).
- 16,634 (88.7%) have 2+ RLIs — multi-line ownership is the norm, not the exception, in this dataset.
- Distribution is heavy-tailed (2 lines: 1,606 accounts; 10 lines: 789 accounts; many accounts with double digits of lines) — consistent with multi-product, multi-year renewal history per customer rather than clean single-subscription accounts.
- Overlapping-range / active+cancelled-pair analysis was **not completed** in this pass (would require parsing and comparing date ranges per account — flagged as a follow-up, not fabricated as "none found").

**Join quality summary (RLI-centric):**
| Join | Match | Null FK | Orphan |
|---|---|---|---|
| RLI → Opportunity → Account (via RLI.account_id directly) | 99.5% | 0.5% | <0.1% |
| RLI → Opportunity | 100.0% | ~0.0% | <0.01% |
| RLI → ProductCatalogue | 96.5% | 2.1% | 1.4% |

---

## 12. Subscription-state field candidates (confidence-rated, not authoritative)

| Field | Confidence as subscription-state signal | Why |
|---|---|---|
| RLI `sales_stage` (Closed Won / Closed Lost / Pending Cancellation / Closed Won Credited / etc.) | **MEDIUM** | Populated 94.8% of the time with CRM-pipeline-shaped values, but mixes sales-pipeline stages with what look like post-sale states ("Pending Cancellation", "Closed Won Credited") — plausible proxy for subscription lifecycle but not a clean enum. |
| RLI `status` | **LOW** | 99.5% null; populated values look like lead-qualification picklist values, not subscription states — likely wrong field or legacy carry-over. |
| RLI `renewal` (boolean) | **MEDIUM** | Clean boolean, 100% populated, directly relevant to lifecycle but only answers "is this a renewal," not "is this currently active." |
| ProductCatalogue `active_status` (Active/Inactive/Retired) | **MEDIUM, but describes the product, not the customer's line** | Could gate whether a line's product is still sellable, not whether the customer's subscription is active. |
| `date_support_expires` / `date_support_starts` | **UNKNOWN — field unused** | 100% null in this extract; cannot be evaluated. |

No field in this dataset is a confident, authoritative "is this subscription currently active" signal. **This must be confirmed with Juniper business stakeholders (§21), not inferred from the data alone.**

---

## 13. Timeline objects (Calls/Meetings/Notes/Emails) as future M10 Signals — NOT scoped into M8

Structural observations only (no PII, no content):
- Calls (109,451), Meetings (31,447), Notes (50,000 — this file appears truncated/sampled at exactly 50,000 rows, worth checking against the source system's real volume), Emails (10,694 parsed rows, despite a much larger raw byte size — email bodies are large and likely multi-line, which is why the true row count parses far lower than file size would suggest).
- Calls/Meetings use a polymorphic `parent_type`+`parent_id` pattern (can point at Accounts, Opportunities, Contacts, etc.) — common Sugar activity-stream design.
- Notes is unusual in carrying **direct** typed FK columns (`account_id`, `opportunity_id`, `contact_id`, `product_id`, `quote_id`, `lead_id`, `acase_id`) in addition to a polymorphic `parent_id`/`parent_type` — meaning Notes could, in principle, be a richer relationship signal than Calls/Meetings/Emails.
- These four objects are plausible future "M10 Signals" (engagement/activity signals) sources but are explicitly **not analyzed for M8 scope** per the brief, and no M8 design decision should rely on them yet.

## 14. Users vs canonical customer Persons

- 491 Users rows — these are **internal Sugar/Juniper staff accounts** (owners, sales reps, admins), not customer Persons. Confirmed by role: `assigned_user_id`, `created_by`, `modified_user_id` on every other table point into this 491-row table, and Users carries internal-system fields (`acl_role_set_id`, `business_center_id`, `customer_journey_access`, etc.) that have no customer-facing meaning.
- Canonical customer Persons should be sourced from **Contacts**, not Users. Conflating the two would misattribute internal staff as customers — a real risk if a naive "person" extraction joins the wrong table.

## 15. Aggregated data-quality metrics (counts/rates only — no raw values)

| Metric | Value |
|---|---|
| Accounts: duplicate `id` | 0 |
| Contacts: duplicate `id` | 59 of 153,946 (0.04%) |
| Opportunities: duplicate `id` | 4 of 164,813 (0.002%) |
| RevenueLineItems: duplicate `id` | 15 of 255,684 (0.006%) |
| Opportunities with null `account_id` (orphan source, not resolvable) | 1,259 of 164,813 (0.8%) |
| Contacts with null `account_id` | 15,380 of 153,946 (10.0%) |
| RLI with null `account_id` | 1,295 of 255,684 (0.5%) |
| RLI with orphaned `account_id` (non-null but no matching Account) | 110 (0.04%) |
| RLI with orphaned `opportunity_id` | ~10 (<0.01%) |
| RLI with unmapped `product_template_id` (non-null, no catalogue match) | 3,536 (1.4%) |
| RLI with null `product_template_id` | 5,447 (2.1%) |
| ProductCatalogue rows with duplicate `name` | 106 of 1,203 (8.8%) |
| RLI rows with `juniper_id_c`/`subscription_urn_c` populated | 0 of 255,684 (0%) — fields present but entirely unused |
| RLI rows with `deleted=True` (tombstones visible in this extract) | 0 of 255,684 — no tombstones observed in this full-load snapshot |
| File-size-vs-true-row-count distortion (parsing artifact, not a defect in the source data itself) | Naive line counts overstate true rows by up to ~12x on files with long multi-line text fields (e.g. Meetings: 381,027 raw lines vs 31,447 true rows) |

No raw customer values, revenue figures, PII, or credentials appear in this table or anywhere else in this document.

## 16. Historical full/incremental load behavior **[HISTORICAL CODE EVIDENCE]**

- Full sync: `scripts/full_sync/extract_*.py`, no date filter, intended to be run once.
- Delta sync: `scripts/delta_sync/extract_*.py`, filters `date_modified > last_sync_time` via `filter[date_modified][$gt]`. README documents per-module lookback windows of 7/14/90 days, implying delta scripts use a **rolling lookback window**, not a persisted checkpoint cursor — i.e., "give me everything modified in the last N days" rather than "give me everything since the last successful run's watermark." This is a meaningful distinction: a rolling window is more resilient to a missed run (re-fetches overlap) but can silently miss changes if the sync has been down longer than the window, and can't detect a `date_modified` field that fails to update on every real change.
- Pagination restart: the client's pagination loop has no persisted offset checkpoint — if a run fails mid-table, the whole table's pull restarts from offset 0 on next invocation (no partial-resume).
- Retries: token-expiry retry exists (one retry, re-auth). No generic exponential-backoff retry for 5xx/429 was found in `sugarcrm_client.py` itself.
- Tombstones: no explicit soft-delete/tombstone-aware fetch logic found; `deleted` is a normal field in the payload, and in this particular full-load CSV snapshot no `deleted=True` rows are present at all for RLI (0 of 255,684) — meaning this snapshot cannot be used to validate how the historical pipeline would actually handle a deletion in practice.

## 17. Sugar→S3/Gainsight pipeline — reuse classification

| Pipeline stage | Classification | Rationale |
|---|---|---|
| OAuth2 password-grant auth + token refresh | **REUSE KNOWLEDGE** | Correct against current docs; the pattern (not necessarily this exact code) is sound. |
| Offset/limit pagination with `date_modified` ordering | **REUSE KNOWLEDGE** | Matches current docs; straightforward to reimplement idiomatically on the platform. |
| Rolling-window delta sync (7/14/90-day lookback, no persisted checkpoint) | **REWRITE FOR PLATFORM** | Works, but a real watermark/checkpoint design is safer and is almost certainly how the platform's other connectors already behave — should not be copied as-is. |
| Config-driven field-mapping YAML | **REUSE KNOWLEDGE** | A genuinely good idea (declarative field mapping with per-field transform/validation) worth carrying forward conceptually, not necessarily the YAML schema verbatim. |
| CSV generation + S3 file-drop to Gainsight | **DO NOT REUSE** | This is a point-to-point legacy integration target (Gainsight via S3 CSV), not the platform's own ingestion path; the platform presumably ingests via its own connector framework, not CSV-to-S3. |
| Retry/backoff behavior | **REWRITE FOR PLATFORM** | Only handles 401; no general backoff — platform connector framework should supply its own retry policy rather than inherit this gap. |
| `.env`-or-environment-variable credential loading | **REUSE KNOWLEDGE** | Sound, container-friendly pattern; trivial to match in any modern connector config loader. |

## 18. Canonical-mapping-candidate tables (NOT modifying any canonical model; repo unavailable)

| Sugar concept | Candidate platform target | Confidence |
|---|---|---|
| Account | Account/Organization | **STRONG CANDIDATE** — clean PK, high join rates into every other entity. |
| Contact | Person | **STRONG CANDIDATE** for the 90% with an Account link; **WEAK CANDIDATE** for the 10% without one. |
| Opportunity | Deal / Order-adjacent event, NOT Subscription itself | **STRONG CANDIDATE** as a deal-event source; **NOT APPROPRIATE** as a direct 1:1 Subscription source given it mixes pipeline and entitlement fields. |
| RevenueLineItem | Subscription line item | **STRONG CANDIDATE** for an *individual line* representation; **WEAK CANDIDATE** for a clean lifecycle-state source (see §12) without further normalization. |
| ProductCatalogue | Product/Plan | **STRONG CANDIDATE** via `id`; **NOT APPROPRIATE** via `name` (8.8% duplicate names). |
| Calls/Meetings/Notes/Emails | Signal/Activity (future M10) | **WEAK CANDIDATE today, intentionally out of scope for M8.** |
| User | Internal actor / owner reference, NOT a canonical Person | **CONFIRMED BY DATA** as internal-only (see §14) — must not be mapped to customer Person. |

All of the above are candidates evaluated against the data's own shape, not against the platform's real canonical model (unavailable). **Do not treat this table as validated against the actual Revenue Opportunity Intelligence schema.**

## 19. Connector capability assessment

| Capability | Assessment |
|---|---|
| `testConnection` | **SUPPORTED BY OLD CODE** (`/ping` with bearer token) |
| `describeSchema` | **SUPPORTED BY OLD CODE** (`GET /{module}/fields`); **CURRENT DOCS SUPPORT** likely but not independently re-verified against a live tenant in this pass |
| `readRecords` (list/paginated) | **SUPPORTED BY OLD CODE**, offset pagination + date filter |
| `readRecord` (single) | **UNSUPPORTED BY OLD CODE** (not exercised); **CURRENT DOCS SUPPORT** (standard REST `GET /{module}/{id}` exists in the API family) — **NEEDS LIVE VERIFICATION** to confirm on the actual tenant/version |
| `capabilities`/version negotiation | **UNKNOWN** — old code hardcodes a base URL containing the version string (`/rest/v11_20`) rather than negotiating; no capability-discovery call found |

## 20. Schema discovery capability (current docs)

The `/{module}/fields` pattern used by the historical client aligns with Sugar's documented metadata/field-description endpoints referenced in the Sugar Developer Guide's Web Services / REST API sections (12.1–14.2 lineage cited in §3). Treat as **CURRENT DOCS SUPPORT — NEEDS LIVE VERIFICATION** for the exact response shape on this tenant's actual API version.

## 21. Source-authority classification

Per the brief's A/B/C framing, source authority is assessed **not assumed**:
- Sugar is the **system of record for sales-process state** (Opportunities) and for the only observed Account/Contact/Product master data in this dataset — strong authority there.
- Sugar is **NOT confirmed as the authoritative source for subscription lifecycle state** — the two most plausible state fields (`sales_stage`, RLI `status`) are either overloaded/ambiguous or near-fully-empty-and-wrongly-populated (§12). Authority for "is this subscription active" cannot be granted to Sugar on this evidence alone.
- Classification: **Authority is CONDITIONAL / SPLIT** — strong for identity and deal data, weak/unconfirmed for subscription-state truth. This is not a clean A, B, or C in isolation; see §24 for the overall verdict, which weighs this explicitly.

## 22. Full-load completeness estimation

- This is a documented **full-load snapshot** (filenames contain `SYNC` and no delta markers; `full_sync.sh` describes full loads as "all historical data"). Row counts above should represent the complete Sugar dataset as of the export date, **assuming** no silent pagination truncation occurred during the original export (not verifiable from the CSV alone — would require comparing against Sugar's own record counts live).
- The zero observed `deleted=True` rows across RLI is consistent with either (a) a true absence of deletions, or (b) the export filtering out deleted records entirely (common Sugar API default behavior unless `deleted` filter is explicitly overridden) — **cannot distinguish between these from the data alone; needs live verification.**

---

## 23. Synthetic fixtures (sanitized)

See `/fixtures/sugarcrm/sanitized/` — 16 scenario files, fully fabricated IDs/names/values, structurally matching the discovered schemas (narrowed to the fields relevant to each scenario). None of these rows are copies or renamed-reals of any Juniper record.

Scenarios covered (file names mirror the brief's 16-point list): normal_case, several_products, multiple_lines_same_product, renewal, expired_plus_active_renewal, cancelled, unknown_status, future_dated_line, orphan_opportunity, orphan_product, duplicate_source_line, missing_product_id, conflicting_dates, deleted_tombstoned_record, one_time_product_line, recurring_product_line.

## 24. REQUIRES FUTURE LIVE SUGARCRM ACCESS

- Confirm current API major version actually in use on the Juniper tenant (vs. `v11_20` placeholder).
- Verify `readRecord` (single), capability/version negotiation, and real rate-limit/retry behavior server-side.
- Verify whether the zero-tombstone observation in this export reflects true data or an API-level `deleted` filter default.
- Confirm whether `juniper_id_c`/`subscription_urn_c` are dead fields tenant-wide or were simply unpopulated in this particular export window.
- Confirm live schema for Calls/Meetings/Notes/Emails `parent_type` enumerations and their true join rates (not measured in this pass).

## 25. REQUIRES JUNIPER BUSINESS CONFIRMATION (not a data question)

- Which field(s), if any, Juniper's revenue/CS team actually treats as "is this subscription active right now" — the data does not contain a confident answer (§12).
- Whether renewals are operationally created as new Opportunities, new RLIs, updated RLIs, or some mix — both patterns coexist in the data at similar magnitudes (~34%) and only business process knowledge can resolve which is authoritative, if either.
- Business meaning of `recurring_one_off_c`'s three overlapping values and whether "Non Recurring" and "One Off" are meant to be distinct.
- Confirm whether the 10% of Contacts with no Account link are legitimately orphaned (e.g. leads not yet converted) or a data-quality defect.

## 26. M8 design implications

| Implication | Classification |
|---|---|
| Account is a safe, strong identity anchor | **READY TO DESIGN** |
| RLI is the right line-level granularity to model as Subscription source lines | **READY TO DESIGN**, conditioned on accepting PARTIALLY (not YES) for 1:1 cleanliness |
| Subscription lifecycle/state derivation from Sugar fields alone | **NEEDS JUNIPER BUSINESS CONFIRMATION** before any mapping is finalized |
| Renewal detection logic (which linkage field to trust) | **NEEDS JUNIPER BUSINESS CONFIRMATION** |
| Product identity via catalogue `id` (not `name`) | **READY TO DESIGN** |
| Exact connector capability surface (single-record read, capability negotiation) | **NEEDS LIVE SUGAR CONFIRMATION** |
| Incremental sync checkpoint strategy | **READY TO DESIGN as a rewrite** — do not copy the rolling-window approach; design a real watermark instead |

## 27. Future UI/configurability implications (no UI built)

- Field-mapping-as-config (YAML in the historical code) suggests end users/admins would benefit from a configurable mapping UI rather than hardcoded transforms, if the platform doesn't already have one.
- Given RLI's state ambiguity, any future admin UI should expose which state-field mapping is active and let an admin override/confirm it per tenant, rather than hardcoding one Sugar field as canonical truth.
- A reconciliation/orphan report (accounts/products/opportunities failing to join) would be a natural configurability/observability surface, since real orphan/null rates here are non-trivial (10% Contacts, 1.4% RLI→Product orphans).

---

## 28. Final verdict

**B** — Sugar is a usable, non-trivial source with strong identity/account/product anchoring and real line-level revenue data, but it is **not** a clean, self-sufficient source of subscription-lifecycle truth: the candidate state fields are either ambiguous (`sales_stage`) or effectively unusable (`status`, `juniper_id_c`, `subscription_urn_c`), and two renewal-tracking mechanisms coexist without a confirmed authoritative one. M8 design can proceed on identity/product/line-level grounds now, but subscription-state and renewal-authority decisions require Juniper business confirmation before being treated as settled, and several connector-capability questions require live Sugar access before being treated as settled. This is not a clean "A" (fully sufficient, ready now) nor a "C" (fundamentally unsuitable) — the evidence is genuinely mixed and tilts toward "workable with explicit confirmation steps," which the brief's A/B/C scheme is read here as naming "B."
