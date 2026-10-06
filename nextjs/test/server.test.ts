import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import {
  captureRequestError,
  getWatchup,
  initWatchup,
  registerWatchup,
  withWatchupApi,
  withWatchupRoute,
} from '../src/server/index.js';
import { _resetWatchup } from '../src/server/watchup.js';
// @ts-expect-error — plain ESM module without types
import { createMockIngest } from '../../tools/mock-ingest/server.mjs';

let mock: ReturnType<typeof createMockIngest>;
let ingestUrl: string;

beforeAll(async () => {
  mock = createMockIngest();
  ingestUrl = await mock.listen();
});
afterAll(() => mock.close());
beforeEach(async () => {
  await fetch(`${ingestUrl}/__mock/reset`, { method: 'POST' });
  delete process.env.NEXT_RUNTIME;
  initWatchup({ apiKey: 'wup_live_test', baseUrl: ingestUrl, flushInterval: 60_000, flagRefreshInterval: 0, handleSignals: false });
});
afterEach(() => _resetWatchup());

const state = () => fetch(`${ingestUrl}/__mock/state`).then((r) => r.json());

describe('server singleton', () => {
  it('initialises exactly once and is shared through globalThis', () => {
    const first = getWatchup();
    expect(initWatchup({ apiKey: 'other' })).toBe(first);
    registerWatchup();
    expect(getWatchup()).toBe(first);
  });

  it('fails with a clear message on the Edge runtime', async () => {
    await _resetWatchup();
    process.env.NEXT_RUNTIME = 'edge';
    expect(() => initWatchup({ apiKey: 'k' })).toThrow(/Node\.js runtime only/);
    // register() is called for every runtime and must be a no-op on edge.
    expect(() => registerWatchup({ apiKey: 'k' })).not.toThrow();
  });
});

describe('withWatchupRoute', () => {
  it('preserves the response and records the real status with a route template', async () => {
    const GET = withWatchupRoute(
      async () => new Response('teapot', { status: 418, headers: { 'X-Kept': 'yes' } }),
      { route: '/api/orders/[id]' },
    );
    const res = await GET(new Request('http://app.test/api/orders/42', { headers: { 'x-request-id': 'r-1' } }));
    expect(res.status).toBe(418);
    expect(res.headers.get('x-kept')).toBe('yes');
    expect(await res.text()).toBe('teapot');
    await getWatchup().flush();
    const { accepted } = await state();
    expect(accepted.traces[0]).toMatchObject({ span: 'GET /api/orders/[id]', type: 'http', status_code: 418, status: 'warn', meta: { request_id: 'r-1' } });
  });

  it('captures a thrown error once and re-throws it unchanged', async () => {
    const boom = new Error('route failed');
    const POST = withWatchupRoute(async () => {
      throw boom;
    });
    await expect(POST(new Request('http://app.test/api/items/7', { method: 'POST' }))).rejects.toBe(boom);
    captureRequestError(boom, { path: '/api/items/7', method: 'POST' }, { routerKind: 'App Router', routePath: '/api/items/[id]', routeType: 'route' });
    await getWatchup().flush();
    const { accepted } = await state();
    expect(accepted.errors).toHaveLength(1);
    expect(accepted.errors[0]).toMatchObject({ message: 'route failed', route: 'POST /api/items/:id' });
    expect(accepted.traces[0]).toMatchObject({ status_code: 500, status: 'err' });
  });

  it('does not report notFound()/redirect() control flow as errors', async () => {
    const GET = withWatchupRoute(async () => {
      throw Object.assign(new Error('NEXT_NOT_FOUND'), { digest: 'NEXT_NOT_FOUND' });
    });
    await expect(GET(new Request('http://app.test/missing'))).rejects.toThrow();
    await getWatchup().flush();
    const { accepted } = await state();
    expect(accepted.errors).toHaveLength(0);
    expect(accepted.traces[0].status_code).toBe(404);
  });

  it('scopes setUser to the request', async () => {
    const GET = withWatchupRoute(async (req: Request) => {
      getWatchup().setUser({ id: new URL(req.url).searchParams.get('u')! });
      await new Promise((r) => setTimeout(r, req.url.endsWith('a') ? 20 : 1));
      getWatchup().track('seen');
      return new Response('ok');
    });
    await Promise.all([GET(new Request('http://app.test/x?u=a')), GET(new Request('http://app.test/x?u=b'))]);
    await getWatchup().flush();
    const users = (await state()).accepted.events.map((e: { properties: { user: { id: string } } }) => e.properties.user.id);
    expect(users.sort()).toEqual(['a', 'b']);
  });
});

describe('withWatchupApi (Pages Router)', () => {
  it('records the final status code', async () => {
    const handler = withWatchupApi(async (_req, res: EventEmitter & { statusCode: number }) => {
      res.statusCode = 201;
      res.emit('finish');
    }, { route: '/api/users/[id]' });
    const res = Object.assign(new EventEmitter(), { statusCode: 200 });
    await handler({ method: 'post', url: '/api/users/9', headers: {} }, res);
    await getWatchup().flush();
    expect((await state()).accepted.traces[0]).toMatchObject({ span: 'POST /api/users/[id]', status_code: 201 });
  });
});

describe('client bundle', () => {
  it('never references the server key environment variable', () => {
    for (const file of ['../dist/client/index.mjs', '../dist/client/index.js']) {
      let src = '';
      try {
        src = readFileSync(new URL(file, import.meta.url), 'utf8');
      } catch {
        continue; // Not built in this run; the CI build step covers it.
      }
      expect(src).not.toMatch(/(?<!NEXT_PUBLIC_)WATCHUP_API_KEY/);
      expect(src).not.toMatch(/wup_live_[A-Za-z0-9]/);
    }
  });
});
