import { Injectable } from '@nestjs/common';
import type { HealthIndicator } from '../health/health-indicator';
import { DatabaseRoleGuard } from './database-role-guard';
import { PrismaService } from './prisma.service';

@Injectable()
export class DatabaseHealthIndicator implements HealthIndicator {
  readonly name = 'database';

  constructor(
    private readonly prisma: PrismaService,
    private readonly roleGuard: DatabaseRoleGuard,
  ) {}

  async check(): Promise<void> {
    await this.prisma.$queryRaw`SELECT 1`;
    await this.roleGuard.ensureSafe();
  }
}
