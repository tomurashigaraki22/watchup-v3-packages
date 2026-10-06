import { useCallback, useEffect, useRef } from 'react';
import type { TracePayload, WatchupUser } from './types.js';
import { useWatchupContext } from './context.js';
import type { WatchupReactNative } from './client.js';

type EndTrace = (opts?: { status?: TracePayload['status']; meta?: Record<string, unknown> }) => void;

export function useWatchup(): WatchupReactNative {
  return useWatchupContext();
}

export function useTrack(): (name: string, properties?: Record<string, unknown>) => void {
  const watchup = useWatchupContext();
  return useCallback((name: string, properties?: Record<string, unknown>) => watchup.track(name, properties), [watchup]);
}

export function useStartTrace(): (span: string) => EndTrace {
  const watchup = useWatchupContext();
  return useCallback((span: string) => watchup.startTrace(span), [watchup]);
}

export function useIdentify(user: WatchupUser | null | undefined): void {
  const watchup = useWatchupContext();
  const latest = useRef(user);
  latest.current = user;
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run only when identity fields change, not on every new object
  useEffect(() => {
    if (latest.current) watchup.setUser(latest.current);
    else watchup.clearUser();
  }, [watchup, user?.id, user?.email, user?.name]);
}

/**
 * Record the current screen when a component mounts (for apps without React
 * Navigation, or for modals).
 *
 * @example
 * useScreen('Checkout');
 */
export function useScreen(name: string, params?: Record<string, unknown>): void {
  const watchup = useWatchupContext();
  // biome-ignore lint/correctness/useExhaustiveDependencies: params are recorded with the first view of each screen name
  useEffect(() => {
    watchup.setScreen(name, params);
  }, [watchup, name]);
}

interface NavigationRefLike {
  isReady?: () => boolean;
  getCurrentRoute?: () => { name: string } | undefined;
  addListener?: (event: 'state', listener: () => void) => () => void;
}

/**
 * Track React Navigation screen changes. Pass the ref you give to
 * `<NavigationContainer ref={navigationRef}>`.
 *
 * @example
 * const navigationRef = useNavigationContainerRef();
 * useNavigationTracking(navigationRef);
 */
export function useNavigationTracking(navigationRef: NavigationRefLike | { current: NavigationRefLike | null }): void {
  const watchup = useWatchupContext();
  useEffect(() => {
    const ref = ('current' in navigationRef ? navigationRef.current : navigationRef) as NavigationRefLike | null;
    if (!ref?.addListener) return undefined;
    const record = () => {
      const route = ref.getCurrentRoute?.();
      if (route?.name) watchup.setScreen(route.name);
    };
    if (ref.isReady?.()) record();
    return ref.addListener('state', record);
  }, [watchup, navigationRef]);
}
