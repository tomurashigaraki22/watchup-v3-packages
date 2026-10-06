# WatchUp SDK transport contract

This directory pins the ingest contract that every WatchUp SDK implements
(plan §2–§3, Phase A.2). It is language-neutral: the JavaScript, Python, Go and
.NET SDKs all load [`fixtures/vectors.json`](fixtures/vectors.json) in their
test suites, and [`envelope.schema.json`](envelope.schema.json) is validated by
the mock ingest server in [`../tools/mock-ingest`](../tools/mock-ingest).

Changing anything here is a contract change: bump `contract_version` in
`fixtures/vectors.json`, update every SDK in the same pull request, and add a
migration note to [`../docs/COMPATIBILITY.md`](../docs/COMPATIBILITY.md).

## 1. Endpoint and headers

`POST {baseUrl}/api/v1/ingest/batch` (default base URL
`https://api.watchup.site`).

| Header | Value | Notes |
| --- | --- | --- |
| `Content-Type` | `application/json` | Always. |
| `Authorization` | `Bearer <project-key>` | Preferred. The server reads this first. |
| `X-Api-Key` | `<project-key>` | Legacy header, same value. Kept for older self-hosted servers. |
| `Idempotency-Key` | `wu_<batch-uuid>_<chunk-index>` | Server-side SDKs and React Native. Browsers send the key in the body only, because the production CORS policy does not allow this header yet. |
| `User-Agent` | `<sdk.name>/<sdk.version>` | Where the runtime allows it. |

`navigator.sendBeacon` cannot set headers. Browser envelopes therefore also
carry the public key in the body as `project_id`, which the server accepts as an
authentication fallback. Beacon bodies are sent as `text/plain;charset=UTF-8`:
`sendBeacon` always includes credentials, so an `application/json` body needs a
credentialed CORS preflight (`Access-Control-Allow-Credentials`), which the API
does not send. The server parses the JSON body whatever the content type.
Server-side SDKs must **never** put a secret (`wup_live_`) key in the body.

## 2. Envelope

```json
{
  "errors": [],
  "traces": [],
  "events": [],
  "sdk": { "name": "@watchupltd/node", "version": "0.3.0" },
  "environment": "production",
  "release": "git-sha-or-version",
  "idempotency_key": "wu_6f1c…_0",
  "sent_at": "2026-10-06T10:00:00.000Z"
}
```

- All three arrays are always present, even when empty.
- `sdk.name` and `sdk.version` are constants compiled into each package.
- `release` is omitted when unknown.
- Item shapes are described in [`envelope.schema.json`](envelope.schema.json).
  Item-level `environment`/`release` override the envelope values.

### Canonical item fields

Every SDK fills these where the runtime knows them:

| Field | Errors | Traces | Events |
| --- | --- | --- | --- |
| `route` (template, e.g. `GET /users/:id`) | yes | `span` | in `properties.route` |
| `method`, `status_code`, `ms` (duration) | in `context.request` | yes | — |
| `source` (`browser`, `server`, `react-native`, `worker`) | `context.source` | `meta.source` | `properties.source` |
| `service` | `context.service` | `meta.service` | `properties.service` |
| `request_id`, `trace_id`, `span_id` | `context.request_id` … | `meta.*` | `properties.*` |
| `user` (`id`, `email`, `name`) | `user` | `user` | `properties.user` |
| device (safe subset, never IP or IDFA) | `context.device` | `meta.device` | `properties.device` |

## 3. Limits

| Constant | Value | Why |
| --- | --- | --- |
| `MAX_CHUNK_BYTES` | 196 608 (192 KiB) | Headroom below the server's 256 KiB body limit. |
| `MAX_CHUNK_ITEMS` | 100 | The server's batch count guard silently drops items past 100. |
| `BEACON_MAX_BYTES` | 61 440 (60 KiB) | Browsers cap `sendBeacon`/`keepalive` bodies at 64 KiB in flight. |
| `MAX_QUEUE_ITEMS` | 1 000 (default) | Bounded memory. Overflow drops the oldest event, then trace, then error, and reports it. |

Sizes are **UTF-8 bytes of the exact serialized body**, never character
counts or item counts.

## 4. Chunking algorithm

1. Normalize and redact each item when it is captured (§6), then serialize it
   once.
2. Take items in priority order — all pending `errors`, then `traces`, then
   `events` — preserving FIFO order within each array.
