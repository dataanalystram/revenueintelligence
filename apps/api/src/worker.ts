// Keep this import first: it starts telemetry before instrumented libraries load.
import { config, telemetry } from './instrument-worker';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { WorkerModule } from './worker.module';

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule.forRoot(config), {
    bufferLogs: true,
  });
  const logger = app.get(Logger);
  app.useLogger(logger);
  app.enableShutdownHooks();
  process.once('beforeExit', () => void telemetry.shutdown());
  logger.log('Worker started; no queue processors are registered yet (Milestone 6).');
}

main().catch((err: unknown) => {
  console.error('Worker failed to start', err);
  process.exit(1);
});
