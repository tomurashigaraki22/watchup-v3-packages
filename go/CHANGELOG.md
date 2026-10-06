# Changelog — watchup-go-sdk

## 0.1.0

First release from this repository (mirrored to github.com/tomurashigaraki22/watchup-go-sdk).

- `net/http` middleware: route templates (Go 1.23 `ServeMux` patterns, or `Options.Route` for chi/Gin), real status codes, a per-request `Scope`, panic capture and re-panic.
- `CaptureError`, `Track`, `CaptureLog`, `StartTrace`/`End`, `Run`, `TraceQuery` (sanitized SQL) and `Recover` for goroutines.
- Goroutine-safe delivery queue with byte-aware chunking, truncation, redaction, idempotency keys, retries, `Flush(ctx)` and `Close(ctx)` with a deadline.
- Local feature-flag evaluation identical to the other SDKs.
