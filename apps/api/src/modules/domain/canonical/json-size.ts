/**
 * Size of a JSON value as PostgreSQL stores and prints it in a `jsonb`
 * column, in UTF-8 bytes (M10A2 review m6).
 *
 * The 4 KB limits on value history, module configuration and registry
 * documents are byte limits, but `JSON.stringify(v).length` counts UTF-16
 * code units with no separators: 'é' counts 1 (2 bytes in UTF-8) and '😀'
 * counts 2 (4 bytes). This helper renders the value the way jsonb's text
 * output does — `": "` between key and value, `", "` between members and
 * elements — and measures its UTF-8 encoding (`TextEncoder`, as the audit-details limit
 * does; identical to `Buffer.byteLength(…, 'utf8')` and free of Node globals).
 *
 * It is a close approximation that errs on the high side, which is the safe
 * direction for a limit: string escaping follows `JSON.stringify` (jsonb
 * prints non-ASCII characters literally, as here); finite numbers are printed
 * in plain decimal form as PostgreSQL's `numeric` output does — never with an
 * exponent, so 1e300 is 301 digits and 1e-7 is `0.0000001` (review n1) —
 * and non-finite numbers as `null`, as `JSON.stringify` does; duplicate keys are not collapsed and key order is not normalised
 * (neither changes the size except to shrink it). `undefined` members are
 * dropped and `undefined`/functions at the root count as `null`, as
 * `JSON.stringify` does.
 */
const UTF8 = new TextEncoder();

export function jsonbTextBytes(value: unknown): number {
  return UTF8.encode(jsonbText(value)).length;
}

/** The jsonb-style text rendering measured by {@link jsonbTextBytes}. */
export function jsonbText(value: unknown): string {
  return render(value) ?? 'null';
}

function render(value: unknown): string | undefined {
  if (value === null) return 'null';
  if (
    value !== undefined &&
    typeof value === 'object' &&
    typeof (value as { toJSON?: unknown }).toJSON === 'function'
  ) {
    return render((value as { toJSON: () => unknown }).toJSON());
  }
  switch (typeof value) {
    case 'number':
      return plainNumber(value);
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'bigint':
      return value.toString();
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((v) => render(v) ?? 'null').join(', ')}]`;
      }
      const members: string[] = [];
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        const r = render(v);
        if (r !== undefined) members.push(`${JSON.stringify(k)}: ${r}`);
      }
      return `{${members.join(', ')}}`;
    }
    default:
      return undefined;
  }
}

/**
 * A finite number in plain decimal form, the way PostgreSQL prints the
 * `numeric` it parsed from JavaScript's shortest round-trip rendering: an
 * exponent form (`1e+300`, `1.5e-7`) is expanded into its digits.
 */
export function plainNumber(n: number): string {
  if (!Number.isFinite(n)) return 'null';
  const s = String(n);
  const m = /^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/.exec(s);
  if (!m) return s;
  const [, sign, int, frac = '', exp] = m as unknown as [
    string,
    string,
    string,
    string | undefined,
    string,
  ];
  const digits = int + frac;
  const point = int.length + Number(exp);
  if (point <= 0) return `${sign}0.${'0'.repeat(-point)}${digits}`;
  if (point >= digits.length) return sign + digits + '0'.repeat(point - digits.length);
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}
