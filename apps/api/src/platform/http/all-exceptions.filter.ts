import {
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { reportError } from '../telemetry';

export interface ErrorResponseBody {
  readonly statusCode: number;
  readonly error: string;
  readonly message: string | string[];
  readonly requestId: string | undefined;
}

/**
 * Normalises every error into one JSON shape. Unexpected (5xx) errors are
 * logged with full detail and reported to Sentry, but the client only ever
 * sees a generic message so internals never leak.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpExceptions');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request & { id?: string }>();
    const res = ctx.getResponse<Response>();
    const requestId = typeof req.id === 'string' ? req.id : undefined;

    let status: number = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: string | string[] = 'Internal server error';
    let error = 'Internal Server Error';

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'string') {
        message = body;
      } else if (typeof body === 'object' && body !== null) {
        const b = body as { message?: string | string[]; error?: string };
        message = b.message ?? exception.message;
        error = b.error ?? exception.name;
      }
      if (status < 500) {
        error = typeof body === 'object' && body !== null ? error : exception.name;
      }
    }

    if (status >= 500) {
      this.logger.error({ err: exception, requestId }, 'Unhandled error while processing request');
      reportError(exception);
      if (exception instanceof HttpException) {
        message = 'Internal server error';
      }
    }

    const payload: ErrorResponseBody = { statusCode: status, error, message, requestId };
    res.status(status).json(payload);
  }
}
