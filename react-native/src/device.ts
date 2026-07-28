type ReactNativeModule = typeof import('react-native');

let cached: ReactNativeModule | null | undefined;

function getReactNative(): ReactNativeModule | null {
  if (cached !== undefined) return cached;
  try {
    // Optional at runtime so the package can still be imported in non-RN tooling.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    cached = require('react-native') as ReactNativeModule;
  } catch {
    cached = null;
  }
  return cached;
}

export function getRouteFallback(): string {
  return 'react-native';
}

export function getDeviceContext(): Record<string, unknown> {
  const rn = getReactNative();
  const platform = rn?.Platform;
  const dimensions = rn?.Dimensions?.get?.('window');

  return {
    runtime: 'react-native',
    os: platform?.OS,
    osVersion: platform?.Version,
    isTV: platform?.isTV,
    isTesting: platform?.isTesting,
    viewport: dimensions
      ? {
          width: dimensions.width,
          height: dimensions.height,
          scale: dimensions.scale,
          fontScale: dimensions.fontScale,
        }
      : undefined,
  };
}
