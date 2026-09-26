import 'dotenv/config';
import { defineConfig } from 'prisma/config';

// Prisma CLI configuration (migrations, generate). The runtime connection is
// created in src/platform/database/prisma.service.ts from validated config.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // A placeholder keeps `prisma generate` working without a database; commands
    // that actually connect (migrate) require DATABASE_URL to be set.
    url:
      process.env.DATABASE_URL ?? 'postgresql://placeholder:placeholder@localhost:5432/placeholder',
  },
});
