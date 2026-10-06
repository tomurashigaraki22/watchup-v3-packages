#!/usr/bin/env node
// Regenerate each JS package's src/version.ts from its package.json, so the
// sdk.name / sdk.version sent in every envelope always match the release.
// Other ecosystems keep the version next to the code (see packages.mjs).

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { JS_PACKAGES, ROOT } from './packages.mjs';

for (const dir of JS_PACKAGES) {
  if (dir === 'create-watchup') continue;
  const pkg = JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8'));
  const file = join(ROOT, dir, 'src', 'version.ts');
  const next =
    '// Generated from package.json by tools/release/sync-versions.mjs — do not edit.\n' +
    `export const SDK_NAME = '${pkg.name}';\n` +
    `export const SDK_VERSION = '${pkg.version}';\n`;
  writeFileSync(file, next);
  console.log(`${pkg.name} → ${pkg.version}`);
}
