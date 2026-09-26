import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// Live tests call real external *test* environments (e.g. a HubSpot developer
// test account). Each suite skips itself, naming the missing variables, when
// its credentials are not configured. Never point these at customer production.
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['test/live/**/*.live.spec.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    passWithNoTests: true,
  },
});
