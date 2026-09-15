import { defineConfig } from 'tsup';

// Bundles @portfolio-builds/shared (a workspace devDependency) into the published output via
// noExternal, so the npm tarball is installable standalone. Runtime deps stay external.
export default defineConfig({
  entry: { index: 'src/index.ts', cli: 'src/cli.ts' },
  format: ['esm'],
  target: 'node22',
  dts: true,
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
