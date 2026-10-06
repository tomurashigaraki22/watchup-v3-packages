#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Documentation examples are executed in CI (plan §6).
//
//   node tools/docs/examples.mjs check   README snippets match example files
//   node tools/docs/examples.mjs run     run the examples against the mock API
//
// A README embeds an example by putting `<!-- example: path/to/file -->` on
// the line before a fenced code block; the block must equal the file.
// ─────────────────────────────────────────────────────────────────────────────

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ROOT } from '../release/packages.mjs';
import { createMockIngest } from '../mock-ingest/server.mjs';

const READMES = [
  'README.md',
  'node/README.md',
  'browser/README.md',
  'react/README.md',
  'nextjs/README.md',
  'svelte/README.md',
  'react-native/README.md',
  'python/README.md',
  'go/README.md',
  'dotnet/Watchup/README.md',
  'mcp/README.md',
];

/** Runnable examples and what the mock API must receive from each. */
const RUNNABLE = [
  { file: 'examples/node-express.mjs', cmd: process.execPath, expect: { traces: 2, errors: 1, events: 1 } },
  {
    file: 'examples/python_flask.py',
    cmd: process.env.PYTHON ? resolve(process.env.PYTHON) : process.platform === 'win32' ? 'python' : 'python3',
    env: { PYTHONPATH: join(ROOT, 'python') },
    expect: { traces: 2, errors: 1, events: 1 },
  },
];

const normalize = (s) => s.replace(/\r\n/g, '\n').trim();

function check() {
  const problems = [];
  let count = 0;
  for (const readme of READMES) {
    const path = join(ROOT, readme);
    if (!existsSync(path)) {
      problems.push(`${readme} is missing`);
      continue;
    }
    const text = readFileSync(path, 'utf8');
    const re = /<!-- example: ([^\s]+) -->\s*\n```[^\n]*\n([\s\S]*?)\n```/g;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      count++;
      const file = join(ROOT, m[1]);
      if (!existsSync(file)) problems.push(`${readme}: example ${m[1]} does not exist`);
      else if (normalize(readFileSync(file, 'utf8')) !== normalize(m[2])) problems.push(`${readme}: snippet differs from ${m[1]}`);
    }
  }
  if (problems.length) {
    console.error(problems.map((p) => `✗ ${p}`).join('\n'));
    process.exit(1);
  }
  console.log(`✓ ${count} README snippet(s) match their example files`);
}

async function run() {
  const mock = createMockIngest({ keys: ['wup_live_examples'] });
  const baseUrl = await mock.listen();
  let failed = false;
  for (const example of RUNNABLE) {
    await fetch(`${baseUrl}/__mock/reset`, { method: 'POST' });
    const status = await new Promise((done) => {
      const child = spawn(example.cmd, [join(ROOT, example.file)], {
        cwd: ROOT,
        env: { ...process.env, ...example.env, WATCHUP_API_KEY: 'wup_live_examples', WATCHUP_BASE_URL: baseUrl, PORT: '0' },
        stdio: ['ignore', 'inherit', 'inherit'],
      });
      child.on('close', done);
      child.on('error', () => done(-1));
    });
    const state = await (await fetch(`${baseUrl}/__mock/state`)).json();
    const got = Object.fromEntries(Object.entries(state.accepted).map(([k, v]) => [k, v.length]));
    const ok = status === 0 && state.violations.length === 0 && Object.entries(example.expect).every(([k, n]) => got[k] >= n);
    failed ||= !ok;
    console.log(`${ok ? '✓' : '✗'} ${example.file}: exit ${status}, received ${JSON.stringify(got)}${state.violations.length ? `, violations ${JSON.stringify(state.violations)}` : ''}`);
  }
  await mock.close();
  process.exit(failed ? 1 : 0);
}

const mode = process.argv[2];
if (mode === 'check') check();
else if (mode === 'run') await run();
else {
  console.error('usage: examples.mjs check|run');
  process.exit(2);
}
