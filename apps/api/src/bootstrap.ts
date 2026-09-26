import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import type { AppConfig } from './platform/config';
import { AllExceptionsFilter } from './platform/http';

/**
 * Builds the configured HTTP application. Shared by main.ts and the
 * integration tests so both exercise the exact same pipeline.
 */
export async function createApiApp(config: AppConfig): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config), {
    bufferLogs: true,
    // Raw bodies are retained for webhook signature verification (Milestone 5).
    rawBody: true,
  });
  app.useLogger(app.get(Logger));
  app.use(helmet());
  app.disable('x-powered-by');
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks();
  return app;
}
