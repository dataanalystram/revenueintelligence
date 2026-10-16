import { describe, expect, it } from 'vitest';
import { COMMERCIAL_VIEW_CLASSIFICATION } from '../../commercial';
import { CLASSIFICATION_MANIFEST } from './classification-manifest';

/**
 * M10F (plan §7, §10): every attribute a commercial read view carries is
 * classified exactly as the manifest classifies its backing column, and every
 * confidential column of the three tables that a view carries is confidential
 * in the view (so the read model withholds it by default, V20).
 */
const TABLES = {
  price_offer: 'tenant_price_offers',
  contract: 'tenant_contracts',
  entitlement: 'tenant_entitlements',
} as const;

describe('M10F commercial read-model classification = manifest', () => {
  it.each(Object.entries(TABLES))(
    '%s view attributes carry the manifest sensitivity',
    (entity, table) => {
      const manifest = CLASSIFICATION_MANIFEST[table]!;
      const view = COMMERCIAL_VIEW_CLASSIFICATION[entity as keyof typeof TABLES];
      for (const [attr, { column, sensitivity }] of Object.entries(view)) {
        expect(manifest[column], `${table}.${column} (${attr})`).toBeDefined();
        expect(sensitivity, `${table}.${column}`).toBe(manifest[column]!.sensitivity);
      }
    },
  );

  it('the confidential columns are exactly the plan §7 financial ones, and each is in a view', () => {
    const confidential = Object.entries(TABLES).flatMap(([, table]) =>
      Object.entries(CLASSIFICATION_MANIFEST[table]!)
        .filter(([, c]) => c.sensitivity === 'confidential' || c.sensitivity === 'restricted')
        .map(([column]) => `${table}.${column}`),
    );
    expect(confidential.sort()).toEqual([
      'tenant_contracts.renewal_date',
      'tenant_contracts.total_value_currency',
      'tenant_contracts.total_value_minor',
      'tenant_price_offers.list_amount_minor',
    ]);
    const viewed = Object.entries(TABLES).flatMap(([entity, table]) =>
      Object.values(COMMERCIAL_VIEW_CLASSIFICATION[entity as keyof typeof TABLES])
        .filter((v) => v.sensitivity === 'confidential')
        .map((v) => `${table}.${v.column}`),
    );
    expect(viewed.sort()).toEqual(confidential.sort());
  });
});
