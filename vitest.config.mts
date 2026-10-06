import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';

const src = (pkg: string) => fileURLToPath(new URL(`./${pkg}/src/index.ts`, import.meta.url));

// Tests import workspace packages from source, never from a stale dist/.
const alias = {
  '@watchupltd/core': src('core'),
  '@watchupltd/browser': src('browser'),
  '@watchupltd/node': src('node'),
  '@watchupltd/react': src('react'),
};

// One vitest run covers every JavaScript workspace. Each SDK is its own project
// so it gets the right environment (node vs. jsdom).
export default defineConfig({
  // dedupe: compatibility jobs override react/svelte at the root; every
  // workspace must resolve that single copy, not a nested one.
  resolve: { alias, dedupe: ['react', 'react-dom', 'svelte'] },
  test: {
    projects: [
      { extends: true, test: { name: 'core', include: ['core/test/**/*.test.ts'], environment: 'node' } },
      { extends: true, test: { name: 'mock-ingest', include: ['tools/mock-ingest/test/**/*.test.ts'], environment: 'node' } },
      { extends: true, test: { name: 'browser', include: ['browser/test/**/*.test.ts'], environment: 'jsdom' } },
      { extends: true, test: { name: 'node', include: ['node/test/**/*.test.ts'], environment: 'node' } },
      {
        extends: true,
        esbuild: { jsx: 'automatic' },
        test: { name: 'react', include: ['react/test/**/*.test.{ts,tsx}'], environment: 'jsdom' },
      },
      {
        extends: true,
        esbuild: { jsx: 'automatic' },
        test: { name: 'nextjs', include: ['nextjs/test/**/*.test.{ts,tsx}'], environment: 'node' },
      },
      {
        extends: true,
        plugins: [svelte({ hot: false })],
        resolve: {
          conditions: ['browser'],
          alias: { '@watchupltd/svelte': fileURLToPath(new URL('./svelte/src/index.ts', import.meta.url)) },
        },
        test: { name: 'svelte', include: ['svelte/test/**/*.test.ts'], environment: 'jsdom' },
      },
      {
        extends: true,
        esbuild: { jsx: 'automatic' },
        test: { name: 'react-native', include: ['react-native/test/**/*.test.{ts,tsx}'], environment: 'node' },
      },
      { extends: true, test: { name: 'mcp', include: ['mcp/test/**/*.test.ts'], environment: 'node' } },
      { extends: true, test: { name: 'create-watchup', include: ['create-watchup/test/**/*.test.{ts,js}'], environment: 'node' } },
    ],
  },
});
