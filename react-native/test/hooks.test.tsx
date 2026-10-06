// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { WatchupProvider, useNavigationTracking, useWatchup, type WatchupReactNative } from '../src/index.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('React Native provider and hooks', () => {
  it('keeps one client across a StrictMode remount and tracks navigation', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}', { status: 201 })));
    let listener: (() => void) | undefined;
    const navigationRef = {
      current: {
        isReady: () => true,
        getCurrentRoute: () => ({ name: current }),
        addListener: (_e: 'state', fn: () => void) => {
          listener = fn;
          return () => (listener = undefined);
        },
      },
    };
    let current = 'Home';
    const seen = new Set<WatchupReactNative>();
    function App() {
      seen.add(useWatchup());
      useNavigationTracking(navigationRef);
      return null;
    }
    render(
      <StrictMode>
        <WatchupProvider apiKey="wup_pub_rn" options={{ storage: null, baseUrl: 'https://ingest.test', flushInterval: 60_000 }}>
          <App />
        </WatchupProvider>
      </StrictMode>,
    );
    await act(() => new Promise((r) => setTimeout(r, 150)));
    expect(seen.size).toBe(1);
    const client = [...seen][0]!;
    expect(client.isClosed).toBe(false);
    current = 'Settings';
    listener!();
    expect(client.currentScreen).toBe('Settings');
  });
});
