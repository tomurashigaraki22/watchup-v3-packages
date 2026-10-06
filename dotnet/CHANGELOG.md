# Changelog — Watchup (.NET)

## 1.1.0

### Added
- Shared transport contract: byte-aware chunking, truncation, redaction, an `Idempotency-Key` per chunk, retries with backoff and jitter, a bounded queue, and diagnostics (`OnDiagnostic`).
- `AsyncLocal` request scope (`WatchupScope`): `SetUser()` inside a request is request-scoped.
- `AddWatchup(IConfiguration)` overload; the client sends through `IHttpClientFactory`.
- `TraceQueryAsync` (sanitized SQL spans), `SetUser`, `WatchupUser`, W3C trace IDs from `Activity`.
- A `net10.0` target; analyzers with warnings as errors; a symbols package (`.snupkg`) and SourceLink.

### Changed (migration)
- ASP.NET Core middleware and DI extensions are built for `net8.0`+ on the shared framework (`Microsoft.AspNetCore.App`). The deprecated ASP.NET Core 2.2 packages are gone; the `netstandard2.1` build contains the core client only.
- The hosted service now awaits delivery on shutdown (up to `ShutdownTimeout`).
- Exception types are reported with their full name (`System.InvalidOperationException`).

### Removed
- The internal `Batcher` (replaced by the delivery queue).
