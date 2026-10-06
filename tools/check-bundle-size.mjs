#!/usr/bin/env node
// Bundle-size budget for browser-facing packages (plan §4.1 release gate).
// Measures what an app bundler ships: the ESM build, minified, gzipped.
// Run after `npm run build`.

import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { transformSync } from 'esbuild';
import { ROOT } from './release/packages.mjs';

const BUDGETS = [
  { file: 'browser/dist/index.mjs', maxGzipBytes: 12 * 1024 },
  { file: 'react/dist/index.mjs', maxGzipBytes: 3 * 1024 },
  { file: 'nextjs/dist/client/index.mjs', maxGzipBytes: 1.5 * 1024 },
  { file: 'svelte/dist/index.mjs', maxGzipBytes: 3 * 1024 },
  { file: 'react-native/dist/index.mjs', maxGzipBytes: 13 * 1024 },
];

let failed = false;
for (const { file, maxGzipBytes } of BUDGETS) {
  const source = readFileSync(join(ROOT, file), 'utf8');
  const { code } = transformSync(source, { minify: true, format: 'esm', target: 'es2019' });
  const size = gzipSync(code, { level: 9 }).length;
  const ok = size <= maxGzipBytes;
  failed ||= !ok;
  console.log(`${ok ? '✓' : '✗'} ${file}: ${(size / 1024).toFixed(1)} KiB gzip (budget ${(maxGzipBytes / 1024).toFixed(1)} KiB)`);
}
process.exit(failed ? 1 : 0);
