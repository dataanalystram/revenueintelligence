import { GovernanceError } from '../modules/governance';

/** The `extension` CLI's commands (M10D plan §8). */
export const EXTENSION_CLI_COMMANDS = [
  'registry show',
  'values show',
  'value set',
  'value clear',
  'value release',
  'records list',
  'records show',
  'record create',
  'record update',
  'record retire',
  'record reactivate',
  'relationship add',
  'relationship end',
] as const;

/** `--set field=value` pairs; a repeated field is refused (no silent last-wins). */
export function parseAssignments(
  sets: readonly string[] | undefined,
  clears: readonly string[] | undefined = [],
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  const put = (field: string, value: string | null): void => {
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(field) || Object.hasOwn(out, field)) {
      throw new GovernanceError(
        'validation_failed',
        `--set / --clear field ${field} is invalid or repeated`,
      );
    }
    out[field] = value;
  };
  for (const s of sets ?? []) {
    const i = s.indexOf('=');
    if (i <= 0) throw new GovernanceError('validation_failed', '--set takes <field>=<value>');
    put(s.slice(0, i), s.slice(i + 1));
  }
  for (const c of clears) put(c, null);
  return out;
}

export function limitOf(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new GovernanceError('validation_failed', '--limit must be a positive integer');
  }
  return n;
}
