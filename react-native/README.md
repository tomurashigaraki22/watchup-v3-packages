# @watchupltd/react-native

Expo and React Native-friendly WatchUp SDK for JavaScript errors, structured logs, events, and traces.

This first release is JS-only. It does not require native modules, config plugins, or ejecting from Expo.

## Install

```bash
npm install @watchupltd/react-native
```

## Provider

```tsx
import { WatchupProvider } from "@watchupltd/react-native";

export default function App() {
  return (
    <WatchupProvider
      apiKey="wup_pub_xxx"
      options={{
        environment: "production",
        release: "1.0.0",
        logging: {
          enabled: true,
          captureConsole: true,
          includeDeviceContext: true,
          minLevel: "debug",
        },
      }}
    >
      <Root />
    </WatchupProvider>
  );
}
```

## Usage

```tsx
import { useWatchup, useStartTrace } from "@watchupltd/react-native";

function CheckoutScreen() {
  const watchup = useWatchup();
  const startTrace = useStartTrace();

  async function submit() {
    const end = startTrace("checkout.submit");
    try {
      watchup.captureLog("Checkout started", { level: "info", route: "Checkout" });
      await checkout();
      watchup.track("checkout.completed", { plan: "pro" });
      end({ status: "ok" });
    } catch (err) {
      end({ status: "err" });
      watchup.captureError(err, { route: "Checkout" });
    }
  }
}
```

## What v0.1 captures

- Manual JS errors through `captureError()`
- Global React Native JS errors through `ErrorUtils`
- Structured logs through `captureLog()`
- Optional console capture for `console.log/info/debug/warn/error`
- Custom events through `track()`
- Manual traces through `startTrace()`
- User context through `setUser()` / `useIdentify()`
- Device context from `react-native` `Platform` and `Dimensions`

Native crash reporting, persisted offline queues, and navigation auto-instrumentation are planned for later releases.
