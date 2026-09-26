import { Injectable } from '@nestjs/common';
import type { HealthIndicator } from '../health/health-indicator';
import { PrismaService } from './prisma.service';

@Injectable()
export class DatabaseHealthIndicator implements HealthIndicator {
  readonly name = 'database';

  constructor(private readonly prisma: PrismaService) {}

  async check(): Promise<void> {
    await this.prisma.$queryRaw`SELECT 1`;
  }
}
