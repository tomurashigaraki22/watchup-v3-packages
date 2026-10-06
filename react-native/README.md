# @watchupltd/react-native

Official WatchUp SDK for **React Native and Expo**: JS exceptions, unhandled promise rejections, screens, custom events, traces, logs and user identity — with an offline queue that survives restarts.

## Install

```bash
npm install @watchupltd/react-native
# Recommended, for offline delivery:
npx expo install @react-native-async-storage/async-storage @react-native-community/netinfo
```

Supports React Native 0.72+ and Expo SDK 50+, on Hermes and JSC.

## Provider

```tsx
import { WatchupProvider } from '@watchupltd/react-native';

export default function App() {
  return (
    <WatchupProvider
      apiKey={process.env.EXPO_PUBLIC_WATCHUP_API_KEY!} // public wup_pub_ key
      options={{ environment: __DEV__ ? 'development' : 'production', release: '1.4.0' }}
    >
      <Navigation />
    </WatchupProvider>
  );
}
```

## Usage

```tsx
import { useIdentify, useNavigationTracking, useScreen, useStartTrace, useTrack, useWatchup } from '@watchupltd/react-native';

const navigationRef = useNavigationContainerRef();
useNavigationTracking(navigationRef); // React Navigation: screen views + route for errors

useScreen('Checkout');                // or record a screen manually
useIdentify(user ? { id: user.id } : null);

const track = useTrack();
track('checkout.started', { items: 3 });

const end = useStartTrace()('load cart');
end({ status: 'ok' });

useWatchup().captureError(error, { component: 'Cart' });
```

## Offline behaviour

- Captured items are persisted (AsyncStorage by default, or any `storage` adapter with `getItem`/`setItem`/`removeItem`; `storage: null` keeps them in memory) and restored on the next launch — including retries with their original idempotency keys, so nothing is double-counted.
- With NetInfo installed, delivery pauses while offline (without using up retry attempts) and resumes on reconnect.
- The queue flushes when the app goes to the background and when it becomes active. Nothing blocks rendering.
- The queue is bounded (`maxQueueSize`, default 1000): oldest events are dropped first, errors last.

## What is captured

- Uncaught JS exceptions through `ErrorUtils` (React Native's own handler still runs, so dev red boxes and release crash handling are unchanged).
- Unhandled promise rejections (Hermes' tracker, or the `promise` polyfill's tracker on JSC).
- Native (Java/Kotlin/Objective-C/Swift) crashes are **not** captured.
- Device context is limited to OS, OS version, Hermes, and window size — no device name, advertising ID or IP.

## Links

- [React Native SDK docs](https://watchup.site/docs/sdks/react-native) · [Changelog](./CHANGELOG.md) · [Expo fixture](../fixtures/expo-app)

## License

MIT © Watchup Ltd
