import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// Live tests call real external systems (developer/test accounts only) and are
// never part of `pnpm verify`. They fail when no test files are found.
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['test/live/**/*.live.spec.ts'],
    environment: 'node',
    testTimeout: 60_000,
    passWithNoTests: false,
    reporters: ['verbose'],
  },
});
