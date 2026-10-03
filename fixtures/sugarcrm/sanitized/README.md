# Synthetic SugarCRM Fixtures

All data in this directory is **fabricated** for structural testing. No IDs, names, dates, or amounts are copied or derived from the real Juniper CSV extracts. Column sets are narrowed to the fields relevant to each scenario, structurally matching the discovered schemas documented in `docs/discovery/sugarcrm-local-evidence.md`.

Each file is a small CSV with: `accounts.csv`-style Account rows, `opportunities.csv`-style Opportunity rows, and `revenue_line_items.csv`-style RLI rows, as relevant to the scenario. IDs use the `FIX-<entity>-<nn>` convention to make them obviously synthetic.

| # | File | Scenario |
|---|---|---|
| 1 | 01_normal_case.csv | Single account, one opportunity, one clean recurring RLI, fully joined |
| 2 | 02_several_products.csv | One account/opportunity with 3 RLIs across 3 distinct products |
| 3 | 03_multiple_lines_same_product.csv | One account with 2 RLIs referencing the same product_id |
| 4 | 04_renewal.csv | Two RLIs linked via renewal_rli_id, second with later service dates |
| 5 | 05_expired_plus_active_renewal.csv | One expired RLI (end date in the past) plus one active renewal (future end date) |
| 6 | 06_cancelled.csv | RLI with sales_stage = Pending Cancellation and a cancellation date |
| 7 | 07_unknown_status.csv | RLI with an unrecognized/blank status value |
| 8 | 08_future_dated_line.csv | RLI whose service_start_date is in the future relative to date_entered |
| 9 | 09_orphan_opportunity.csv | Opportunity row with a non-existent account_id |
| 10 | 10_orphan_product.csv | RLI row with a product_template_id that matches no product |
| 11 | 11_duplicate_source_line.csv | Two RLI rows sharing the same id (duplicate) |
| 12 | 12_missing_product_id.csv | RLI row with empty product_template_id |
| 13 | 13_conflicting_dates.csv | RLI where service_end_date is earlier than service_start_date |
| 14 | 14_deleted_tombstoned_record.csv | RLI row with deleted = True |
| 15 | 15_one_time_product_line.csv | RLI with recurring_one_off_c = One Off, renewable=False |
| 16 | 16_recurring_product_line.csv | RLI with recurring_one_off_c = Recurring, renewable=True, mrr_c populated |
