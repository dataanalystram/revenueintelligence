import { Injectable, Logger } from '@nestjs/common';
import { MetricsService } from '../../../platform/metrics';
import type { SecurityEvent } from '../../domain';

/**
 * Security events (M10A1 plan §15): one structured warning log line and one
 * counter per event. Codes and identifiers only; callers never pass values.
 */
@Injectable()
export class SecurityEventsService {
  private readonly logger = new Logger('Security');

  constructor(private readonly metrics: MetricsService) {}

  emit(event: SecurityEvent): void {
    this.metrics.increment('lip_security_events_total', {
      event: event.event,
      outcome: event.outcome,
    });
    this.logger.warn({ msg: 'Security event', security_event: true, ...event });
  }
}
