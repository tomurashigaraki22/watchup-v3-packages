// ─────────────────────────────────────────────────────────────────────────────
// @watchupltd/react-native  ·  optional native modules and safe device context
//
// Every native dependency is optional and loaded lazily, so the package can be
// imported by tooling (Jest, SSR of shared code) without react-native. Each
// require() uses a literal module name inside try/catch: Metro rejects
// non-literal requires and treats literal ones in try blocks as optional.
// ─────────────────────────────────────────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-require-imports */

type ReactNativeModule = typeof import('react-native');

let rn: ReactNativeModule | null | undefined;

export function getReactNative(): ReactNativeModule | null {
  if (rn === undefined) {
    try {
      rn = require('react-native') as ReactNativeModule;
    } catch {
      rn = null;
    }
  }
  return rn;
}

/** Test hook: replace the react-native module. */
export function _setReactNative(module: unknown): void {
  rn = module as ReactNativeModule | null;
}

export interface NetInfoLike {
  addEventListener(listener: (state: { isConnected: boolean | null; isInternetReachable?: boolean | null }) => void): () => void;
}

let netInfo: NetInfoLike | null | undefined;

export function getNetInfo(): NetInfoLike | null {
  if (netInfo === undefined) {
    try {
      const mod = require('@react-native-community/netinfo') as { default?: NetInfoLike } & NetInfoLike;
      netInfo = mod?.default ?? mod ?? null;
    } catch {
      netInfo = null;
    }
  }
  return netInfo;
}

/** Test hook: replace NetInfo. */
export function _setNetInfo(module: NetInfoLike | null): void {
  netInfo = module;
}

export function getAsyncStorage(): {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
} | null {
  try {
    const mod = require('@react-native-async-storage/async-storage') as { default?: unknown };
    return ((mod?.default ?? mod) as ReturnType<typeof getAsyncStorage>) ?? null;
  } catch {
    return null;
  }
}

/** Safe device subset: no advertising IDs, IP or device name. */
export function getDeviceContext(): Record<string, unknown> {
  const native = getReactNative();
  const platform = native?.Platform;
  const dimensions = native?.Dimensions?.get?.('window');
  return {
    runtime: 'react-native',
    os: platform?.OS,
    os_version: platform?.Version,
    is_tv: platform?.isTV,
    hermes: Boolean((globalThis as { HermesInternal?: unknown }).HermesInternal),
    viewport: dimensions
      ? { width: dimensions.width, height: dimensions.height, scale: dimensions.scale, font_scale: dimensions.fontScale }
      : undefined,
  };
}
