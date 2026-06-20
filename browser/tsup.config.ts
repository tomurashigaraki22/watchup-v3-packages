import { defineConfig } from 'tsup';

export default defineConfig({
  entry:       ['src/index.ts'],
  format:      ['esm', 'cjs'],
  dts:         true,
  sourcemap:   true,
  clean:       true,
  treeshake:   true,
  splitting:   false,
  target:      'es2019',
  // No external dependencies — ship everything bundled
  noExternal:  [/.*/],
});
