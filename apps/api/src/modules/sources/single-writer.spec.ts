import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Every source file of the sources module (no specs). */
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return name.endsWith('.ts') && !name.endsWith('.spec.ts') ? [path] : [];
  });
}

/**
 * Single-writer rule (ADR 0014, ADR 0017, ADR 0020): source synchronisation
 * reaches canonical tables only through ContextIngestionService and
 * SubscriptionIngestionService. The sources module may read references but
 * never writes canonical rows or provenance itself.
 */
describe('sources module: single canonical writers', () => {
  it('never writes canonical tables or provenance directly', () => {
    const offenders: string[] = [];
    const canonical =
      /\.(tenantSubscription|tenantContextChange|company|person|companyExternalRef|personExternalRef|tenantSourceRelationship|tenantOwnershipGap)\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\b/;
    for (const file of files(resolve(__dirname))) {
      const text = readFileSync(file, 'utf8');
      if (canonical.test(text) || /\$executeRaw|\$queryRaw/.test(text)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
