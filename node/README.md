# @watchupltd/node

Official Watchup SDK for **Node.js** and **Express**: request traces, errors, custom events, structured logs, database spans and feature flags, delivered to the Watchup ingest API in byte-aware, retried batches.

## Requirements

- Node.js **18, 20 or 22** (uses the built-in `fetch`)
- Express **4 or 5**, or any framework with Node `req`/`res` objects

## Install

```bash
npm install @watchupltd/node
```

## Quick start (Express)

<!-- example: examples/node-express.mjs -->
```js
// Express quick start for @watchupltd/node.
// Run: WATCHUP_API_KEY=wup_live_xxx node examples/node-express.mjs
import express from 'express';
import { Watchup } from '@watchupltd/node';

const watchup = new Watchup({
  apiKey: process.env.WATCHUP_API_KEY,
  baseUrl: process.env.WATCHUP_BASE_URL, // omit in production
  environment: process.env.NODE_ENV,
  release: process.env.GIT_SHA,
  service: 'orders-api',
});

const app = express();
app.use(watchup.requestMiddleware()); // 1. before your routes

app.use((req, _res, next) => {
  // Request-scoped: concurrent requests never share a user.
  const userId = req.header('x-user-id');
  if (userId) watchup.setUser({ id: userId });
  next();
});

app.get('/orders/:id', async (req, res) => {
  const order = await watchup.traceQuery('SELECT * FROM orders WHERE id = $1', async () => ({ id: req.params.id }), {
    system: 'postgresql',
  });
  watchup.track('order.viewed', { orderId: order.id });
  res.json(order);
});

app.get('/fail', () => {
  throw new Error('Something broke');
});

app.use(watchup.errorMiddleware()); // 2. after your routes
app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));

const server = app.listen(Number(process.env.PORT ?? 3000), async () => {
  const { port } = server.address();
  // Demo traffic, then a graceful shutdown that flushes everything.
  await fetch(`http://127.0.0.1:${port}/orders/42`, { headers: { 'x-user-id': 'user-1' } });
  await fetch(`http://127.0.0.1:${port}/fail`);
  server.close();
  await watchup.shutdown();
});
```

This example is executed in CI against a mock ingest server (`node tools/docs/examples.mjs run`).

On **Express 4**, wrap async handlers so rejections reach the error middleware: `app.get('/x', watchup.wrapAsync(async (req, res) => { … }))`. Express 5 does this natively.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `apiKey` | — | **Required.** Secret project key (`wup_live_…`). |
| `baseUrl` | `https://api.watchup.site` | Self-hosted API URL. |
| `environment` | `process.env.NODE_ENV` | Label on every item. |
| `release` | — | Git SHA or version for deploy correlation. |
| `service` | — | Service name on every item. |
| `flushInterval` | `5000` | Milliseconds between background flushes. |
| `maxBatchSize` | `100` | Items per request (the server's maximum). |
| `maxQueueSize` | `1000` | Items kept while the API is unreachable; oldest events drop first, errors last. |
| `sampleRate` | `1` | Fraction of requests traced. Errors are always captured. |
| `redactKeys` | `[]` | Extra keys to redact (built-in: authorization, cookie, password, secret, token, api key, card data…). |
| `onDiagnostic` | — | Receives delivery diagnostics (truncation, retries, drops). Never receives captured data. |
| `handleSignals` | `true` | Flush on SIGTERM/SIGINT/`beforeExit`. Your own signal handlers still decide when to exit; with none, the signal is re-raised after flushing. |
| `captureUnhandled` | `false` | Capture `uncaughtException`/`unhandledRejection`, flush, then exit with code 1 (Node's default behaviour). |
| `shutdownTimeout` | `5000` | Max ms `shutdown()` waits for delivery. |
| `flagRefreshInterval` | `30000` | Feature-flag refresh in ms; `0` turns flags off. |
| `debug` | `false` | Print diagnostics with `console.warn`. |
| `logging.enabled` / `captureConsole` / `minLevel` | `false` / `false` / `debug` | Opt-in structured logs. |

## API

| Method | Description |
| --- | --- |
| `requestMiddleware()` | One trace per request (route template, status, duration, request ID, W3C trace ID) and a per-request context. |
| `errorMiddleware()` | Reports errors passed to `next(err)` once, then forwards them unchanged. 4xx errors are `warning`, 5xx `error`. |
| `wrapAsync(handler)` | Forwards async rejections to `next(err)` (Express 4). |
| `setUser(user)` / `clearUser()` | Request-scoped inside a request; the default user outside one. |
| `runWithContext(ctx, fn)` | Run a job or consumer with its own context and user. |
| `track(name, properties?)` | Custom analytics event. |
| `captureError(error, context?)` | Report an error (each Error object once). |
| `captureLog(message, { level, … })` | Structured log (requires `logging.enabled`). |
| `startTrace(span, { type })` → `end({ status, statusCode, meta })` | Time any operation. |
| `trace(span, fn)` | Run `fn` as a trace; errors mark it `err` and propagate. |
| `traceQuery(sql, fn, { system, slowMs })` | Database span. SQL literals become `?` (max 1 KiB); parameters are never recorded. |
| `isEnabled(key, ctx?)` / `getVariant(key, ctx?)` / `refreshFlags()` | Local feature-flag evaluation. |
| `flush()` | Send now. Returns a promise; never rejects. |
| `shutdown()` | Stop timers and deliver what is queued (up to `shutdownTimeout`). |

## Delivery guarantees

- Items are redacted and serialized when captured, so later mutations don't leak into a batch.
- Requests stay under 192 KiB of UTF-8 and 100 items; an item that is too large on its own is truncated (`_watchup_truncated: true`) instead of being dropped.
- Every request carries an `Idempotency-Key`; failed requests are retried with the same key (exponential backoff with jitter, `Retry-After` honoured, 5 attempts), and a failed request never blocks newer ones.
- Timers are `unref()`'d and never keep your process alive.

The full contract is in [`spec/README.md`](../spec/README.md).

## Links

- [Node.js SDK docs](https://watchup.site/docs/sdks/node)
- [Changelog](./CHANGELOG.md)

## License

MIT © Watchup Ltd
