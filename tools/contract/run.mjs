#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Cross-language contract test (plan Phase B.3, §4.11).
//
// Runs the same workload through each SDK against the mock ingest server and
// checks what arrived: request sizes, item counts, idempotent retries, user
// identity and redaction. The first ingest request of each run gets a 503 so
// every SDK must retry with the same idempotency key.
//
//   node tools/contract/run.mjs                 # all SDKs
//   node tools/contract/run.mjs node python     # a subset
// ─────────────────────────────────────────────────────────────────────────────

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createMockIngest } from '../mock-ingest/server.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const isWindows = process.platform === 'win32';

const pythonBin = process.env.PYTHON ? resolve(process.env.PYTHON) : isWindows ? 'python' : 'python3';

const EMITTERS = {
  node: { cmd: process.execPath, args: [join(here, 'emit-node.mjs')], cwd: root },
  python: { cmd: pythonBin, args: [join(here, 'emit_python.py')], cwd: root, env: { PYTHONPATH: join(root, 'python') } },
  go: { cmd: 'go', args: ['run', '.'], cwd: join(here, 'go') },
  dotnet: { cmd: 'dotnet', args: ['run', '--project', join(here, 'dotnet', 'Contract.csproj'), '-c', 'Release'], cwd: root },
};

const requested = process.argv.slice(2);
const languages = requested.length ? requested : Object.keys(EMITTERS);

const mock = createMockIngest({ keys: ['wup_live_test'] });
const baseUrl = await mock.listen();
let failed = false;

for (const lang of languages) {
  const emitter = EMITTERS[lang];
  if (!emitter) {
    console.error(`unknown SDK "${lang}" (expected one of ${Object.keys(EMITTERS).join(', ')})`);
    process.exit(2);
  }
  await fetch(`${baseUrl}/__mock/reset`, { method: 'POST' });
  mock.script([503]);

  // Async spawn: the mock server runs in this process and must keep serving.
  const run = await new Promise((resolveRun) => {
    const child = spawn(emitter.cmd, emitter.args, {
      cwd: emitter.cwd,
      env: { ...process.env, ...emitter.env, WATCHUP_BASE_URL: baseUrl },
      // Windows needs a shell to resolve go.exe / dotnet.exe from PATH.
      shell: isWindows && (emitter.cmd === 'go' || emitter.cmd === 'dotnet'),
    });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    child.stdout.on('data', () => {});
    const timer = setTimeout(() => child.kill(), 300_000);
    child.on('error', (error) => resolveRun({ status: -1, stderr: error.message }));
    child.on('close', (status) => {
      clearTimeout(timer);
      resolveRun({ status, stderr });
    });
  });
  // Let any in-flight request finish being recorded.
  await new Promise((r) => setTimeout(r, 100));
  const state = await (await fetch(`${baseUrl}/__mock/state`)).json();

  const problems = [];
  if (run.status !== 0) problems.push(`emitter exited with ${run.status}: ${run.stderr.slice(-2000)}`);
  problems.push(...state.violations.map((v) => `violation: ${JSON.stringify(v)}`));

  const { errors, traces, events } = state.accepted;
  if (errors.length !== 1) problems.push(`expected 1 error, got ${errors.length}`);
  if (events.length !== 3) problems.push(`expected 3 events, got ${events.length}`);
  if (traces.length !== 150) problems.push(`expected 150 traces, got ${traces.length}`);

  const error = errors[0];
  if (error) {
    if (error._watchup_truncated !== true) problems.push('oversized error was not marked _watchup_truncated');
    if (error.user?.id !== 'contract-user') problems.push(`error user is ${JSON.stringify(error.user)}`);
    const raw = JSON.stringify(error);
    if (raw.includes('hunter2') || raw.includes('secret-token-123')) problems.push('secret reached the server');
  }
  // FIFO holds within each chunk; a retried chunk may land after later ones
  // (spec §7), so allow one break in the sequence per retried request.
  const indexes = traces.map((t) => Number(String(t.span).replace('contract-trace-', '')));
  const breaks = indexes.filter((n, i) => i > 0 && n < indexes[i - 1]).length;
  if (new Set(indexes).size !== 150 || Math.max(...indexes) !== 149) problems.push('traces are missing or duplicated');
  const retriedRequests = state.requests.length - new Set(state.requests.map((r) => r.headers['idempotency-key'])).size;
  if (breaks > retriedRequests) problems.push(`traces out of order (${breaks} breaks, ${retriedRequests} retried requests)`);

  for (const r of state.requests) {
    if (r.bytes > 196_608) problems.push(`request of ${r.bytes} bytes exceeds the 192 KiB target`);
  }
  const keys = state.requests.map((r) => r.headers['idempotency-key']).filter(Boolean);
  const retried = keys.length !== new Set(keys).size;
  if (!retried) problems.push('the scripted 503 was not retried with the same Idempotency-Key');
  for (const r of state.requests) {
    if (!/^(watchup-|@watchupltd\/)/.test(r.headers['user-agent'] ?? '')) problems.push(`unexpected User-Agent ${r.headers['user-agent']}`);
  }

  if (problems.length) {
    failed = true;
    console.error(`✗ ${lang}`);
    for (const p of [...new Set(problems)]) console.error(`    ${p}`);
  } else {
    console.log(`✓ ${lang}: ${state.requests.length} requests, ${errors.length + events.length + traces.length} items, retry reused key`);
  }
}

await mock.close();
process.exit(failed ? 1 : 0);
