// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';

const nav = { pathname: '/', search: '' };
vi.mock('next/navigation.js', () => ({
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(nav.search),
}));

const { WatchupProvider, useWatchup } = await import('../src/client/index.js');

let bodies: Array<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any

beforeEach(() => {
  bodies = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    if (!url.endsWith('/api/v1/flags')) bodies.push(JSON.parse(String(init.body)));
    return new Response('{"ok":true,"data":{"flags":[]}}', { status: 200 });
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Next.js client provider', () => {
  it('tracks App Router navigations once each, without History patching', async () => {
    let client!: ReturnType<typeof useWatchup>;
    function Probe() {
      client = useWatchup();
      return null;
    }
    const tree = () => (
      <WatchupProvider apiKey="wup_pub_next" options={{ baseUrl: 'https://ingest.test', flushInterval: 60_000, flagRefreshInterval: 0 }}>
        <Probe />
      </WatchupProvider>
    );
    const { rerender } = render(tree());
    nav.pathname = '/pricing';
    nav.search = 'plan=pro';
    rerender(tree());
    rerender(tree());
    // A raw pushState must not add a page view (the router integration owns it).
    history.pushState({}, '', '/elsewhere');
    await act(() => client.flush());
    const views = bodies.flatMap((b) => b.web ?? []);
    expect(views).toHaveLength(2);
  });
});
