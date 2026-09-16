import { defineConfig } from 'tsup';

// Bundles @portfolio-builds/shared (a workspace devDependency) into the published output via
// noExternal, so the npm tarball is installable standalone. Runtime deps stay external.
export default defineConfig({
  entry: { index: 'src/index.ts', cli: 'src/cli.ts' },
  format: ['esm'],
  target: 'node22',
  // Only the library entry needs a .d.ts; the CLI is a bin, not an import. Generating dts for
  // cli.ts fed its `#!/usr/bin/env node` shebang into the dts bundler ("Syntax not yet supported").
  dts: { entry: { index: 'src/index.ts' } },
  clean: true,
  sourcemap: false,
  noExternal: ['@portfolio-builds/shared'],
  external: ["citty","@huggingface/transformers"],
  banner: { js: '' },
  esbuildOptions(options) {
    // Preserve the CLI shebang; Node ignores it under --import tsx and esbuild keeps it.
    options.banner = { js: '' };
  },
});
