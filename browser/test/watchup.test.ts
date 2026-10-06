import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Watchup } from '../src/index.js';
import { LIMITS } from '@watchupltd/core';

interface Call {
  url: string;
  body: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  headers: Record<string, string>;
  keepalive?: boolean;
}

let calls: Call[];
let beacons: Array<{ url: string; body: Record<string, any> }>; // eslint-disable-line @typescript-eslint/no-explicit-any
let ingestStatus: number[];
let flagsResponse: unknown;
let clients: Watchup[];

function client(options: Partial<ConstructorParameters<typeof Watchup>[0]> = {}) {
  const c = new Watchup({
    apiKey: 'wup_pub_test',
    baseUrl: 'https://ingest.test',
    flushInterval: 60_000,
    flagRefreshInterval: 0,
    autoCapture: { errors: true, performance: false, pageViews: false },
    ...options,
  });
  clients.push(c);
  return c;
}

const ingestCalls = () => calls.filter((c) => c.url.endsWith('/api/v1/ingest/batch'));
const allItems = (kind: 'errors' | 'traces' | 'events') => ingestCalls().flatMap((c) => c.body[kind]);

beforeEach(() => {
  calls = [];
  beacons = [];
  ingestStatus = [];
  clients = [];
  flagsResponse = { ok: true, data: { flags: [] } };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const body = init.body ? JSON.parse(String(init.body)) : {};
    calls.push({ url, body, headers: (init.headers ?? {}) as Record<string, string>, keepalive: init.keepalive });
    if (url.endsWith('/api/v1/flags')) return new Response(JSON.stringify(flagsResponse), { status: 200 });
    const status = ingestStatus.shift() ?? 201;
    return new Response(JSON.stringify(status < 300 ? { ok: true } : { ok: false, code: 'boom' }), { status });
  }));
  Object.defineProperty(navigator, 'sendBeacon', {
    configurable: true,
    value: vi.fn((url: string, blob: Blob) => {
      // jsdom Blob → read synchronously via the test's text cache.
      beacons.push({ url, body: (blob as Blob & { __text?: string }).__text ? JSON.parse((blob as any).__text) : {} });
      return true;
    }),
  });
  // Make Blob contents inspectable for sendBeacon assertions.
  const RealBlob = globalThis.Blob;
  vi.stubGlobal('Blob', class extends RealBlob {
    __text: string;
    constructor(parts: BlobPart[], opts?: BlobPropertyBag) {
      super(parts, opts);
      this.__text = parts.map(String).join('');
    }
  });
});

afterEach(async () => {
  await Promise.all(clients.map((c) => c.shutdown()));
  vi.unstubAllGlobals();
});

describe('construction', () => {
  it('requires an apiKey', () => {
    expect(() => new Watchup({ apiKey: '' })).toThrow(/apiKey/);
  });
});

describe('envelope and transport', () => {
  it('sends the shared envelope with sdk info, auth headers and a body idempotency key', async () => {
    const w = client({ release: 'abc123', environment: 'staging' });
    w.track('signup', { plan: 'pro' });
    await w.flush();

    const [call] = ingestCalls();
    expect(call!.body.sdk).toEqual({ name: '@watchupltd/browser', version: expect.stringMatching(/^\d+\.\d+\.\d+/) });
    expect(call!.body.environment).toBe('staging');
    expect(call!.body.release).toBe('abc123');
    expect(call!.body.project_id).toBe('wup_pub_test');
    expect(call!.body.idempotency_key).toMatch(/^wu_[0-9a-f-]+_0$/);
    expect(call!.headers.Authorization).toBe('Bearer wup_pub_test');
    // CORS on the production API does not allow this header from browsers.
    expect(call!.headers['Idempotency-Key']).toBeUndefined();
    expect(call!.body.events[0]).toMatchObject({ name: 'signup', properties: { plan: 'pro', source: 'browser' } });
  });

  it('never puts a secret live key in the body', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const w = client({ apiKey: 'wup_live_secret' });
    w.track('x');
    await w.flush();
    expect(ingestCalls()[0]!.body.project_id).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('secret wup_live_ key'));
    warn.mockRestore();
  });

  it('splits by UTF-8 bytes and only uses keepalive for small bodies', async () => {
    const w = client();
    for (let i = 0; i < 3; i++) w.track(`e${i}`, { text: 'é'.repeat(60_000) });
    await w.flush();
    const sent = ingestCalls();
    expect(sent).toHaveLength(3);
    for (const c of sent) {
      expect(new TextEncoder().encode(JSON.stringify(c.body)).length).toBeLessThanOrEqual(LIMITS.MAX_CHUNK_BYTES);
      expect(c.keepalive).toBe(false);
    }
    expect(new Set(sent.map((c) => c.body.idempotency_key)).size).toBe(3);
  });

  it('retries a failed chunk with the same idempotency key', async () => {
    ingestStatus = [503];
    const w = client();
    w.track('retry-me');
    await w.flush();
    await (w as any).queue.flush({ force: true });
    const sent = ingestCalls();
    expect(sent).toHaveLength(2);
    expect(sent[0]!.body.idempotency_key).toBe(sent[1]!.body.idempotency_key);
  });

  it('reports diagnostics through onDiagnostic', async () => {
    ingestStatus = [400];
    const onDiagnostic = vi.fn();
    const w = client({ onDiagnostic });
    w.track('bad');
    await w.flush();
    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ type: 'chunk_rejected' }));
  });
});

