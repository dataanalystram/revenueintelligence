import { describe, expect, it } from 'vitest';
import {
  CANONICAL_VERSIONS,
  CANONICAL_VERSION_FEATURES,
  canonicalFeatureChanges,
} from './versions';

/** M10B plan §7: the adoption dry run lists what 0.2 enables (forward) or withdraws (rollback). */
describe('canonicalFeatureChanges', () => {
  const v02 = [
    'observed_generic_source_references',
    'evidence_links',
    'key_identified_change_records',
  ];

  it('every catalogue version declares its features', () => {
    expect(Object.keys(CANONICAL_VERSION_FEATURES).sort()).toEqual(
      CANONICAL_VERSIONS.map((v) => v.version).sort(),
    );
  });

  it('0.1 → 0.2 enables the M10B features; 0.2 → 0.1 withdraws them; same version nothing', () => {
    expect(canonicalFeatureChanges('0.1', '0.2')).toEqual({ enables: v02, disables: [] });
    expect(canonicalFeatureChanges('0.2', '0.1')).toEqual({ enables: [], disables: v02 });
    expect(canonicalFeatureChanges('0.2', '0.2')).toEqual({ enables: [], disables: [] });
  });
});
