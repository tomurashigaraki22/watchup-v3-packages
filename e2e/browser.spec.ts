// Browser matrix (plan §4.1): the built @watchupltd/browser bundle in real
// Chromium, Firefox and WebKit, against the mock ingest server.

import { expect, test } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
// @ts-expect-error — plain ESM module without types
import { createMockIngest } from '../tools/mock-ingest/server.mjs';

let mock: ReturnType<typeof createMockIngest>;
let ingestUrl: string;
let site: Server;
let siteUrl: string;

const bundle = readFileSync(join(__dirname, '..', 'browser', 'dist', 'index.mjs'), 'utf8');

test.beforeAll(async () => {
  mock = createMockIngest({ keys: ['wup_pub_e2e'] });
  ingestUrl = await mock.listen();
  site = createServer((req, res) => {
    if (req.url === '/watchup.mjs') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      res.end(bundle);
    } else if (req.url?.startsWith('/next')) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><title>next</title><p>next page</p>');
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!doctype html><title>e2e</title>
<script type="module">
  import { Watchup } from '/watchup.mjs';
  window.watchup = new Watchup({
    apiKey: 'wup_pub_e2e',
    baseUrl: ${JSON.stringify(ingestUrl)},
    flushInterval: 60000,
    flagRefreshInterval: 0,
    autoCapture: { errors: true, performance: false, pageViews: false },
  });
  window.ready = true;
</script>`);
    }
  });
  await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', () => resolve()));
  siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  await mock.close();
  await new Promise((resolve) => site.close(resolve));
});

test.beforeEach(() => fetch(`${ingestUrl}/__mock/reset`, { method: 'POST' }));

const state = () => fetch(`${ingestUrl}/__mock/state`).then((r) => r.json());

test('delivers byte-aware chunks with fetch and reports uncaught errors', async ({ page }) => {
  await page.goto(siteUrl);
  await page.waitForFunction(() => (window as unknown as { ready?: boolean }).ready);
  await page.evaluate(async () => {
    const w = (window as unknown as { watchup: { track: Function; captureError: Function; flush: () => Promise<unknown> } }).watchup;
    for (let i = 0; i < 3; i++) w.track(`unicode-${i}`, { text: 'é'.repeat(60_000) });
    w.captureError(new Error('x'.repeat(256_000)), { headers: { Authorization: 'Bearer browser-secret' } });
    setTimeout(() => {
      throw new Error('uncaught in the browser');
    });
    await new Promise((r) => setTimeout(r, 50));
    await w.flush();
  });
  await expect.poll(async () => (await state()).accepted.events.length).toBe(3);
  const s = await state();
  expect(s.violations).toEqual([]);
  expect(s.accepted.errors.map((e: { message: string }) => e.message.slice(0, 24))).toContain('uncaught in the browser');
  expect(JSON.stringify(s.accepted.errors)).not.toContain('browser-secret');
  for (const r of s.requests) expect(r.bytes).toBeLessThanOrEqual(192 * 1024);
});

test('sends queued items with sendBeacon when the page is left', async ({ page }) => {
  await page.goto(siteUrl);
  await page.waitForFunction(() => (window as unknown as { ready?: boolean }).ready);
  await page.evaluate(() => {
    (window as unknown as { watchup: { track: Function } }).watchup.track('before-unload', { step: 1 });
  });
  await page.goto(`${siteUrl}/next`);
  await expect.poll(async () => (await state()).accepted.events.length, { timeout: 10_000 }).toBe(1);
  const s = await state();
  expect(s.violations).toEqual([]);
  // A beacon cannot set headers: it authenticates with project_id in the body.
  expect(s.requests[0].headers.authorization).toBeUndefined();
});

test('anything over the browser beacon budget is delivered on the next page load, once', async ({ page }) => {
  await page.goto(siteUrl);
  await page.waitForFunction(() => (window as unknown as { ready?: boolean }).ready);
  await page.evaluate(() => {
    const w = (window as unknown as { watchup: { track: Function } }).watchup;
    // ~200 KiB: more than the ~64 KiB browsers allow in flight during unload.
    for (let i = 0; i < 5; i++) w.track(`big-${i}`, { text: 'x'.repeat(40_000) });
  });
  await page.goto(`${siteUrl}/next`);
  await page.goto(siteUrl); // the SDK loads again and resends what was stored
  await expect.poll(async () => (await state()).accepted.events.length, { timeout: 15_000 }).toBe(5);
  const s = await state();
  expect(s.violations).toEqual([]);
  for (const r of s.requests) {
    // Beacons (no Authorization header) stay within the beacon budget; regular
    // flushes within the 192 KiB chunk target.
    expect(r.bytes).toBeLessThanOrEqual(r.headers.authorization ? 192 * 1024 : 61_440);
  }
});
