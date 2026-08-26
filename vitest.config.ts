import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));

// Resolve the @skillcheck/core workspace package to its TypeScript source so tests
// run against source without a build step. Kept in lockstep with tsconfig.base paths.
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@skillcheck\/core$/, replacement: resolve(root, 'packages/core/src/index.ts') },
      { find: /^@skillcheck\/core\/(.*)$/, replacement: resolve(root, 'packages/core/src/$1') },
    ],
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
    // Determinism: no parallelism-order surprises in tests that touch shared fixtures.
    sequence: { shuffle: false },
  },
});
