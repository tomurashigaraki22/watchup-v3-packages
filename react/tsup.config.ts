import { defineConfig } from 'tsup';

export default defineConfig({
  entry:      ['src/index.ts'],
  format:     ['esm', 'cjs'],
  dts:        true,
  sourcemap:  true,
  clean:      true,
  treeshake:  true,
  splitting:  false,
  target:     'es2019',
  // React + @watchupltd/browser are peer deps — don't bundle them
  external:   ['react', 'react/jsx-runtime', '@watchupltd/browser'],
});
