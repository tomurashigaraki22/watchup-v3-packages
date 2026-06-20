import { defineConfig } from 'tsup';

export default defineConfig({
  // Only compile the TS source — the .svelte file is shipped as-is
  entry:    ['src/index.ts', 'src/context.ts', 'src/action.ts'],
  format:   ['esm', 'cjs'],
  dts:      true,
  sourcemap: true,
  clean:    true,
  treeshake: true,
  target:   'es2019',
  external: ['svelte', 'svelte/action', '@watchupltd/browser'],
});
