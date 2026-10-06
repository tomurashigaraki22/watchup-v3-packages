import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { main } = require('../src/index.js');
const { PACKAGE_MAP, verifyPublished } = require('../src/package-manager.js');

let dir: string;
const logs: string[] = [];

function project(pkg: Record<string, unknown> | null, files: Record<string, string> = {}) {
  if (pkg) writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
  for (const [file, contents] of Object.entries(files)) {
    mkdirSync(join(dir, file, '..'), { recursive: true });
    writeFileSync(join(dir, file), contents);
  }
}

function run(argv: string[], install = vi.fn(), verify = vi.fn()) {
  return main(['--yes', ...argv], { cwd: dir, log: (l: string) => logs.push(l), install, verify });
}

const read = (file: string) => readFileSync(join(dir, file), 'utf8');

const LAYOUT = `export default function RootLayout({ children }) {
  return (
    <html>
      <body className="x">
        {children}
      </body>
    </html>
  );
}
`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'create-watchup-'));
  logs.length = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('Next.js', () => {
  it('writes a secret key only to the server variable', async () => {
    project({ dependencies: { next: '15' } }, { 'app/layout.js': LAYOUT });
    await run(['--api-key', 'wup_live_secret123']);
    const env = read('.env.local');
    expect(env).toContain('WATCHUP_API_KEY=wup_live_secret123');
    expect(env).toContain('NEXT_PUBLIC_WATCHUP_API_KEY=wup_pub_xxx');
    expect(env).not.toMatch(/NEXT_PUBLIC_WATCHUP_API_KEY=wup_live/);
  });

  it('writes a public key only to the NEXT_PUBLIC_ variable', async () => {
    project({ dependencies: { next: '15' } }, { 'app/layout.js': LAYOUT });
    await run(['--api-key', 'wup_pub_public123']);
    const env = read('.env.local');
    expect(env).toContain('NEXT_PUBLIC_WATCHUP_API_KEY=wup_pub_public123');
    expect(env).toContain('WATCHUP_API_KEY=wup_live_xxx');
  });

  it('creates one integration and never duplicates providers on a second run', async () => {
    project({ dependencies: { next: '15' } }, { 'app/layout.js': LAYOUT });
    const install = vi.fn();
    const verify = vi.fn();
    await run(['--api-key', 'wup_pub_a'], install, verify);
    await run(['--api-key', 'wup_pub_b'], install, verify);
    const layout = read('app/layout.js');
    expect(layout.match(/<WatchupInit>/g)).toHaveLength(1);
    expect(layout.match(/import WatchupInit/g)).toHaveLength(1);
    expect(read('instrumentation.js')).toContain('registerWatchup');
    expect(read('.env.local').match(/NEXT_PUBLIC_WATCHUP_API_KEY=/g)).toHaveLength(1);
    expect(verify).toHaveBeenCalledWith(PACKAGE_MAP.next);
    expect(install.mock.calls[0][0].packages).toEqual(PACKAGE_MAP.next);
  });

  it('leaves an existing instrumentation file and an existing provider alone', async () => {
    project({ dependencies: { next: '15' } }, {
      'app/layout.tsx': LAYOUT.replace('{children}', '<WatchupProvider>{children}</WatchupProvider>'),
      'instrumentation.ts': 'export function register() {}\n',
    });
    const result = await run([]);
    expect(read('instrumentation.ts')).toBe('export function register() {}\n');
    expect(read('app/layout.tsx')).not.toContain('WatchupInit');
    expect(result.notes.join('\n')).toContain('registerWatchup');
  });
});

describe('browser frameworks refuse secret keys', () => {
  it.each([
    [{ dependencies: { react: '18' } }, 'VITE_WATCHUP_API_KEY'],
    [{ dependencies: { expo: '51', 'react-native': '0.74' } }, 'EXPO_PUBLIC_WATCHUP_API_KEY'],
    [{ devDependencies: { '@sveltejs/kit': '2' } }, 'PUBLIC_WATCHUP_API_KEY'],
  ])('%j', async (pkg, variable) => {
    project(pkg);
    await expect(run(['--api-key', 'wup_live_x'])).rejects.toThrow(new RegExp(variable));
  });
});

describe('servers', () => {
  it('Express template has no extra signal handlers and is not overwritten', async () => {
    project({ dependencies: { express: '5' } });
    await run(['--api-key', 'wup_live_k']);
    const src = read('watchup.js');
    expect(src).toContain('requestMiddleware');
    expect(src).not.toContain('SIGTERM"');
    expect(src).not.toMatch(/process\.once/);
    writeFileSync(join(dir, 'watchup.js'), '// custom\n');
    await run([]);
    expect(read('watchup.js')).toBe('// custom\n');
    expect(read('.env')).toContain('WATCHUP_API_KEY=wup_live_k');
  });
});

describe('fail fast', () => {
  it.each([
    [{ 'pyproject.toml': '' }, /Python.*pip install watchup/],
    [{ 'go.mod': 'module x' }, /Go.*go get/],
    [{ 'App.csproj': '<Project/>' }, /\.NET.*dotnet add package Watchup/],
  ])('rejects non-JS projects %j', async (files, message) => {
    project(null, files);
    await expect(run([])).rejects.toThrow(message);
  });

  it('rejects unsupported JS frameworks', async () => {
    project({ dependencies: { vue: '3' } });
    await expect(run([])).rejects.toThrow(/Vue projects are not set up by this CLI/);
  });

  it('verifies packages before writing any files', async () => {
    project({ dependencies: { express: '5' } });
    const verify = vi.fn(() => {
      throw new Error('Not published on npm yet: @watchupltd/node');
    });
    await expect(run([], vi.fn(), verify)).rejects.toThrow(/Not published/);
    expect(existsSync(join(dir, 'watchup.js'))).toBe(false);
  });

  it('verifyPublished reports missing packages', () => {
    const exec = vi.fn((_cmd: string, args: string[]) => ({ status: args[1] === '@watchupltd/missing' ? 1 : 0, stdout: '1.0.0' }));
    expect(() => verifyPublished(['@watchupltd/node', '@watchupltd/missing'], { exec })).toThrow(/@watchupltd\/missing/);
    expect(() => verifyPublished(['@watchupltd/node'], { exec })).not.toThrow();
  });
});
