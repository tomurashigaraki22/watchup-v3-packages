import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WatchupReactNative } from '../src/index.js';
import { _setNetInfo, _setReactNative } from '../src/device.js';
import type { QueueStorage } from '../src/types.js';

interface Sent {
  headers: Record<string, string>;
  body: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

let sent: Sent[];
let status: number;
let clients: WatchupReactNative[];
let appStateListener: ((state: string) => void) | null;
let netListener: ((state: { isConnected: boolean | null }) => void) | null;

function memoryStorage(): QueueStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: async (k) => data.get(k) ?? null,
    setItem: async (k, v) => void data.set(k, v),
    removeItem: async (k) => void data.delete(k),
  };
}

function client(options: Partial<ConstructorParameters<typeof WatchupReactNative>[0]> = {}) {
  const c = new WatchupReactNative({
    apiKey: 'wup_pub_rn',
    baseUrl: 'https://ingest.test',
    flushInterval: 60_000,
    storage: null,
    ...options,
  });
  clients.push(c);
  return c;
}

const items = (kind: 'errors' | 'traces' | 'events') => sent.flatMap((s) => s.body[kind]);

beforeEach(() => {
  sent = [];
  status = 201;
  clients = [];
  appStateListener = null;
  netListener = null;
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    if (status >= 500) throw new TypeError('Network request failed');
    sent.push({ headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    return new Response('{"ok":true}', { status });
  }));
  _setReactNative({
    Platform: { OS: 'ios', Version: '17.4', isTV: false },
    Dimensions: { get: () => ({ width: 390, height: 844, scale: 3, fontScale: 1 }) },
    AppState: {
      addEventListener: (_e: string, fn: (s: string) => void) => {
        appStateListener = fn;
        return { remove: () => (appStateListener = null) };
      },
    },
  });
  _setNetInfo({
    addEventListener: (fn) => {
      netListener = fn;
      return () => (netListener = null);
    },
  });
});

afterEach(async () => {
  await Promise.all(clients.map((c) => c.shutdown()));
  vi.unstubAllGlobals();
  delete (globalThis as Record<string, unknown>).ErrorUtils;
  delete (globalThis as Record<string, unknown>).HermesInternal;
});

describe('transport', () => {
  it('sends the envelope with Idempotency-Key and device context', async () => {
    const w = client({ release: '1.4.0', service: 'mobile' });
    w.setUser({ id: 'u1' });
    w.captureError(new RangeError('bad index'));
    await w.flush();
    const [request] = sent;
    expect(request!.headers['Idempotency-Key']).toBe(request!.body.idempotency_key);
    expect(request!.headers['User-Agent']).toMatch(/^@watchupltd\/react-native\//);
    expect(request!.body.sdk.name).toBe('@watchupltd/react-native');
    expect(items('errors')[0]).toMatchObject({
      type: 'RangeError',
      route: 'react-native',
      user: { id: 'u1' },
      context: { source: 'react-native', service: 'mobile', device: { os: 'ios', hermes: false } },
    });
  });

  it('chunks oversized payloads by bytes', async () => {
    const w = client();
    for (let i = 0; i < 3; i++) w.track(`e${i}`, { text: 'é'.repeat(60_000) });
    await w.flush();
    expect(sent).toHaveLength(3);
  });
});

describe('connectivity and app state', () => {
  it('holds items while offline without using retry attempts, then sends on reconnect', async () => {
    const onDiagnostic = vi.fn();
    const w = client({ onDiagnostic });
    netListener!({ isConnected: false });
    w.track('offline-1');
    w.track('offline-2');
    await w.flush();
    expect(sent).toHaveLength(0);
    expect(w.isOnline).toBe(false);
    netListener!({ isConnected: true });
    await vi.waitFor(() => expect(items('events')).toHaveLength(2));
    expect(onDiagnostic).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'chunk_dropped' }));
  });

  it('flushes when the app goes to the background', async () => {
    const w = client();
    w.track('before-background');
    appStateListener!('background');
    await vi.waitFor(() => expect(items('events').map((e: { name: string }) => e.name)).toContain('before-background'));
  });
});

describe('offline persistence', () => {
  it('restores undelivered items on the next launch and sends them with their original key', async () => {
    const storage = memoryStorage();
    status = 503;
    const first = client({ storage });
    first.captureError(new Error('lost-in-flight'));
    first.track('pending-event');
    await first.flush();
    await first.shutdown();
    expect([...storage.data.values()][0]).toContain('lost-in-flight');
    const snapshot = JSON.parse([...storage.data.values()][0]!);
    const retryKey = snapshot.retry[0]?.idempotencyKey;

    status = 201;
    const second = client({ storage });
    await second.ready;
    await vi.waitFor(() => expect(items('errors').map((e: { message: string }) => e.message)).toEqual(['lost-in-flight']));
    if (retryKey) expect(sent.map((s) => s.body.idempotency_key)).toContain(retryKey);
    await second.flush();
    expect(storage.data.size).toBe(0);
  });

  it('survives corrupt storage', async () => {
    const storage = memoryStorage();
    storage.data.set('@watchup/queue/v1', '{not json');
    const w = client({ storage });
    await w.ready;
    w.track('fine');
    await w.flush();
    expect(items('events')).toHaveLength(1);
  });
});

describe('global capture', () => {
  it('chains the ErrorUtils handler and reports fatal errors', async () => {
    const previous = vi.fn();
    let handler: ((e: Error, fatal?: boolean) => void) | undefined;
    (globalThis as Record<string, unknown>).ErrorUtils = {
      getGlobalHandler: () => handler ?? previous,
      setGlobalHandler: (h: typeof handler) => (handler = h),
    };
    const w = client();
    const boom = new Error('fatal crash');
    handler!(boom, true);
    expect(previous).toHaveBeenCalledWith(boom, true);
    await w.flush();
    expect(items('errors')[0]).toMatchObject({ message: 'fatal crash', level: 'fatal', context: { mechanism: 'global-handler' } });
  });

  it('reports unhandled promise rejections through the Hermes tracker', async () => {
    let tracker: { onUnhandled: (id: number, e: unknown) => void } | undefined;
    (globalThis as Record<string, unknown>).HermesInternal = {
      enablePromiseRejectionTracker: (o: typeof tracker) => (tracker = o),
    };
    const w = client();
    tracker!.onUnhandled(1, new Error('rejected'));
    await w.flush();
    expect(items('errors')[0]).toMatchObject({ message: 'rejected', context: { mechanism: 'unhandledrejection' } });
  });
});

describe('screens', () => {
  it('uses the current screen as the route and tracks screen views once', async () => {
    const w = client();
    w.setScreen('Home');
    w.setScreen('Home');
    w.setScreen('Checkout');
    w.captureError(new Error('on checkout'));
    await w.flush();
    expect(items('events').map((e: { properties: { screen: string } }) => e.properties.screen)).toEqual(['Home', 'Checkout']);
    expect(items('errors')[0].route).toBe('Checkout');
  });
});
