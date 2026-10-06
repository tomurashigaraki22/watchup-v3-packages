# @watchupltd/browser

Official Watchup SDK for browsers: uncaught errors and promise rejections, Web Vitals (FCP, LCP, CLS, INP, TTFB, page load), page views, custom events, traces, opt-in console logs and feature flags. No dependencies.

## Install

```bash
npm install @watchupltd/browser
```

Using React, Next.js or Svelte? Install `@watchupltd/react`, `@watchupltd/nextjs` or `@watchupltd/svelte` instead — they wrap this package.

## Quick start

```ts
import { Watchup } from '@watchupltd/browser';

const watchup = new Watchup({
  apiKey: 'wup_pub_xxxxxxxx', // your PUBLIC key — never a wup_live_ key
  environment: 'production',
  release: import.meta.env.VITE_GIT_SHA,
});

watchup.setUser({ id: '42', email: 'ada@example.com' });
watchup.track('checkout.started', { plan: 'pro' });

try {
  await submitOrder();
} catch (err) {
  watchup.captureError(err, { component: 'Checkout' });
}

const end = watchup.startTrace('load cart', { type: 'http' });
await fetch('/api/cart');
end({ status: 'ok' });

if (watchup.isEnabled('new-checkout')) renderNewCheckout();
```

## Options

| Option | Default | Description |
| --- | --- | --- |
| `apiKey` | — | **Required.** Public key (`wup_pub_…`). A `wup_live_` key triggers a console warning and is never put in request bodies. |
| `baseUrl` | `https://api.watchup.site` | Self-hosted API URL. |
| `environment` / `release` / `service` | `production` / — / — | Labels on every item. |
| `flushInterval` | `5000` | Milliseconds between flushes. |
| `maxBatchSize` / `maxQueueSize` | `100` / `1000` | Items per request / items kept while offline. |
| `sampleRate` | `1` | Fraction of page loads that report Web Vitals. |
| `autoCapture.errors` / `.performance` / `.pageViews` | `true` | Automatic capture switches. Set `pageViews: false` when a router integration tracks pages. |
| `logging.enabled` / `.captureConsole` / `.includeDeviceContext` / `.minLevel` | off | Opt-in structured logs. |
| `redactKeys` | `[]` | Extra keys to redact. |
| `onDiagnostic` | — | Delivery diagnostics (never captured data). |
| `flagRefreshInterval` | `30000` | Flag refresh in ms; `0` turns flags off. Background tabs don't poll. |

## Page unload

When the tab is hidden or the page is left, queued items are split into chunks of at most 60 KiB and handed to `navigator.sendBeacon` (as `text/plain`, so no CORS preflight; the public key travels in the body because beacons can't set headers). Browsers allow only ~64 KiB of beacon/keepalive data in flight per page: anything the browser refuses is kept in `localStorage` (already redacted, max 256 KiB) and sent — with its original idempotency key — on the next page load or when the tab becomes visible again.

## Privacy

Before anything is queued, values under keys such as `authorization`, `cookie`, `password`, `secret`, `*token`, `api_key` and card fields are replaced with `[REDACTED]`, and bearer tokens, `wup_live_` keys, secret URL query parameters and card numbers are scrubbed from strings. Device context is limited to user agent, language, time zone, viewport and screen size.

## Links

- [Browser SDK docs](https://watchup.site/docs/sdks/browser) · [Changelog](./CHANGELOG.md) · [Transport contract](../spec/README.md)

## License

MIT © Watchup Ltd
