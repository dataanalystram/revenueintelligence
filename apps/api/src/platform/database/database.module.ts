import { Global, Module } from '@nestjs/common';
import { DatabaseHealthIndicator } from './database-health.indicator';
import { DatabaseRoleGuard } from './database-role-guard';
import { PrismaService } from './prisma.service';

@Global()
@Module({
  providers: [PrismaService, DatabaseRoleGuard, DatabaseHealthIndicator],
  exports: [PrismaService, DatabaseRoleGuard, DatabaseHealthIndicator],
})
export class DatabaseModule {}
