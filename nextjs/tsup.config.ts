import { defineConfig } from 'tsup';

export default defineConfig([
  // Client bundle — browser-targeted, JSX preserved
  {
    entry:    { 'client/index': 'src/client/index.ts' },
    format:   ['esm', 'cjs'],
    dts:      true,
    sourcemap: true,
    clean:    true,
    target:   'es2019',
    external: [
      'react',
      'react/jsx-runtime',
      'next',
      'next/navigation',
      'next/navigation.js',
      '@watchupltd/browser',
      '@watchupltd/react',
    ],
    esbuildOptions(opts) {
      opts.jsx = 'automatic';
    },
  },
  // Server bundle — Node-targeted, no DOM
  {
    entry:    { 'server/index': 'src/server/index.ts' },
    format:   ['esm', 'cjs'],
    dts:      true,
    sourcemap: true,
    target:   'node18',
    external: [
      'next',
      'next/server',
      'next/server.js',
      '@watchupltd/node',
    ],
  },
]);
