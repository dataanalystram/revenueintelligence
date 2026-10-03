# SugarCRM live verification gate (Milestone 8)

**LIVE SUGAR VERIFICATION: PENDING**

M8 is implemented and verified against a deterministic fake built from the
sanitized discovery evidence (`fixtures/sugarcrm/sanitized/`) and synthetic
companion fixtures (`apps/api/test/fixtures/sugar/`). Nothing below has been
checked against the customer's Sugar tenant. **No tenant may enable a real
Sugar connection until every row is recorded here as verified** (ADR 0021).

Run only with Juniper-approved **read-only** credentials, registered as one
credential name for the tenant (`tenant.<slug>.sugar.<name>`, a JSON bundle
`{clientId, clientSecret, username, password}`) and resolved only through the
SecretProvider. Never paste credentials into chat, tickets or this file.

| #   | Item                                                                                      | How to verify (read-only)                                                       | Status  | Evidence |
| --- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------- | -------- |
| 1   | API version in use (`v11_20` is a placeholder)                                            | `sources:test`; `/ping` with the configured `apiVersion`                        | PENDING |          |
| 2   | Auth: password grant permitted; refresh-token grant; token lifetime; `platform` parameter | transport counters (`tokenPost`), token expiry vs `expires_in`                  | PENDING |          |
| 3   | `/ping` connection test                                                                   | `sources:test` → `code: ok`                                                     | PENDING |          |
| 4   | `GET /{Module}/fields` response shape (inline enum options or dropdown names)             | `sources:schema --capture --execute`; compare with `fields-v1.json` shape       | PENDING |          |
| 5   | Module and field API names (product catalogue: `ProductCatalog` vs `ProductTemplates`)    | snapshot objects/fields                                                         | PENDING |          |
| 6   | Permissions: read only, mapped modules and metadata only                                  | Sugar role review with Juniper                                                  | PENDING |          |
| 7   | List reads: `fields`, `filter`, `order_by=date_modified:ASC,id:ASC`, `max_num`, `offset`  | `mappings:preview`; full run on a small window                                  | PENDING |          |
| 8   | `GET /{Module}/count` (full-read proof) or keyset paging                                  | full run passes count reconciliation; else coverage cannot be certified         | PENDING |          |
| 9   | `date_modified` precision, time zone, updated on every change                             | compare records before/after an edit; incremental overlap sizing                | PENDING |          |
| 10  | `GET /{Module}/{id}` (optional capability)                                                | single read of a known id                                                       | PENDING |          |
| 11  | Rate limits, `Retry-After`, 5xx behaviour                                                 | observe `lip_source_retries`; tune `rateLimit`                                  | PENDING |          |
| 12  | Delete visibility (`deleted = true` rows, filters)                                        | until proven: capability `none`; deletions only via the full-run tombstone pass | PENDING |          |
| 13  | Duplicate ids returned by the API (vs export artefacts)                                   | `duplicate_external_id` count on a full run                                     | PENDING |          |
| 14  | Current schema and custom fields (`juniper_id_c`, `subscription_urn_c` populated?)        | snapshot fields; never assumed                                                  | PENDING |          |
| 15  | Live counts vs a full run (accounts, lines, products)                                     | run quality counts vs Sugar counts                                              | PENDING |          |
| 16  | Read-only proof                                                                           | transport counters: only GET + token POST; `refused = 0`                        | PENDING |          |

## Separate business gate (Juniper decisions, not data questions)

Each is configuration (mapping document or authority), never code. Until
confirmed, the mapping keeps the safe default.

| Decision                                                        | Safe default until confirmed                          | Status  |
| --------------------------------------------------------------- | ----------------------------------------------------- | ------- |
| Which RLIs are holdings (holding filter field, values)          | no authority over `subscription_lines` (sync refused) | PENDING |
| Which date pair is the service term; time zone; inclusive end   | `explicit: null` (terms empty)                        | PENDING |
| Whether any field means "active"                                | `subscription.state` `explicit: unknown`              | PENDING |
| Renewal semantics (`renewal_rli_id`, `renewal`, parent)         | `ignored` (`semantics_unconfirmed`)                   | PENDING |
| Non-subscription products (ignore list)                         | unmodelled products fail the run (configuration gap)  | PENDING |
| Contacts without accounts                                       | Contacts not mapped                                   | PENDING |
| Opportunity account as fallback for a line's missing account    | no `fallbackVia`                                      | PENDING |
| Authority for `subscription_lines`, `subscription_terms`, state | unassigned / `import`                                 | PENDING |
