# Changelog — @watchupltd/browser

## 0.3.0

Transport hardening (SDK plan Phase B) on the shared `@watchupltd/core`.

### Added
- Byte-aware chunking: request bodies stay under 192 KiB (UTF-8 bytes, not characters) and 100 items.
- Truncation policy for oversized items (`_watchup_truncated`) and redaction of credentials, cookies, card numbers and `wup_live_` keys before anything is queued.
- Retries with bounded exponential backoff and jitter; every chunk has an idempotency key (`wu_<batch>_<n>`) that retries reuse.
- `onDiagnostic`, `maxQueueSize`, `redactKeys`, `service` and `flagRefreshInterval` options; `refreshFlags()`, `onFlagsChange()`, `isClosed`.
- Web Vitals: CLS, INP and TTFB in addition to FCP, LCP and page load.
- Errors carry `type`, device context and the user at capture time; an exception is reported once even if seen twice.

### Fixed
- `sendBeacon` requests carried no project key and were rejected; envelopes now include the public key as `project_id`.
- Oversized payloads were passed to `sendBeacon`; unload now re-chunks to 60 KiB first and falls back to `fetch(keepalive)`.
- `keepalive` was used for bodies over the browser's 64 KiB limit, so large flushes were dropped.
- History patching from several clients (or a React StrictMode remount) could double-count or clobber each other.
- Console capture could loop through the SDK's own warnings.
- `crypto.randomUUID` crashed on non-secure origins.

### Migration
- `flush()` and `shutdown()` now return promises (calling them without `await` still works).
- `sampleRate` now samples automatic Web Vitals per page load.
