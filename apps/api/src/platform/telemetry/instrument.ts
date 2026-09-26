import { loadConfig, type AppConfig } from '../config';
import { startTelemetry, type Telemetry } from './telemetry';

export interface Instrumented {
  readonly config: AppConfig;
  readonly telemetry: Telemetry;
}

/** Validates configuration and starts telemetry for one process role. */
export function instrumentProcess(role: 'api' | 'worker'): Instrumented {
  const config = loadConfig();
  return { config, telemetry: startTelemetry(config, role) };
}