3. Add the next item to the current chunk if the chunk stays within both
   `MAX_CHUNK_BYTES` and `MAX_CHUNK_ITEMS`; otherwise close the chunk and start
   a new one.
4. If an item alone exceeds the per-item budget, apply the truncation policy
   (§5). If it still does not fit, send it as a chunk on its own and report an
   `item_oversized` diagnostic. Errors are never dropped silently.
5. Each chunk gets `idempotency_key = wu_<batch-uuid>_<index>`, where
   `batch-uuid` is generated once per flush. Retries reuse the key unchanged.

## 5. Truncation policy

Applied only to an item that would not fit in an otherwise empty chunk. Steps
run in order and stop as soon as the item fits:

1. `message` → 8 KiB, `stack` → 32 KiB, every string inside
   `context`/`meta`/`properties` → 8 KiB.
2. Replace `context`, `meta` and `properties` with
   `{"_watchup_truncated": true, "original_bytes": <n>}`.
3. `message` → 1 KiB, `stack` → 4 KiB.

Truncation cuts on a UTF-8 code-point boundary and appends
`…[truncated <n> bytes]`. Every truncated item gets
`"_watchup_truncated": true` at the top level and the SDK emits an
`item_truncated` diagnostic.

## 6. Normalization and redaction

Before an item is queued:

- Cycles become `"[Circular]"`, functions and `undefined` are dropped, `BigInt`
  becomes a string, `Date` becomes ISO-8601, `Error` becomes
  `{name, message, stack}`. Depth is capped at 10, objects at 200 keys and
  arrays at 200 elements.
- **Key redaction.** Keys are compared after lower-casing and removing `-`,
  `_`, `.` and spaces. A value is replaced with `"[REDACTED]"` when the key is
  one of `authorization`, `proxyauthorization`, `cookie`, `setcookie`,
  `password`, `passwd`, `pwd`, `secret`, `clientsecret`, `apikey`, `xapikey`,
  `apisecret`, `privatekey`, `creditcard`, `cardnumber`, `ccnumber`, `cvv`,
  `cvc`, `ssn`, `sessiontoken`, or when it contains `password`, `secret` or
  `credential`, or ends with `token`.
- **Value scrubbing** of every string, including `message` and `stack`:
  `Bearer <x>` and `Basic <x>` credentials, `wup_live_…` keys, sensitive URL
  query parameters (`token`, `access_token`, `password`, `api_key`, `apikey`,
  `secret`, `key`), and Luhn-valid 13–19 digit card numbers are replaced with
  `[REDACTED]`.
- Raw request bodies are never captured unless the application passes them
  explicitly, and they are redacted like any other value.

## 7. Delivery and retries

- One chunk is in flight at a time, so order holds across chunks.
- `2xx`: chunk accepted and removed. It is never sent again.
- Retryable: network errors, timeouts, `408`, `425`, `429`, and `5xx`.
  Backoff is `min(30 s, 1 s × 2^(attempt-1))` with jitter in
  `[50 %, 100 %]`; `Retry-After` on `429`/`503` is honoured up to 60 s. After 5
  attempts the chunk is dropped with a `chunk_dropped` diagnostic.
- A failing chunk does not block later chunks; it waits for its retry time
  while newer chunks go out.
- Any other `4xx` is permanent: the chunk is dropped with a `chunk_rejected`
  diagnostic carrying the server `code` (`413` → `payload_too_large`).
- Concurrent `flush()` calls share one drain loop. An item moves from the
  pending queue into exactly one chunk.

## 8. Shutdown and unload

- `shutdown()`/`close()` stops timers, drains pending items and due retries,
  waits up to a deadline (default 5 s), and reports an
  `undelivered_on_shutdown` diagnostic with counts for anything left.
- Browsers on `visibilitychange: hidden`/`pagehide` re-chunk pending items to
  `BEACON_MAX_BYTES` and use `sendBeacon`, falling back to
  `fetch(..., {keepalive: true})`. A chunk larger than the beacon limit is never
  passed to `sendBeacon`.

## 9. Diagnostics

SDKs expose an `onDiagnostic` callback (name adapted per language) and log
diagnostics when `debug` is on. Types: `item_truncated`, `item_oversized`,
`chunk_retry`, `chunk_rejected`, `chunk_dropped`, `queue_overflow`,
`undelivered_on_shutdown`. Diagnostics never include item contents or keys.
