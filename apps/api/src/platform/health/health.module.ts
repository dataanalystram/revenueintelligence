import { Module } from '@nestjs/common';
import { DatabaseHealthIndicator, DatabaseModule } from '../database';
import { RedisHealthIndicator, RedisModule } from '../redis';
import { HealthController } from './health.controller';
import { HEALTH_INDICATORS, type HealthIndicator } from './health-indicator';
import { HealthService } from './health.service';

@Module({
  imports: [DatabaseModule, RedisModule],
  controllers: [HealthController],
  providers: [
    HealthService,
    {
      provide: HEALTH_INDICATORS,
      inject: [DatabaseHealthIndicator, RedisHealthIndicator],
      useFactory: (...indicators: HealthIndicator[]) => indicators,
    },
  ],
})
export class HealthModule {}
