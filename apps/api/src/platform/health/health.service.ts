import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config';
import { HEALTH_INDICATORS, type HealthIndicator } from './health-indicator';

export type CheckStatus = 'up' | 'down';

export interface CheckResult {
  readonly status: CheckStatus;
  readonly latencyMs: number;
}

export interface ReadinessReport {
  readonly status: 'ok' | 'error';
  readonly checks: Readonly<Record<string, CheckResult>>;
}

class HealthCheckTimeoutError extends Error {
  constructor(name: string, timeoutMs: number) {
    super(`Health check "${name}" timed out after ${timeoutMs}ms`);
  }
}

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(
    @Inject(HEALTH_INDICATORS) private readonly indicators: readonly HealthIndicator[],
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Runs every indicator concurrently with a per-check timeout. */
  async readiness(): Promise<ReadinessReport> {
    const entries = await Promise.all(
      this.indicators.map(
        async (indicator) => [indicator.name, await this.run(indicator)] as const,
      ),
    );
    const checks = Object.fromEntries(entries);
    const status = entries.every(([, r]) => r.status === 'up') ? 'ok' : 'error';
    return { status, checks };
  }

  private async run(indicator: HealthIndicator): Promise<CheckResult> {
    const timeoutMs = this.config.healthCheckTimeoutMs;
    const started = performance.now();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        indicator.check(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new HealthCheckTimeoutError(indicator.name, timeoutMs)),
            timeoutMs,
          );
        }),
      ]);
      return { status: 'up', latencyMs: Math.round(performance.now() - started) };
    } catch (error) {
      // Details go to logs only; the HTTP response exposes status, not internals.
      this.logger.warn(
        { check: indicator.name, err: error },
        `Readiness check "${indicator.name}" failed`,
      );
      return { status: 'down', latencyMs: Math.round(performance.now() - started) };
    } finally {
      clearTimeout(timer);
    }
  }
}
