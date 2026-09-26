import {
  BadRequestException,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
  NotFoundException,
  type ArgumentsHost,
} from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const reportError = vi.hoisted(() => vi.fn());
vi.mock('../telemetry', () => ({ reportError }));

import { AllExceptionsFilter } from './all-exceptions.filter';

function hostFor(requestId?: string) {
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
  const host = {
    switchToHttp: () => ({ getRequest: () => ({ id: requestId }), getResponse: () => res }),
  } as unknown as ArgumentsHost;
  return { host, res };
}

describe('AllExceptionsFilter', () => {
  const filter = new AllExceptionsFilter();

  beforeEach(() => reportError.mockClear());

  it('passes through client errors with their message and request id', () => {
    const { host, res } = hostFor('req-1');
    filter.catch(new NotFoundException('Lead not found'), host);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      statusCode: 404,
      error: 'Not Found',
      message: 'Lead not found',
      requestId: 'req-1',
    });
    expect(reportError).not.toHaveBeenCalled();
  });

  it('keeps validation message arrays intact', () => {
    const { host, res } = hostFor();
    filter.catch(new BadRequestException(['email must be an email', 'stage is invalid']), host);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 400,
        message: ['email must be an email', 'stage is invalid'],
        requestId: undefined,
      }),
    );
  });

  it('handles HttpExceptions built from a plain string', () => {
    const { host, res } = hostFor();
    filter.catch(new HttpException('Too many requests', HttpStatus.TOO_MANY_REQUESTS), host);

    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 429, message: 'Too many requests' }),
    );
  });

  it('hides internals of unexpected errors and reports them', () => {
    const { host, res } = hostFor('req-2');
    const error = new Error('password authentication failed for user "lip"');
    filter.catch(error, host);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      statusCode: 500,
      error: 'Internal Server Error',
      message: 'Internal server error',
      requestId: 'req-2',
    });
    expect(reportError).toHaveBeenCalledWith(error);
  });

  it('hides the message of explicit 5xx HttpExceptions too', () => {
    const { host, res } = hostFor();
    filter.catch(new InternalServerErrorException('Sugar token expired at 10:31'), host);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 500, message: 'Internal server error' }),
    );
    expect(reportError).toHaveBeenCalledOnce();
  });

  it('treats thrown non-Error values as internal errors', () => {
    const { host, res } = hostFor();
    filter.catch('boom', host);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});
