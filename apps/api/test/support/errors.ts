/** Every message along an error's cause chain (raw PostgreSQL text included). */
export function rawText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current && depth < 8; depth++) {
    const e = current as { message?: unknown; cause?: unknown };
    if (typeof e.message === 'string') parts.push(e.message);
    current = e.cause;
  }
  return parts.join(' | ');
}
