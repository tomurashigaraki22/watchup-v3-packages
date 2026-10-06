#!/usr/bin/env node
// Fails if a client build contains a server secret (plan §4.3 release gate).
//   node tools/scan-build-secrets.mjs <dir> [secret-value ...]
// Always rejects references to the server-only WATCHUP_API_KEY variable name
// and any wup_live_ key.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const [dir, ...secrets] = process.argv.slice(2);
if (!dir) {
  console.error('usage: scan-build-secrets.mjs <dir> [secret ...]');
  process.exit(2);
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const patterns = [
  /(?<!NEXT_PUBLIC_|VITE_|PUBLIC_|EXPO_PUBLIC_)\bWATCHUP_API_KEY\b/,
  /wup_live_[A-Za-z0-9]+/,
  ...secrets.map((s) => new RegExp(escapeRegExp(s))),
];
const hits = [];

function walk(path) {
  for (const entry of readdirSync(path)) {
    const full = join(path, entry);
    if (statSync(full).isDirectory()) walk(full);
    else if (/\.(js|mjs|cjs|html|json|css|map)$/.test(entry)) {
      const text = readFileSync(full, 'utf8');
      for (const re of patterns) if (re.test(text)) hits.push(`${full}: matches ${re}`);
    }
  }
}

walk(dir);
if (hits.length) {
  console.error(`✗ server secrets found in client output:\n${hits.join('\n')}`);
  process.exit(1);
}
console.log(`✓ no server secrets in ${dir}`);
