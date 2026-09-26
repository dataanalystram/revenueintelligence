import { Global, Module } from '@nestjs/common';
import { DatabaseHealthIndicator } from './database-health.indicator';
import { PrismaService } from './prisma.service';

@Global()
@Module({
  providers: [PrismaService, DatabaseHealthIndicator],
  exports: [PrismaService, DatabaseHealthIndicator],
})
export class DatabaseModule {}
