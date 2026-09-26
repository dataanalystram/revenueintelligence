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
    // Migrations run as the schema owner (MIGRATION_DATABASE_URL); the
    // application runs as the non-privileged app role (DATABASE_URL). See
    // docs/operations/database-roles.md. A placeholder keeps `prisma generate`
    // working without a database.
    url:
      process.env.MIGRATION_DATABASE_URL ??
      process.env.DATABASE_URL ??
      'postgresql://placeholder:placeholder@localhost:5432/placeholder',
  },
});
