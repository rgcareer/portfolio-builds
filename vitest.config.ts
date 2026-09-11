import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));

// Resolve the shared workspace package to TypeScript source so tests run without a build
// step. Kept in lockstep with tsconfig.base.json "paths".
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@portfolio-builds\/shared$/, replacement: resolve(root, 'packages/shared/src/index.ts') },
      { find: /^@portfolio-builds\/shared\/(.*)$/, replacement: resolve(root, 'packages/shared/src/$1') },
    ],
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'skillcheck/**'],
    environment: 'node',
    sequence: { shuffle: false },
  },
});
