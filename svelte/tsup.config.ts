import { defineConfig } from 'tsup';

export default defineConfig({
  // The .svelte component ships as source (copied by the build script) and is
  // compiled by the app's Svelte.
  entry:    { index: 'src/index.ts', server: 'src/server.ts' },
  format:   ['esm', 'cjs'],
  dts:      true,
  sourcemap: true,
  clean:    true,
  treeshake: true,
  target:   'es2019',
  external: ['svelte', 'svelte/action', 'svelte/store', '@watchupltd/browser', '@watchupltd/svelte'],
});
