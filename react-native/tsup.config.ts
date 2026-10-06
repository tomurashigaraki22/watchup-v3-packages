import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2020',
  external: [
    'react',
    'react-native',
    '@react-native-async-storage/async-storage',
    '@react-native-community/netinfo',
    'promise/setimmediate/rejection-tracking',
  ],
  // @watchupltd/core is internal: bundled, with types inlined via tsconfig paths.
  noExternal: ['@watchupltd/core'],
});
