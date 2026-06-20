# @watchupltd/node

Official Watchup SDK for **Node.js** and **Express**.

Automatically captures request traces, route-level errors, and lets you send custom analytics events — all flushed to the Watchup ingest API in non-blocking batches.

---

## Requirements

- Node.js **≥ 18** (uses the built-in `fetch` API)
- Works with **Express 4 / 5**, and any framework that exposes standard `req`/`res` objects

---

## Installation

```bash
npm install @watchupltd/node
# or
pnpm add @watchupltd/node
```

---

## Quick start (Express)

```ts
import express from 'express';
import { Watchup } from '@watchupltd/node';

const watchup = new Watchup({
  apiKey:      process.env.WATCHUP_API_KEY!,   // wup_live_xxxxxxxxxxxx
  environment: process.env.NODE_ENV,
  release:     process.env.GIT_SHA,            // optional — correlate errors to deploys
});

const app = express();

// 1. Request middleware — mount BEFORE your routes
app.use(watchup.requestMiddleware());

// 2. Your routes
app.get('/users', async (req, res) => {
  const users = await db.getUsers();
  res.json(users);
});

app.post('/checkout', async (req, res, next) => {
  try {
    const order = await processOrder(req.body);

    // Track custom events
    watchup.track('order.completed', { amount: order.total, plan: order.plan });

    res.json(order);
  } catch (err) {
    next(err);   // passes to error middleware below
  }
});

// 3. Error middleware — mount AFTER your routes
app.use(watchup.errorMiddleware());
app.use(myOwnErrorHandler);   // still runs; watchup.errorMiddleware() calls next(err)

app.listen(3000);
```

---

## API

### `new Watchup(options)`

| Option | Type | Default | Description |
|---|---|---|---|
| `apiKey` | `string` | — | **Required.** Project API key from the Watchup dashboard. |
| `baseUrl` | `string` | `https://api.watchup.site` | Override for self-hosted deployments. |
| `environment` | `string` | `process.env.NODE_ENV` | Label attached to every payload. |
| `release` | `string` | `''` | Git SHA or version tag for deploy correlation. |
| `flushInterval` | `number` (ms) | `5000` | How often queued items are sent. |
| `maxBatchSize` | `number` | `100` | Triggers an immediate flush when reached. |
| `sampleRate` | `number` (0–1) | `1` | Fraction of requests captured as traces. |
| `debug` | `boolean` | `false` | Logs SDK warnings and HTTP errors to `console.warn`. |

---

### `watchup.requestMiddleware()`

Express middleware that records every request as a trace.

- Zero latency: hooks into `res.on('finish')`, never awaits
- Uses `req.route.path` for matched routes, falls back to normalised URL (IDs replaced with `:id`)
- Respects `sampleRate`

---

### `watchup.errorMiddleware()`

Express error middleware that captures errors passed to `next(err)`.

- Always calls `next(err)` — transparent to other error handlers
- Must be mounted **after** all routes

---

### `watchup.track(name, properties?)`

Send a custom analytics event.

```ts
watchup.track('user.signed_up', { plan: 'pro', source: 'invite' });
watchup.track('export.started', { format: 'csv', rows: 42000 });
```

Events appear under the **Events** tab in the Watchup dashboard.

---

### `watchup.captureError(error, context?)`

Manually capture an error from anywhere — background jobs, queue consumers, crons.

```ts
try {
  await sendInvoice(customerId);
} catch (err) {
  watchup.captureError(err, {
    route: 'job.send_invoice',
    level: 'error',       // 'error' | 'warning'
    customerId,
  });
}
```

---

### `watchup.startTrace(span)`

Time a non-HTTP operation and record it as a trace.

```ts
const end = watchup.startTrace('job.generate_report');

try {
  await generateReport();
  end();                    // status: 'ok'
} catch (err) {
  end({ status: 'err' });
  throw err;
}
```

---

### `watchup.flush()`

Immediately flush all queued items. Normally not needed — the SDK flushes
automatically on the configured interval and on process exit.

---

### `watchup.shutdown()`

Stop the flush timer and send remaining items. Use this for graceful shutdown
in custom process managers.

---

## How it works

```
Express request
    │
    ├── requestMiddleware() hooks res.on('finish')
    │       │
    │       └── on finish: addTrace(span, ms, status)
    │
    ├── your routes run...
    │
    └── errorMiddleware() captures next(err)
            │
            └── addError(message, route, stack)

Batcher                               Watchup API
  ├── traces[]  ─── every 5 s ───►  POST /api/v1/ingest/batch
  ├── errors[]  ─── or at 50  ───►  { traces, errors, events }
  └── events[]  ─── or at 100 ───►
```

The batcher timer is `unref()`'d — it never prevents your process from exiting.
On `beforeExit` / `SIGTERM` / `SIGINT`, remaining items are flushed before shutdown.

---

## Finding your API key

1. Open the **Watchup dashboard**
2. Select your project
3. Go to **Project Settings → API Keys**
4. Copy the key starting with `wup_live_`

Set it as an environment variable:

```bash
WATCHUP_API_KEY=wup_live_xxxxxxxxxxxx node server.js
```

---

## License

MIT © Watchup Ltd
