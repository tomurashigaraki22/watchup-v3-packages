// Single list of every published WatchUp SDK and where its version lives.
// Used by check-versions.mjs, sync-versions.mjs and the release workflow.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const read = (file) => readFileSync(join(ROOT, file), 'utf8');
const match = (file, re) => re.exec(read(file))?.[1];

/** JavaScript packages: version in package.json, compiled into src/version.ts. */
export const JS_PACKAGES = ['browser', 'node', 'react', 'nextjs', 'svelte', 'react-native', 'mcp', 'create-watchup'];

export function packages() {
  const js = JS_PACKAGES.map((dir) => {
    const pkg = JSON.parse(read(`${dir}/package.json`));
    return {
      id: dir,
      ecosystem: 'npm',
      name: pkg.name,
      dir,
      version: pkg.version,
      // create-watchup is plain CommonJS and has no compiled-in SDK version.
      compiled: dir === 'create-watchup' ? pkg.version : match(`${dir}/src/version.ts`, /SDK_VERSION = '([^']+)'/),
      compiledName: dir === 'create-watchup' ? pkg.name : match(`${dir}/src/version.ts`, /SDK_NAME = '([^']+)'/),
      peers: pkg.peerDependencies ?? {},
    };
  });
  return [
    ...js,
    {
      id: 'python',
      ecosystem: 'pypi',
      name: 'watchup',
      dir: 'python',
      version: match('python/pyproject.toml', /^version = "([^"]+)"/m),
      compiled: match('python/watchup/_version.py', /SDK_VERSION = "([^"]+)"/),
      compiledName: 'watchup',
      peers: {},
    },
    {
      id: 'go',
      ecosystem: 'go',
      name: 'github.com/tomurashigaraki22/watchup-go-sdk',
      dir: 'go',
      version: match('go/watchup.go', /SDKVersion = "([^"]+)"/),
      compiled: match('go/watchup.go', /SDKVersion = "([^"]+)"/),
      compiledName: 'github.com/tomurashigaraki22/watchup-go-sdk',
      peers: {},
    },
    {
      id: 'dotnet',
      ecosystem: 'nuget',
      name: 'Watchup',
      dir: 'dotnet',
      version: match('dotnet/Watchup/Watchup.csproj', /<Version>([^<]+)<\/Version>/),
      compiled: match('dotnet/Watchup/WatchupClient.cs', /SdkVersion = "([^"]+)"/),
      compiledName: 'Watchup',
      peers: {},
    },
  ];
}

/** Does `version` satisfy a simple caret or >= range used in our peer ranges? */
export function satisfies(version, range) {
  const v = version.split('.').map(Number);
  const r = range.replace(/^[\^>=~]+/, '').split('.').map(Number);
  if (range.startsWith('>=')) return v[0] > r[0] || (v[0] === r[0] && (v[1] > r[1] || (v[1] === r[1] && v[2] >= r[2])));
  if (range.startsWith('^')) {
    if (r[0] > 0) return v[0] === r[0] && (v[1] > r[1] || (v[1] === r[1] && v[2] >= r[2]));
    return v[0] === 0 && v[1] === r[1] && v[2] >= r[2];
  }
  return version === range;
}
