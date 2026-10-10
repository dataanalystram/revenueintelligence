/**
 * Secret-like value detection (M10A1 plan §11, owner decision Q5).
 *
 * The guarantee that secrets are not stored is structural: they live in the
 * SecretProvider, and the database holds secret names and ciphertext only.
 * This detector is a second, best-effort line on free-text and JSON values.
 * It uses explicit patterns only: no entropy heuristic, which would refuse
 * legitimate long identifiers. It returns a pattern code, never the value.
 */
export const SECRET_PATTERNS = [
  { code: 'pem_private_key', pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  {
    code: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  },
  { code: 'bearer_token', pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/i },
  { code: 'aws_access_key', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { code: 'stripe_key', pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/ },
  { code: 'slack_token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  {
    code: 'github_token',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})/,
  },
  {
    code: 'hubspot_private_app_token',
    pattern: /\bpat-(?:na|eu|ap)\d-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/,
  },
  { code: 'chargebee_api_key', pattern: /\b(?:live|test)_[A-Za-z0-9]{24,}\b/ },
  { code: 'google_api_key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { code: 'url_credentials', pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]+@/i },
  {
    code: 'credential_assignment',
    pattern:
      /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)\s*[:=]\s*\S{4,}/i,
  },
] as const satisfies readonly { code: string; pattern: RegExp }[];

export type SecretPatternCode = (typeof SECRET_PATTERNS)[number]['code'];

/** The first matching pattern code, or `undefined`. Never returns or logs the value. */
export function findSecretLike(value: string): SecretPatternCode | undefined {
  for (const { code, pattern } of SECRET_PATTERNS) {
    if (pattern.test(value)) return code;
  }
  return undefined;
}

/** Every string leaf of a JSON value that looks like a secret, as `path → code`. */
export function findSecretLikeInJson(
  value: unknown,
  path = '$',
): readonly { readonly path: string; readonly code: SecretPatternCode }[] {
  if (typeof value === 'string') {
    const code = findSecretLike(value);
    return code === undefined ? [] : [{ path, code }];
  }
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => findSecretLikeInJson(v, `${path}[${i}]`));
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => {
      // Keys are scanned too; a secret-shaped key never appears in a path.
      const keyCode = findSecretLike(k);
      const segment = keyCode === undefined ? `${path}.${k}` : `${path}.[key]`;
      return [
        ...(keyCode === undefined ? [] : [{ path: segment, code: keyCode }]),
        ...findSecretLikeInJson(v, segment),
      ];
    });
  }
  return [];
}

/** Raised when an operator or configuration write carries a secret-like value. */
export class SecretLikeValueError extends Error {
  constructor(
    readonly field: string,
    readonly code: SecretPatternCode,
  ) {
    super(
      `Refused: ${field} looks like a credential (${code}); secrets belong in the secret store`,
    );
    this.name = 'SecretLikeValueError';
  }
}

/** Throws SecretLikeValueError when `value` matches a pattern. */
export function assertNotSecretLike(field: string, value: string | undefined | null): void {
  if (value === undefined || value === null) return;
  const code = findSecretLike(value);
  if (code !== undefined) throw new SecretLikeValueError(field, code);
}
