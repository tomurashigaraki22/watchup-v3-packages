# @watchupltd/react

Official Watchup SDK for React 18 and 19: provider, error boundary and hooks on top of [`@watchupltd/browser`](../browser).

## Install

```bash
npm install @watchupltd/react @watchupltd/browser
```

## Quick start

```tsx
import { WatchupProvider, WatchupErrorBoundary, useTrack, useIdentify, useFlag } from '@watchupltd/react';

export function Root() {
  return (
    <WatchupProvider apiKey={import.meta.env.VITE_WATCHUP_API_KEY}>
      <WatchupErrorBoundary fallback={(error, reset) => <button onClick={reset}>Try again</button>}>
        <App />
      </WatchupErrorBoundary>
    </WatchupProvider>
  );
}

function App() {
  const { user } = useAuth();
  useIdentify(user ? { id: user.id, email: user.email } : null);
  const track = useTrack();
  const newCheckout = useFlag('new-checkout');
  return <button onClick={() => track('cta.clicked')}>{newCheckout ? 'Buy now' : 'Checkout'}</button>;
}
```

## Behaviour

- **One client, StrictMode-safe.** Providers with the same key share a client, so development double-renders and remounts never create duplicate listeners. The client shuts down shortly after the last provider unmounts.
- **SSR-safe.** During server rendering the hooks return a no-op client; nothing runs or is sent until the browser mounts.
- **Error boundary.** Captures the error with its component stack (once). With a `fallback`, it renders it (functions get `(error, reset)`); **without one, it re-throws** to the next boundary so React's normal error flow is unchanged.
- **Flags.** `useFlag`/`useVariant` re-render when the flag cache refreshes.

## API

| Export | Description |
| --- | --- |
| `<WatchupProvider apiKey options client>` | Mount once. `client` lets you pass an instance you created. |
| `<WatchupErrorBoundary fallback onError context>` | Render-error capture. |
| `useWatchup()` | The client (no-op during SSR). |
| `useTrack()` / `useStartTrace()` | Stable callbacks. |
| `useIdentify(user \| null)` | Set or clear the user. |
| `usePageView(path)` | Record page views from your router (set `autoCapture.pageViews: false`). |
| `useFlag(key, ctx?)` / `useVariant(key, ctx?)` | Feature flags. |

## Links

- [React SDK docs](https://watchup.site/docs/sdks/react) · [Changelog](./CHANGELOG.md)

## License

MIT © Watchup Ltd
