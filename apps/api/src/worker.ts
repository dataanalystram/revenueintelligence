// Keep this import first: it starts telemetry before instrumented libraries load.
import { config, telemetry } from './instrument-worker';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { QueueService } from './platform/queue';
import { WorkerModule } from './worker.module';

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule.forRoot(config), {
    bufferLogs: true,
  });
  const logger = app.get(Logger);
  app.useLogger(logger);
  process.once('beforeExit', () => void telemetry.shutdown());
  // Graceful shutdown (ADR 0013): stop taking jobs and let active ones finish
  // while the database is still connected, then close the application.
  let closing = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (closing) return;
    closing = true;
    void (async () => {
      await app.get(QueueService).stopProcessing();
      await app.close();
      process.kill(process.pid, signal);
    })();
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
  await app.init();
  logger.log(
    { processors: app.get(QueueService).processorCount },
    'Worker started (context processing on BullMQ)',
  );
}

main().catch((err: unknown) => {
  console.error('Worker failed to start', err);
  process.exit(1);
});
