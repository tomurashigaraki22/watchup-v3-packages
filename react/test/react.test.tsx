import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StrictMode, useState } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import {
  WatchupErrorBoundary,
  WatchupProvider,
  useFlag,
  useIdentify,
  usePageView,
  useTrack,
  useWatchup,
} from '../src/index.js';
import { _resetRegistry } from '../src/registry.js';

let bodies: Array<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
let flags: unknown[];

beforeEach(() => {
  bodies = [];
  flags = [];
  _resetRegistry();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url.endsWith('/api/v1/flags')) {
      return new Response(JSON.stringify({ ok: true, data: { flags } }), { status: 200 });
    }
    bodies.push(JSON.parse(String(init.body)));
    return new Response('{"ok":true}', { status: 201 });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const options = {
  baseUrl: 'https://ingest.test',
  flushInterval: 60_000,
  flagRefreshInterval: 0,
  autoCapture: { pageViews: false, performance: false },
};

type Client = ReturnType<typeof useWatchup>;

function Probe({ onClient }: { onClient: (c: Client) => void }) {
  onClient(useWatchup());
  return null;
}

describe('WatchupProvider', () => {
  it('creates one client under StrictMode and keeps it alive across the dev remount', async () => {
    const seen = new Set<Client>();
    render(
      <StrictMode>
        <WatchupProvider apiKey="wup_pub_test" options={options}>
          <Probe onClient={(c) => seen.add(c)} />
        </WatchupProvider>
      </StrictMode>,
    );
    await act(() => new Promise((r) => setTimeout(r, 150)));
    expect(seen.size).toBe(1);
    expect([...seen][0]!.isClosed).toBe(false);
  });

  it('shuts the client down after the provider unmounts', async () => {
    let client!: Client;
    const { unmount } = render(
      <WatchupProvider apiKey="wup_pub_test" options={options}>
        <Probe onClient={(c) => (client = c)} />
      </WatchupProvider>,
    );
    client.track('before-unmount');
    unmount();
    await act(() => new Promise((r) => setTimeout(r, 150)));
    expect(client.isClosed).toBe(true);
    expect(bodies.flatMap((b) => b.events).map((e: { name: string }) => e.name)).toContain('before-unmount');
  });

  it('falls back to a no-op client without an apiKey', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let client!: Client;
    render(
      <WatchupProvider apiKey="">
        <Probe onClient={(c) => (client = c)} />
      </WatchupProvider>,
    );
    expect(() => client.track('x')).not.toThrow();
    expect(client.isEnabled('anything')).toBe(false);
    warn.mockRestore();
  });

  it('throws a helpful error outside a provider', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Probe onClient={() => {}} />)).toThrow(/inside a <WatchupProvider>/);
    err.mockRestore();
  });
});

describe('hooks', () => {
  it('useTrack returns a stable callback across renders', () => {
    const fns: unknown[] = [];
    function Comp() {
      const [n, setN] = useState(0);
      fns.push(useTrack());
      return <button onClick={() => setN(n + 1)}>inc</button>;
    }
    render(
      <WatchupProvider apiKey="wup_pub_test" options={options}>
        <Comp />
      </WatchupProvider>,
    );
    act(() => screen.getByText('inc').click());
    expect(fns.length).toBeGreaterThan(1);
    expect(new Set(fns).size).toBe(1);
  });

  it('useIdentify sets and clears the user', async () => {
    let client!: Client;
    function Comp({ user }: { user: { id: string } | null }) {
      useIdentify(user);
      client = useWatchup();
      return null;
    }
    const { rerender } = render(
      <WatchupProvider apiKey="wup_pub_test" options={options}>
        <Comp user={{ id: 'u1' }} />
      </WatchupProvider>,
    );
    client.captureError(new Error('as-u1'));
    rerender(
      <WatchupProvider apiKey="wup_pub_test" options={options}>
        <Comp user={null} />
      </WatchupProvider>,
    );
    client.captureError(new Error('anonymous'));
    await client.flush();
    const errors = bodies.flatMap((b) => b.errors);
    expect(errors[0].user).toEqual({ id: 'u1' });
    expect(errors[1].user).toBeUndefined();
  });

  it('usePageView tracks each route change once, even under StrictMode', async () => {
    let client!: Client;
    function Comp({ path }: { path: string }) {
      usePageView(path);
      client = useWatchup();
      return null;
    }
    const tree = (path: string) => (
      <StrictMode>
        <WatchupProvider apiKey="wup_pub_test" options={options}>
          <Comp path={path} />
        </WatchupProvider>
      </StrictMode>
    );
    const { rerender } = render(tree('/a'));
    rerender(tree('/b'));
    rerender(tree('/b'));
    await client.flush();
    expect(bodies.flatMap((b) => b.web ?? [])).toHaveLength(2);
  });

  it('useFlag re-renders when the flag cache refreshes', async () => {
    let client!: Client;
    function Comp() {
      client = useWatchup();
      return <span>{useFlag('beta') ? 'on' : 'off'}</span>;
    }
    render(
      <WatchupProvider apiKey="wup_pub_test" options={options}>
        <Comp />
      </WatchupProvider>,
    );
    expect(screen.getByText('off')).toBeTruthy();
    flags = [{ id: '1', key: 'beta', name: 'Beta', enabled: true, rollout_percentage: 100, variants: [], targeting_rules: [] }];
    await act(() => client.refreshFlags());
    expect(screen.getByText('on')).toBeTruthy();
  });
});

describe('WatchupErrorBoundary', () => {
  function Boom(): null {
    throw new Error('render failed');
  }

  it('captures once with the component stack and renders the fallback with reset', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    let client!: Client;
    render(
      <WatchupProvider apiKey="wup_pub_test" options={options}>
        <Probe onClient={(c) => (client = c)} />
        <WatchupErrorBoundary
          fallback={(e, reset) => <button onClick={reset}>{e.message}</button>}
          context={{ area: 'cart' }}
        >
          <Boom />
        </WatchupErrorBoundary>
      </WatchupProvider>,
    );
    expect(screen.getByText('render failed')).toBeTruthy();
    await client.flush();
    const errors = bodies.flatMap((b) => b.errors);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ level: 'fatal', context: { area: 'cart', mechanism: 'react.error_boundary' } });
    expect(errors[0].context.componentStack).toContain('Boom');
    err.mockRestore();
  });

  it('re-throws to the next boundary when no fallback is given', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onError = vi.fn();
    render(
      <WatchupProvider apiKey="wup_pub_test" options={options}>
        <WatchupErrorBoundary fallback={<p>outer caught</p>}>
          <WatchupErrorBoundary onError={onError}>
            <Boom />
          </WatchupErrorBoundary>
        </WatchupErrorBoundary>
      </WatchupProvider>,
    );
    expect(onError).toHaveBeenCalled();
    expect(screen.getByText('outer caught')).toBeTruthy();
    err.mockRestore();
  });
});
