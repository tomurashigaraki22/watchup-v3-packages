import { defineConfig } from 'tsup';

export default defineConfig({
  entry:      ['src/index.ts'],
  format:     ['cjs', 'esm'],
  dts:        true,
  clean:      true,
  sourcemap:  true,
  splitting:  false,
  treeshake:  true,
  // Keep the bundle readable — this isn't a browser bundle
  minify:     false,
  target:     'node18',
});
