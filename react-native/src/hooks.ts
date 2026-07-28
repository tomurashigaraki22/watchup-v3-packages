import { useCallback, useEffect } from 'react';
import type { TracePayload, WatchupUser } from './types.js';
import { useWatchupContext } from './context.js';
import type { WatchupReactNative } from './client.js';

export function useWatchup(): WatchupReactNative {
  return useWatchupContext();
}

export function useTrack(): (name: string, properties?: Record<string, unknown>) => void {
  const watchup = useWatchupContext();
  return useCallback((name: string, properties?: Record<string, unknown>) => {
    watchup.track(name, properties);
  }, [watchup]);
}

export function useStartTrace(): (
  span: string,
) => (opts?: { status?: TracePayload['status']; meta?: Record<string, unknown> }) => void {
  const watchup = useWatchupContext();
  return useCallback((span: string) => watchup.startTrace(span), [watchup]);
}

export function useIdentify(user: WatchupUser | null | undefined): void {
  const watchup = useWatchupContext();
  useEffect(() => {
    if (user) watchup.setUser(user);
    else watchup.clearUser();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);
}
