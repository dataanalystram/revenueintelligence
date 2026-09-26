import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';

export const SHUTDOWN_COMPLETE_MESSAGE = 'Application shut down cleanly';

/**
 * Logs once the shutdown sequence has run. Nest calls onApplicationShutdown
 * after every module's onModuleDestroy (database disconnect, Redis quit), so
 * this line is evidence of an orderly shutdown, not an abrupt kill.
 * Runtime verification asserts it.
 */
@Injectable()
export class LifecycleLogger implements OnApplicationShutdown {
  private readonly logger = new Logger('Lifecycle');

  onApplicationShutdown(signal?: string): void {
    this.logger.log({ signal }, SHUTDOWN_COMPLETE_MESSAGE);
  }
}