describe('capture', () => {
  it('captures errors with type, route, device and user at capture time', async () => {
    const w = client({ service: 'web' });
    w.setUser({ id: 'u1', email: 'ada@example.com' });
    history.pushState({}, '', '/checkout');
    w.captureError(new TypeError('boom'), { component: 'Cart' });
    w.clearUser();
    history.pushState({}, '', '/elsewhere');
    await w.flush();

    const [error] = allItems('errors');
    expect(error).toMatchObject({
      message: 'boom',
      type: 'TypeError',
      route: '/checkout',
      user: { id: 'u1' },
      context: { component: 'Cart', source: 'browser', service: 'web', device: { language: expect.any(String) } },
    });
  });

  it('flattens a nested context object (ErrorBoundary style)', async () => {
    const w = client();
    w.captureError(new Error('x'), { level: 'fatal', context: { componentStack: 'at App' } });
    await w.flush();
    expect(allItems('errors')[0]).toMatchObject({ level: 'fatal', context: { componentStack: 'at App' } });
  });

  it('redacts secrets in captured context', async () => {
    const w = client();
    w.captureError(new Error('Request failed with Bearer abc.def'), { headers: { Authorization: 'Bearer abc.def', cookie: 'sid=1' } });
    await w.flush();
    const error = allItems('errors')[0];
    expect(error.message).toBe('Request failed with Bearer [REDACTED]');
    expect(error.context.headers).toEqual({ Authorization: '[REDACTED]', cookie: '[REDACTED]' });
  });

  it('captures window errors and unhandled rejections', async () => {
    const w = client();
    window.dispatchEvent(new ErrorEvent('error', { message: 'kaboom', error: new Error('kaboom') }));
    const rejection = new Event('unhandledrejection') as Event & { reason: unknown };
    rejection.reason = new Error('rejected');
    window.dispatchEvent(rejection);
    // Resource load failures have no message and are ignored.
    window.dispatchEvent(new ErrorEvent('error', {}));
    await w.flush();
    expect(allItems('errors').map((e) => e.message)).toEqual(['kaboom', 'rejected']);
  });

  it('records traces with the route where they started', async () => {
    const w = client();
    history.pushState({}, '', '/start');
    const end = w.startTrace('load cart', { type: 'http' });
    history.pushState({}, '', '/later');
    end({ status: 'warn', meta: { items: 3 } });
    end(); // second call is ignored
    await w.flush();
    const traces = allItems('traces');
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({ span: 'load cart', type: 'http', status: 'warn', status_code: 400, meta: { items: 3, route: '/start' } });
  });

  it('console capture never loops through SDK warnings', async () => {
    const w = client({ debug: true, logging: { enabled: true, captureConsole: true } });
    console.error('user error', { a: 1 });
    ingestStatus = [400];
    await w.flush();
    const logs = allItems('events').filter((e) => e.name.startsWith('log.'));
    expect(logs).toHaveLength(1);
    expect(logs[0].properties.message).toBe('user error {"a":1}');
  });
});

