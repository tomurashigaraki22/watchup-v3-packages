import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import Harness from './Harness.svelte';
import { _getActive } from '../src/index.js';
import { watchupHandle, watchupHandleError } from '../src/server.js';

let bodies: Array<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
let flags: unknown[];

beforeEach(() => {
  bodies = [];
  flags = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url.endsWith('/api/v1/flags')) return new Response(JSON.stringify({ ok: true, data: { flags } }), { status: 200 });
    bodies.push(JSON.parse(String(init.body)));
    return new Response('{"ok":true}', { status: 201 });
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

// Svelte 4 class components and Svelte 5 mount() are both supported.
async function mountHarness(props: Record<string, unknown> = {}) {
  const svelte = (await import('svelte')) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const target = document.createElement('div');
  document.body.appendChild(target);
  if (typeof svelte.mount === 'function') {
    const app = svelte.mount(Harness, { target, props });
    return { target, app, destroy: () => svelte.unmount(app), set: (p: Record<string, unknown>) => Object.assign(app, p) };
  }
  const app = new (Harness as any)({ target, props }); // eslint-disable-line @typescript-eslint/no-explicit-any
  return { target, app, destroy: () => app.$destroy(), set: (p: Record<string, unknown>) => app.$set(p) };
}

const events = () => bodies.flatMap((b) => b.events ?? []);

describe('WatchupProvider + actions', () => {
  it('buffers init-time calls, tracks clicks, traces actions, and updates flag stores', async () => {
    const h = await mountHarness();
    await tick();
    const client = _getActive()!.current!;
    expect(client).toBeTruthy();

    (h.target.querySelector('#cta') as HTMLButtonElement).click();
    (window as unknown as { __watchupDone: () => void }).__watchupDone();
    flags = [{ id: '1', key: 'beta', name: 'B', enabled: true, rollout_percentage: 100, variants: [], targeting_rules: [] }];
    await client.refreshFlags();
    await tick();
    expect(h.target.querySelector('#flag')!.textContent).toBe('on');

    await client.flush();
    const names = events().map((e: { name: string }) => e.name);
    expect(names).toEqual(['child.init', 'cta.clicked']);
    expect(events()[0].properties.user).toEqual({ id: 'svelte-user' });
    const traces = bodies.flatMap((b) => b.traces ?? []);
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({ span: 'panel load', status: 'ok' });
    h.destroy();
  });

  it('records a cancelled trace when the element is destroyed first, and shuts down on destroy', async () => {
    const h = await mountHarness();
    await tick();
    const client = _getActive()!.current!;
    h.set({ show: false });
    await tick();
    h.destroy();
    await new Promise((r) => setTimeout(r, 10));
    expect(client.isClosed).toBe(true);
    const traces = bodies.flatMap((b) => b.traces ?? []);
    expect(traces[0]).toMatchObject({ span: 'panel load', status: 'warn', meta: { cancelled: true } });
  });

  it('is a no-op without an apiKey', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = await mountHarness({ apiKey: '' });
    await tick();
    expect(_getActive()?.current ?? null).toBeNull();
    (h.target.querySelector('#cta') as HTMLButtonElement).click();
    expect(bodies).toHaveLength(0);
    h.destroy();
    warn.mockRestore();
  });
});

describe('SvelteKit server hooks', () => {
  function fakeWatchup() {
    const calls: Record<string, unknown[]> = { trace: [], error: [], context: [] };
    return {
      calls,
      runWithContext: <T,>(ctx: unknown, fn: () => T) => {
        calls.context!.push(ctx);
        return fn();
      },
      startTrace: (span: string) => (opts: unknown) => calls.trace!.push({ span, opts }),
      captureError: (error: unknown, context: unknown) => calls.error!.push({ error, context }),
    };
  }
  const event = (path: string, routeId: string | null) => ({
    request: new Request(`http://kit.test${path}`, { headers: { 'x-request-id': 'r-9' } }),
    url: new URL(`http://kit.test${path}`),
    route: { id: routeId },
  });

  it('handle records the route id and real status and keeps the response', async () => {
    const w = fakeWatchup();
    const res = await watchupHandle(w)({ event: event('/blog/42', '/blog/[slug]'), resolve: () => new Response('x', { status: 404 }) });
    expect(res.status).toBe(404);
    expect(w.calls.context![0]).toMatchObject({ route: 'GET /blog/[slug]', requestId: 'r-9' });
    expect(w.calls.trace![0]).toMatchObject({ span: 'GET /blog/[slug]', opts: { status: 'warn', statusCode: 404 } });
  });

  it('handleError reports 5xx only', () => {
    const w = fakeWatchup();
    const handleError = watchupHandleError(w);
    handleError({ error: new Error('not found'), event: event('/x', null), status: 404 });
    handleError({ error: new Error('crash'), event: event('/x', '/x'), status: 500 });
    expect(w.calls.error).toHaveLength(1);
    expect((w.calls.error![0] as { context: { route: string } }).context.route).toBe('GET /x');
  });
});
