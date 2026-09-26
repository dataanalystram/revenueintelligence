import { Logger } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { LifecycleLogger, SHUTDOWN_COMPLETE_MESSAGE } from './lifecycle';

describe('LifecycleLogger', () => {
  it('logs completion with the signal', () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    new LifecycleLogger().onApplicationShutdown('SIGTERM');
    expect(log).toHaveBeenCalledWith({ signal: 'SIGTERM' }, SHUTDOWN_COMPLETE_MESSAGE);
  });
});
