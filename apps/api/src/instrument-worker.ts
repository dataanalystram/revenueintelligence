import { instrumentProcess } from './platform/telemetry/instrument';

/** Side-effect module; MUST be the first import in worker.ts (see instrument-api.ts). */
export const { config, telemetry } = instrumentProcess('worker');
