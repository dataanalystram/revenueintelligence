/**
 * Loads the sanitized Sugar discovery fixtures (fixtures/sugarcrm/sanitized,
 * kept verbatim as evidence) as source records. Synthetic data only.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SourceRecord } from '../../src/modules/domain';

export const DISCOVERY_DIR = resolve(__dirname, '../../../../fixtures/sugarcrm/sanitized');

/** Minimal CSV reader for the fixture files (no quoted fields in them; asserted). */
export function readCsv(path: string): Record<string, string>[] {
  const text = readFileSync(path, 'utf8');
  if (text.includes('"')) throw new Error(`quoted CSV not supported: ${path}`);
  const [header, ...lines] = text.trim().split(/\r?\n/);
  const columns = header!.split(',');
  return lines.map((line) => {
    const cells = line.split(',');
    if (cells.length !== columns.length) throw new Error(`ragged row in ${path}`);
    return Object.fromEntries(columns.map((c, i) => [c, cells[i]!]));
  });
}

/** `YYYY-MM-DD` (fixture `date_modified`) as a UTC instant. */
function modified(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  return new Date(/T/.test(value) ? value : `${value}T00:00:00Z`);
}

export function toSourceRecord(object: string, row: Record<string, string>): SourceRecord {
  return {
    object,
    id: row.id!,
    ...(modified(row.date_modified) ? { modifiedAt: modified(row.date_modified)! } : {}),
    ...(row.deleted === 'True' ? { deleted: true } : {}),
    values: Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v === '' ? null : v])),
  };
}

/** Every discovery fixture by number (`01`…`16`), as records of its object. */
export function discoveryFixture(no: string): SourceRecord[] {
  const file = readdirSync(DISCOVERY_DIR).find((n) => n.startsWith(`${no}_`));
  if (!file) throw new Error(`no fixture ${no}`);
  const object = no === '09' ? 'Opportunities' : 'RevenueLineItems';
  return readCsv(resolve(DISCOVERY_DIR, file)).map((row) => toSourceRecord(object, row));
}

export function allDiscoveryFixtures(): Map<string, SourceRecord[]> {
  const out = new Map<string, SourceRecord[]>();
  for (let i = 1; i <= 16; i += 1) {
    const no = String(i).padStart(2, '0');
    out.set(no, discoveryFixture(no));
  }
  return out;
}
