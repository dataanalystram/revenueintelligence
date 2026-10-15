import { GovernanceError } from '../modules/governance';

/**
 * A `--starts-at` / `--ends-at` value: an ISO-8601 date (`2026-01-01`, read as
 * UTC midnight) or an instant with an explicit zone (`Z` or `+hh:mm` /
 * `-hh:mm`). A zone-less date-time would be read in the server's local zone,
 * so it is refused as `validation_failed` (review n6).
 */
export function cliDate(value: string | undefined, flag: string): Date | undefined {
  if (value === undefined) return undefined;
  const d = new Date(value);
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const zonedInstant = /^\d{4}-\d{2}-\d{2}T\S+(Z|[+-]\d{2}:\d{2})$/.test(value);
  if (!(dateOnly || zonedInstant) || Number.isNaN(d.getTime())) {
    throw new GovernanceError(
      'validation_failed',
      `${flag} must be an ISO-8601 date or an instant with a zone`,
    );
  }
  return d;
}
