# watchup-go-sdk

Official WatchUp SDK for **Go 1.21+**: `net/http` middleware, panic capture, errors, events, traces, structured logs, database spans and feature flags. Standard library only.

```bash
go get github.com/tomurashigaraki22/watchup-go-sdk
```

The source lives in [`go/`](.) of the WatchUp SDK monorepo and is mirrored to the module repository on release (see [`docs/RELEASING.md`](../docs/RELEASING.md)).

## Quick start

```go
client, err := watchup.New(watchup.Options{
    APIKey:  os.Getenv("WATCHUP_API_KEY"),
    Release: os.Getenv("GIT_SHA"),
    Service: "orders-api",
})
if err != nil {
    log.Fatal(err)
}

mux := http.NewServeMux()
mux.HandleFunc("GET /orders/{id}", func(w http.ResponseWriter, r *http.Request) {
    watchup.SetUser(r.Context(), &watchup.User{ID: r.Header.Get("X-User-ID")}) // this request only
    err := client.TraceQuery(r.Context(), "SELECT * FROM orders WHERE id = $1", "postgresql", 0, func() error {
        return db.QueryRowContext(r.Context(), query, r.PathValue("id")).Scan(&order)
    })
    if err != nil {
        client.CaptureError(r.Context(), err, map[string]any{"order_id": r.PathValue("id")})
    }
})

srv := &http.Server{Addr: ":8080", Handler: client.Middleware(mux)}
// ... on shutdown:
ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
defer cancel()
_ = srv.Shutdown(ctx)
_ = client.Close(ctx) // delivers what is queued before the deadline
```

Complete, buildable examples: [`examples/nethttp`](./examples/nethttp), [`examples/chi`](./examples/chi), [`examples/gin`](./examples/gin).

## Middleware

`client.Middleware(next)` records one trace per request with the route template (Go 1.23+ `ServeMux` patterns automatically; for chi or Gin set `Options.Route`), the real status code, the request ID and the W3C trace ID. It gives each request its own `Scope`, so concurrent requests never share a user. A panic is reported and then re-panicked, so `net/http` or your recovery middleware handles it exactly as before. Streaming (`http.Flusher`) and websockets (`http.Hijacker`) keep working.

## API

| Function | Description |
| --- | --- |
| `New(Options)` | Create a client; starts one delivery goroutine. |
| `SetUser(ctx, *User)` / `client.SetUser(*User)` | Request-scoped user / default user. |
| `NewScope(ctx)` | A scope for jobs and consumers. |
| `CaptureError(ctx, err, fields)` | Report an error (with its `errors.Unwrap` chain and stack). |
| `Track(ctx, name, props)` | Custom event. |
| `CaptureLog(ctx, level, msg, fields)` | Structured log (`Options.Logging`). |
| `StartTrace(ctx, span, WithType(...))` → `End(status, statusCode, meta)` | Time any operation. |
| `Run(ctx, span, fn)` | Run `fn` as a trace. |
| `TraceQuery(ctx, sql, system, slow, fn)` | Database span; literals become `?`, parameters are never recorded. |
| `Recover(ctx)` | `defer client.Recover(ctx)` in goroutines: report, flush, re-panic. |
| `IsEnabled` / `Variant` / `RefreshFlags` | Local feature flags. |
| `Flush(ctx)` | Send now; blocks until the attempt finishes. |
| `Close(ctx)` | Stop and deliver until `ctx` is done; returns an error if items were left. |

## Delivery

Items are redacted and serialized when captured; requests stay under 192 KiB and 100 items; oversized items are truncated; every request has an `Idempotency-Key`; failures are retried with the same key. See the [transport contract](../spec/README.md).

## Development

```bash
go test -race ./...
go vet ./...
staticcheck ./...
```

## License

MIT © Watchup Ltd
