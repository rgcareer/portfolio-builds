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
    // Run test files serially so the whole-suite `root.unit` gate check is deterministic:
    // tests share fixed data/ and node:sqlite paths, and the real-MiniLM embedder test loads
    // an ONNX model, so parallel workers collide or starve CPU (see tasks/lessons.md 2026-09-15).
    fileParallelism: false,
    // The real-model embedder test loads + runs ONNX; 5s is too short even serially on a cold load.
    testTimeout: 20000,
  },
});
