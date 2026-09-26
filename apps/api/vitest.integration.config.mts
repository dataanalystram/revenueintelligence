import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// Integration tests start real PostgreSQL and Redis containers via
// Testcontainers, so they need a running Docker daemon.
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['test/**/*.int.spec.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
