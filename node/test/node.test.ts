import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { Watchup, normalisePath } from '../src/index.js';
// @ts-expect-error — plain ESM module without types
import { createMockIngest } from '../../tools/mock-ingest/server.mjs';

let mock: ReturnType<typeof createMockIngest>;
let ingestUrl: string;
let clients: Watchup[] = [];

beforeAll(async () => {
  mock = createMockIngest();
  ingestUrl = await mock.listen();
});
afterAll(() => mock.close());
beforeEach(() => fetch(`${ingestUrl}/__mock/reset`, { method: 'POST' }));
afterEach(async () => {
  await Promise.all(clients.map((c) => c.shutdown()));
  clients = [];
});

const state = () => fetch(`${ingestUrl}/__mock/state`).then((r) => r.json());

function client(options: Partial<ConstructorParameters<typeof Watchup>[0]> = {}) {
  const c = new Watchup({
    apiKey: 'wup_live_test',
    baseUrl: ingestUrl,
    environment: 'test',
    release: 'r1',
    flushInterval: 60_000,
    flagRefreshInterval: 0,
    handleSignals: false,
    ...options,
  });
  clients.push(c);
  return c;
}

async function serve(app: express.Express): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) };
}

describe('normalisePath', () => {
  it('replaces ids and strips query strings', () => {
    expect(normalisePath('/users/42/orders/3f2504e0-4f89-11d3-9a0c-0305e82c3301?token=x')).toBe('/users/:id/orders/:id');
    expect(normalisePath('/objects/507f1f77bcf86cd799439011/')).toBe('/objects/:id');
    expect(normalisePath('/v2/items')).toBe('/v2/items');
  });
});

describe('Express integration', () => {
  it('records route templates, preserves status/headers, and isolates users across concurrent requests', async () => {
    const watchup = client({ service: 'api' });
    const app = express();
    app.use(watchup.requestMiddleware());
    app.use((req, _res, next) => {
      watchup.setUser({ id: String(req.headers['x-user']) });
      next();
    });
    const router = express.Router();
    router.get('/users/:id', async (req, res) => {
      // Interleave the two requests.
      await new Promise((r) => setTimeout(r, req.params.id === '1' ? 30 : 5));
      watchup.track('user.viewed', { id: req.params.id });
      res.status(203).set('X-Custom', 'kept').json({ id: req.params.id });
    });
    app.use('/api', router);
    const { url, close } = await serve(app);

    const [a, b] = await Promise.all([
      fetch(`${url}/api/users/1`, { headers: { 'x-user': 'alice', 'x-request-id': 'req-a' } }),
      fetch(`${url}/api/users/2`, { headers: { 'x-user': 'bob' } }),
    ]);
    expect(a.status).toBe(203);
    expect(a.headers.get('x-custom')).toBe('kept');
    expect(b.status).toBe(203);
    await close();
    await watchup.flush();

    const s = await state();
    expect(s.violations).toEqual([]);
    const traces = s.accepted.traces;
    expect(traces.map((t: { span: string }) => t.span)).toEqual(['GET /api/users/:id', 'GET /api/users/:id']);
    const alice = traces.find((t: { user: { id: string } }) => t.user.id === 'alice');
    expect(alice).toMatchObject({ type: 'http', status_code: 203, meta: { request_id: 'req-a', service: 'api', source: 'server' } });
    const events = s.accepted.events;
    for (const e of events) {
      expect(e.properties.user.id).toBe(e.properties.id === '1' ? 'alice' : 'bob');
    }
    expect(s.requests[0].headers['idempotency-key']).toMatch(/^wu_/);
    expect(s.requests[0].headers['user-agent']).toMatch(/^@watchupltd\/node\/\d/);
  });

  it('captures thrown and rejected errors exactly once and keeps the original error flow', async () => {
    const watchup = client();
    const app = express();
    app.use(watchup.requestMiddleware());
    app.get('/sync', () => {
      throw Object.assign(new Error('sync boom'), { status: 502 });
    });
    // wrapAsync makes rejections reach next(err) on Express 4 (Express 5 does it natively).
    app.get(
      '/async',
      watchup.wrapAsync(async () => {
        throw new TypeError('async boom');
      }),
    );
    app.get('/bad-input', (_req, _res, next) => next(Object.assign(new Error('nope'), { status: 422 })));
    app.use(watchup.errorMiddleware());
    // A second pass through the middleware must not double-report.
    app.use(watchup.errorMiddleware());
    const seen: string[] = [];
    app.use((err: Error & { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      seen.push(err.message);
      res.status(err.status ?? 500).json({ error: err.message });
    });
    const { url, close } = await serve(app);

    expect((await fetch(`${url}/sync`)).status).toBe(502);
    expect((await fetch(`${url}/async`)).status).toBe(500);
    expect((await fetch(`${url}/bad-input`)).status).toBe(422);
    await close();
    await watchup.flush();

    expect(seen).toEqual(['sync boom', 'async boom', 'nope']);
    const { accepted } = await state();
    expect(accepted.errors.map((e: { message: string }) => e.message)).toEqual(['sync boom', 'async boom', 'nope']);
    expect(accepted.errors[1]).toMatchObject({ type: 'TypeError', route: 'GET /async', level: 'error' });
    expect(accepted.errors[2]).toMatchObject({ level: 'warning', context: { request: { status_code: 422 } } });
    expect(accepted.traces.map((t: { status_code: number }) => t.status_code)).toEqual([502, 500, 422]);
  });

  it('wrapAsync forwards rejections for Express 4 style handlers', async () => {
    const watchup = client();
    const next = vi.fn();
    watchup.wrapAsync(async () => {
      throw new Error('rejected');
    })({}, {}, next);
    await new Promise((r) => setTimeout(r, 0));
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'rejected' }));
  });

  it('never copies authorization headers or cookies into error context', async () => {
    const watchup = client();
    const app = express();
    app.use(watchup.requestMiddleware());
    app.get('/secret', (_req, _res, next) => next(new Error('x')));
    app.use(watchup.errorMiddleware());
    app.use((_err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.sendStatus(500));
    const { url, close } = await serve(app);
    await fetch(`${url}/secret?token=abc&page=1`, { headers: { Authorization: 'Bearer abc', Cookie: 'sid=1' } });
    await close();
    await watchup.flush();
    const s = await state();
    const raw = JSON.stringify(s.accepted.errors);
    expect(raw).not.toContain('sid=1');
    expect(raw).not.toContain('Bearer abc');
    expect(s.accepted.errors[0].context.request.url).toBe('/secret?token=[REDACTED]&page=1');
    expect(s.violations).toEqual([]);
  });
});

