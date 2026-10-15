import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { testMapping } from '../../../test/fixtures/source-mapping';
import {
  MAPPING_LIMITS,
  MappingDocumentSchema,
  mappingContentHash,
  type MappingDocument,
} from './source-mapping-document';
import { mappingMinCanonicalVersion, validateMapping } from './source-mapping';

/**
 * Stored mapping hashes at the M10C base (integration 5344d2e, computed there
 * with the same fixtures): the M10D limit raise (Q4) and the new entry kinds
 * never change the hash of an existing mapping, so nothing is republished.
 */
const M10C_MAPPING_HASHES = {
  'test/fixtures/chargebee/mapping.test.json':
    'f3e1186bd5fdca2e14e89a7b041d34d12b31d941a8ac4becb7ddb52fddc3c172',
  'test/fixtures/sugar/mapping.test.json':
    '851c08d6fd04b1d698214f0fe5f7930579904d55eb42b4323eac0efac0c8da1a',
  testMapping: 'c43729eb64475e7cf597a9e74b3aa421f188f3ec595e3930bb526b6656cb7887',
} as const;

const fixture = (path: string): unknown =>
  JSON.parse(readFileSync(resolve(path), 'utf8')) as unknown;

/** One object of `n` ignored fields (the cheapest valid entry). */
function wideObject(n: number): MappingDocument {
  const doc = structuredClone(testMapping());
  const account = doc.objects.find((o) => o.entity === 'account')!;
  (account as { fields: unknown[] }).fields = Array.from({ length: n }, (_, i) => ({
    kind: 'ignored',
    source: `F${i}`,
    reason: 'not_needed',
  }));
  return doc;
}

describe('M10D Q4: mapping limits widened (V23), existing mappings unchanged', () => {
  it('fieldsPerObject is 1,000 and documentBytes 1 MiB (raised from 300 / 256 KiB); the other limits are unchanged', () => {
    expect(MAPPING_LIMITS).toEqual({
      documentBytes: 1024 * 1024,
      objects: 20,
      fieldsPerObject: 1000,
      holdingValues: 200,
      ignoredProducts: 5000,
    });
  });

  it('an object of 1,000 field entries parses; 1,001 is refused (never truncated)', () => {
    expect(MappingDocumentSchema.safeParse(wideObject(1000)).success).toBe(true);
    // 301..1,000 was refused before M10D.
    expect(MappingDocumentSchema.safeParse(wideObject(301)).success).toBe(true);
    const over = MappingDocumentSchema.safeParse(wideObject(1001));
    expect(over.success).toBe(false);
    expect(over.error!.issues.map((i) => i.path.join('.'))).toContain('objects.0.fields');
  });

  it('a document between 256 KiB and 1 MiB is not too large; above 1 MiB it is refused before parsing', () => {
    const ctx = {} as Parameters<typeof validateMapping>[1];
    const oversize = { objects: [{ source: 'X'.repeat(MAPPING_LIMITS.documentBytes) }] };
    const r = validateMapping(oversize, ctx);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors.map((e) => e.code)).toEqual(['document_too_large']);
    // 300 KiB (above the old 256 KiB cap): reaches schema validation, not the size refusal.
    const mid = { objects: [{ source: 'X'.repeat(300 * 1024) }] };
    const m = validateMapping(mid, ctx);
    expect(!m.ok && m.errors.map((e) => e.code)).not.toContain('document_too_large');
  });

  it('existing mappings hash exactly as at M10C and still need no canonical version above 0.3', () => {
    for (const path of [
      'test/fixtures/chargebee/mapping.test.json',
      'test/fixtures/sugar/mapping.test.json',
    ] as const) {
      const doc = MappingDocumentSchema.parse(fixture(path));
      expect(mappingContentHash(doc), path).toBe(M10C_MAPPING_HASHES[path]);
      expect([undefined, '0.1', '0.2', '0.3'], path).toContain(mappingMinCanonicalVersion(doc));
    }
    const doc = MappingDocumentSchema.parse(testMapping());
    expect(mappingContentHash(doc)).toBe(M10C_MAPPING_HASHES.testMapping);
    expect([undefined, '0.1', '0.2', '0.3']).toContain(mappingMinCanonicalVersion(doc));
  });
});
