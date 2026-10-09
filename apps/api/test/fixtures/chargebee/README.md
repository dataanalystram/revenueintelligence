# Chargebee TEST fixtures (M9B)

TEST configuration only — not a Juniper decision and not evidence of any real
Chargebee site.

- `mapping.test.json`: the versioned TEST mapping for the fake Chargebee
  (`test/support/fake-chargebee.ts`).
  - Accounts ← `Customers` (`id`).
  - Subscription lines ← the derived `SubscriptionItems` child set, identity
    `line_key_item_price` (`<subscription_id>:<item_price_id>`). This is the
    approved fallback until live check V3 proves an item cannot repeat within
    a subscription; switching to `line_key_item` is a new mapping version
    (governed), never a runtime switch.
  - Product ← `item_id` (Product = Chargebee Item), catalogue `Items`;
    `addon-legacy` ignored (CB18).
  - Holding filter `item_type in [plan, addon]` with a reviewed domain
    (`charge` and empty are non-holding, CB16).
  - State through the versioned value map of the M9B plan (B3):
    `active→active`, `in_trial→trial`, `non_renewing→active`,
    `cancelled→cancelled`, `future|paused|transferred→unknown`, any other
    value `unknown`. Never inferred from dates.
  - Terms ← `current_term_start` / `current_term_end` via the generic
    `timestamp`/`unix_seconds` parse (UTC seconds, F18).
  - The reviewed domain's `snapshotHash` is a placeholder; tests and runtime
    scripts stamp the captured snapshot hash before publishing.
