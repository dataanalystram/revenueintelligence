const REDACTED = '[REDACTED]';

/**
 * Wraps a secret value so it cannot be accidentally serialised or logged.
 * Call `reveal()` only at the point of use (e.g. building an HTTP header).
 */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `Secret(${REDACTED})`;
  }
}
