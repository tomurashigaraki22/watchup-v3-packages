import { defineConfig } from 'tsup';

export default defineConfig({
  entry:       ['src/index.ts'],
  format:      ['esm', 'cjs'],
  // @watchupltd/core is mapped to source in tsconfig paths, so its types are
  // inlined here and its code is bundled below — it is never published.
  dts:         true,
  sourcemap:   true,
  clean:       true,
  treeshake:   true,
  splitting:   false,
  target:      'es2019',
  // No runtime dependencies — ship everything (including core) bundled.
  noExternal:  [/.*/],
});
