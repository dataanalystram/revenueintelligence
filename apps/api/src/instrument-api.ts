import { instrumentProcess } from './platform/telemetry/instrument';

/**
 * Side-effect module; MUST be the first import in main.ts so configuration is
 * validated and telemetry started before instrumented libraries are required.
 */
export const { config, telemetry } = instrumentProcess('api');
