// Keep this import first: it starts telemetry before instrumented libraries load.
import { config, telemetry } from './instrument-api';
import 'reflect-metadata';
import { createApiApp } from './bootstrap';

async function main(): Promise<void> {
  const app = await createApiApp(config);
  process.once('beforeExit', () => void telemetry.shutdown());
  await app.listen(config.http.port, config.http.host);
}

main().catch((err: unknown) => {
  console.error('API failed to start', err);
  process.exit(1);
});