describe('delivery', () => {
  it('splits oversized and Unicode payloads within limits and retries with the same key', async () => {
    const watchup = client();
    await fetch(`${ingestUrl}/__mock/script`, { method: 'POST', body: JSON.stringify({ statuses: [503] }) });
    watchup.captureError(new Error('x'.repeat(256_000)));
    for (let i = 0; i < 3; i++) watchup.track(`u${i}`, { text: 'é'.repeat(60_000) });
    await watchup.flush();
    await (watchup as any).queue.flush({ force: true }); // eslint-disable-line @typescript-eslint/no-explicit-any

    const s = await state();
    expect(s.violations).toEqual([]);
    expect(s.accepted.errors).toHaveLength(1);
    expect(s.accepted.errors[0]._watchup_truncated).toBe(true);
    expect(s.accepted.events).toHaveLength(3);
    const keys = s.requests.map((r: { headers: Record<string, string> }) => r.headers['idempotency-key']);
    expect(keys[0]).toBe(keys[keys.length - 1]); // the 503'd chunk was retried last with its key
  });

  it('shutdown delivers pending items and stops capturing', async () => {
    const watchup = client();
    watchup.captureError(new Error('pending'));
    watchup.track('pending');
    await watchup.shutdown();
    watchup.track('after-shutdown');
    const s = await state();
    expect(s.accepted.errors).toHaveLength(1);
    expect(s.accepted.events.map((e: { name: string }) => e.name)).toEqual(['pending']);
  });

  it('reports what it could not deliver on shutdown', async () => {
    const onDiagnostic = vi.fn();
    const watchup = client({ baseUrl: 'http://127.0.0.1:9', shutdownTimeout: 0, onDiagnostic });
    watchup.track('lost');
    await watchup.shutdown();
    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ type: 'undelivered_on_shutdown' }));
  });
});

describe('manual instrumentation', () => {
  it('traceQuery sanitizes SQL, never records parameters, and marks slow queries', async () => {
    const watchup = client();
    await watchup.traceQuery("SELECT * FROM users WHERE email = 'ada@example.com'", async () => {
      await new Promise((r) => setTimeout(r, 20));
      return [];
    }, { system: 'postgresql', slowMs: 5 });
    await expect(watchup.traceQuery('DELETE FROM x WHERE id = $1', async () => {
      throw new Error('db down');
    })).rejects.toThrow('db down');
    await watchup.flush();
    const traces = (await state()).accepted.traces;
    expect(traces[0]).toMatchObject({ span: 'SELECT * FROM users WHERE email = ?', type: 'db', status: 'warn', meta: { db_system: 'postgresql', slow: true } });
    expect(traces[1]).toMatchObject({ span: 'DELETE FROM x WHERE id = $1', status: 'err' });
  });

  it('runWithContext isolates job users from the default user', async () => {
    const watchup = client();
    watchup.setUser({ id: 'default' });
    await Promise.all([
      watchup.runWithContext({}, async () => {
        watchup.setUser({ id: 'job-1' });
        await new Promise((r) => setTimeout(r, 10));
        watchup.captureError(new Error('job-1'));
      }),
      watchup.runWithContext({}, async () => {
        watchup.setUser({ id: 'job-2' });
        watchup.captureError(new Error('job-2'));
      }),
    ]);
    watchup.captureError(new Error('outside'));
    await watchup.flush();
    const errors = (await state()).accepted.errors;
    const byMessage = Object.fromEntries(errors.map((e: { message: string; user: { id: string } }) => [e.message, e.user.id]));
    expect(byMessage).toEqual({ 'job-1': 'job-1', 'job-2': 'job-2', outside: 'default' });
  });
});

describe('signals', () => {
  it('does not remove the application’s own signal handlers', async () => {
    const appHandler = vi.fn();
    process.on('SIGTERM', appHandler);
    const watchup = client({ handleSignals: true });
    expect(process.listenerCount('SIGTERM')).toBe(2);
    await watchup.shutdown();
    expect(process.listeners('SIGTERM')).toContain(appHandler);
    process.off('SIGTERM', appHandler);
  });
});

describe('bundle', () => {
  it('does not reference browser globals', () => {
    const src = readFileSync(new URL('../src/watchup.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/\b(window|document|navigator|localStorage)\./);
  });
});
