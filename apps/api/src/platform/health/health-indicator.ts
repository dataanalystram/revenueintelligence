export const HEALTH_INDICATORS = Symbol('HEALTH_INDICATORS');

/** A dependency the service needs in order to be ready to take traffic. */
export interface HealthIndicator {
  readonly name: string;
  /** Resolves when healthy; rejects with a descriptive error otherwise. */
  check(): Promise<void>;
}