describe('page lifecycle', () => {
  it('uses sendBeacon for beacon-sized chunks on page hide', () => {
    const w = client();
    w.track('a');
    w.captureError(new Error('b'));
    window.dispatchEvent(new Event('pagehide'));
    expect(beacons).toHaveLength(1);
    expect(beacons[0]!.body.project_id).toBe('wup_pub_test');
    expect(beacons[0]!.body.errors).toHaveLength(1);
    expect(w).toBeDefined();
  });

  it('never passes an oversized chunk to sendBeacon', () => {
    const w = client();
    for (let i = 0; i < 4; i++) w.track(`big${i}`, { text: 'x'.repeat(40_000) });
    window.dispatchEvent(new Event('pagehide'));
    for (const b of beacons) {
      expect(new TextEncoder().encode(JSON.stringify(b.body)).length).toBeLessThanOrEqual(LIMITS.BEACON_MAX_BYTES);
    }
    expect(beacons.flatMap((b) => b.body.events)).toHaveLength(4);
  });

  it('keeps refused chunks for the next page load and resends them with the same key', async () => {
    (navigator.sendBeacon as ReturnType<typeof vi.fn>).mockReturnValue(false);
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('keepalive budget exceeded');
    }));
    const first = client();
    first.track('survives-unload');
    window.dispatchEvent(new Event('pagehide'));
    await new Promise((r) => setTimeout(r, 0));
    const stored = JSON.parse(localStorage.getItem('__wup_unsent_v1') ?? '[]');
    expect(stored).toHaveLength(1);

    // Next page: fetch works again.
    const keys: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      keys.push(JSON.parse(String(init.body)).idempotency_key);
      return new Response('{"ok":true}', { status: 201 });
    }));
    const second = client();
    await second.flush();
    expect(keys).toEqual([stored[0].idempotencyKey]);
    expect(localStorage.getItem('__wup_unsent_v1')).toBeNull();
  });

  it('falls back to fetch keepalive when sendBeacon refuses', () => {
    (navigator.sendBeacon as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const w = client();
    w.track('fallback');
    window.dispatchEvent(new Event('pagehide'));
    const sent = ingestCalls();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.keepalive).toBe(true);
    expect(w).toBeDefined();
  });
});

describe('page views', () => {
  it('tracks SPA navigations once even with two clients and stops after shutdown', async () => {
    const a = client({ autoCapture: { pageViews: true, errors: false, performance: false } });
    const b = client({ autoCapture: { pageViews: true, errors: false, performance: false } });
    await new Promise((r) => setTimeout(r, 5));
    await a.flush();
    await b.flush();
    calls = [];
    history.pushState({}, '', '/pricing');
    await new Promise((r) => setTimeout(r, 5));
    await a.flush();
    await b.flush();
    const views = calls.filter((c) => c.url.endsWith('/web-batch')).flatMap((c) => c.body.web);
    expect(views.map((v: { path: string }) => v.path)).toEqual(['/pricing', '/pricing']);

    await a.shutdown();
    await b.shutdown();
    calls = [];
    history.pushState({}, '', '/after');
    await new Promise((r) => setTimeout(r, 5));
    expect(calls.filter((c) => c.url.endsWith('/web-batch'))).toHaveLength(0);
  });
});

describe('feature flags', () => {
  it('evaluates locally after a refresh and notifies subscribers', async () => {
    flagsResponse = {
      ok: true,
      data: { flags: [{ id: '1', key: 'new-ui', name: 'New UI', enabled: true, rollout_percentage: 100, variants: [], targeting_rules: [] }] },
    };
    const w = client();
    const listener = vi.fn();
    w.onFlagsChange(listener);
    expect(w.isEnabled('new-ui')).toBe(false);
    await w.refreshFlags();
    expect(w.isEnabled('new-ui')).toBe(true);
    expect(w.getVariant('new-ui')).toBe('on');
    expect(listener).toHaveBeenCalled();
  });

  it('keeps the cached flags when a refresh fails', async () => {
    flagsResponse = {
      ok: true,
      data: { flags: [{ id: '1', key: 'f', name: 'F', enabled: true, rollout_percentage: 100, variants: [], targeting_rules: [] }] },
    };
    const w = client();
    await w.refreshFlags();
    flagsResponse = { ok: false };
    await w.refreshFlags();
    expect(w.isEnabled('f')).toBe(true);
  });
});
