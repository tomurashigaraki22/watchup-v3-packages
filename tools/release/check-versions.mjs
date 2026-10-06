#!/usr/bin/env node
// Fails when versions drift: manifest vs. compiled-in sdk.version, missing
// changelog entries, or peer ranges that exclude the workspace's own release.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, packages, satisfies } from './packages.mjs';

const problems = [];
const all = packages();
const byName = new Map(all.map((p) => [p.name, p]));

for (const p of all) {
  if (!p.version) problems.push(`${p.id}: version not found`);
  if (p.compiled !== p.version) problems.push(`${p.id}: manifest ${p.version} but compiled sdk.version ${p.compiled} (run node tools/release/sync-versions.mjs)`);
  if (p.ecosystem === 'npm' && p.compiledName !== p.name) problems.push(`${p.id}: compiled sdk.name ${p.compiledName} ≠ ${p.name}`);

  const changelog = join(ROOT, p.dir, 'CHANGELOG.md');
  if (!existsSync(changelog)) problems.push(`${p.id}: ${p.dir}/CHANGELOG.md is missing`);
  else if (!readFileSync(changelog, 'utf8').includes(`## ${p.version}`)) problems.push(`${p.id}: CHANGELOG.md has no "## ${p.version}" entry`);

  for (const [peer, range] of Object.entries(p.peers)) {
    const local = byName.get(peer);
    if (local && !satisfies(local.version, range)) problems.push(`${p.id}: peer ${peer}@${range} excludes workspace version ${local.version}`);
  }
}

if (problems.length) {
  console.error(problems.map((x) => `✗ ${x}`).join('\n'));
  process.exit(1);
}
console.log(all.map((p) => `✓ ${p.name}@${p.version}`).join('\n'));
