# Changelog — @watchupltd/node

## 0.3.0

### Added
- Shared transport core: byte-aware chunks (≤192 KiB, ≤100 items), truncation, redaction, idempotency keys and retries with backoff.
- `AsyncLocalStorage` request context: `setUser()` inside a request applies to that request only; `runWithContext()` for jobs.
- `wrapAsync()` for Express 4 async handlers, `trace()`, `traceQuery()` (sanitized SQL spans), `refreshFlags()`.
- Options: `service`, `maxQueueSize`, `redactKeys`, `onDiagnostic`, `handleSignals`, `captureUnhandled`, `shutdownTimeout`, `flagRefreshInterval`.
- Request traces include the request ID, W3C trace ID and abort detection (`499`).

### Fixed
- Signal handling called `process.removeAllListeners(sig)`, deleting the application's own SIGTERM/SIGINT handlers.
- Two concurrent requests could share `setUser()` identity.
- The flag polling interval kept the process alive.
- An error passed through several error middlewares was reported more than once; 4xx errors are now `warning`, not `error`.

### Migration
- `flush()` and `shutdown()` return promises; `await watchup.shutdown()` before exiting.
- `setUser()` outside a request still sets the default user; inside a request it is request-scoped.
