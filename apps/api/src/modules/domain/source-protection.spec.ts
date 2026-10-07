import { describe, expect, it } from 'vitest';
import { SKIP_CODES } from './source-mapping-engine';
import { failsRunWhenUnattributable, mayTombstone, protectionFor } from './source-protection';

describe('seen-but-rejected protection decisions (M9A §9.2)', () => {
  it('confident exclusions are not protected (tombstoning stays correct)', () => {
    for (const code of ['filtered_out', 'non_subscription_product']) {
      expect(protectionFor(code)).toEqual({ protect: false, class: 'confident_exclusion' });
    }
  });

  it('reference-integrity skips are protected with their gap reasons', () => {
    expect(protectionFor('missing_account_reference')).toMatchObject({
      protect: true,
      class: 'reference_integrity',
      gapReason: 'observation_rejected',
    });
    expect(protectionFor('orphan_account_reference')).toMatchObject({
      protect: true,
      gapReason: 'account_reference_orphaned',
    });
    expect(protectionFor('missing_product_reference')).toMatchObject({
      gapReason: 'missing_product_reference',
    });
    expect(protectionFor('orphan_product_reference')).toMatchObject({
      gapReason: 'orphan_product_reference',
    });
  });

  it('value rejections are protected and fail the run when unattributable', () => {
    for (const code of [
      'invalid_observation',
      'record_rejected',
      'missing_identity',
      'malformed_row',
    ]) {
      const d = protectionFor(code);
      expect(d).toMatchObject({
        protect: true,
        class: 'value_rejection',
        gapReason: 'observation_rejected',
      });
      expect(failsRunWhenUnattributable(d)).toBe(true);
    }
    expect(protectionFor('unreviewed_holding_value')).toMatchObject({
      protect: true,
      class: 'value_rejection',
      gapReason: 'holding_filter_value_unreviewed',
    });
  });

  it('an unknown or future rejection code is protected by default, never deleted', () => {
    for (const code of ['some_future_code', '', 'schema_variant_rejected']) {
      expect(protectionFor(code)).toMatchObject({
        protect: true,
        gapReason: 'observation_rejected',
      });
    }
  });

  it('reference-integrity skips do not fail the run when unattributable (M8 handling kept)', () => {
    expect(failsRunWhenUnattributable(protectionFor('orphan_account_reference'))).toBe(false);
    expect(failsRunWhenUnattributable(protectionFor('missing_account_reference'))).toBe(false);
  });

  it('every engine skip code has an explicit decision consistent with the plan table', () => {
    for (const code of SKIP_CODES) {
      const d = protectionFor(code);
      if (code === 'non_subscription_product') expect(d.protect).toBe(false);
      else expect(d.protect).toBe(true);
    }
  });

  it('tombstones only keys in neither set', () => {
    const holding = new Set(['RLI|1']);
    const rejected = new Set(['RLI|2']);
    expect(mayTombstone('RLI|1', holding, rejected)).toBe(false);
    expect(mayTombstone('RLI|2', holding, rejected)).toBe(false);
    expect(mayTombstone('RLI|3', holding, rejected)).toBe(true);
  });
});
