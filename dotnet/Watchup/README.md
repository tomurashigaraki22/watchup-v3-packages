# Watchup .NET SDK

Official .NET SDK for [Watchup](https://watchup.site): request tracing, error capture, custom events and database spans for ASP.NET Core and any .NET application.

- **ASP.NET Core middleware and DI:** .NET 8, 9 and 10 (shared framework).
- **Core client:** also `netstandard2.1`.

## Install

```bash
dotnet add package Watchup
```

## ASP.NET Core

```csharp
// Program.cs
using Watchup;
using Watchup.Middleware;

var builder = WebApplication.CreateBuilder(args);

// Binds the "Watchup" section: ApiKey, Environment, Release, Service, ...
builder.Services.AddWatchup(builder.Configuration.GetSection("Watchup"));
// or: builder.Services.AddWatchup(o => o.ApiKey = builder.Configuration["Watchup:ApiKey"]!);

var app = builder.Build();
app.UseRouting();
app.UseWatchup(); // after UseRouting so route templates resolve
app.MapGet("/orders/{id:int}", (int id, WatchupClient watchup) =>
{
    watchup.SetUser(new WatchupUser($"customer-{id}")); // scoped to this request
    return Results.Ok(new { id });
});
app.Run();
```

A complete sample that CI builds lives in [`samples/AspNetCoreSample`](../samples/AspNetCoreSample).

The middleware records one trace per request (route template such as `GET /orders/{id:int}`, real status code, duration, request ID and W3C trace ID), reports exceptions once and re-throws them unchanged, and (by default) also reports 5xx responses that did not throw. The client sends through `IHttpClientFactory`, and a hosted service flushes on application shutdown.

## Manual tracking

```csharp
public class OrderService(WatchupClient watchup)
{
    public async Task<decimal> TotalAsync(int orderId)
    {
        watchup.Track("order.priced", new() { ["order_id"] = orderId });

        using (watchup.StartTrace("job.price_order")) { await Task.Delay(10); }

        // Literals become ?, parameters are never recorded; slow queries are marked "warn".
        return await watchup.TraceQueryAsync("SELECT total FROM orders WHERE id = @id",
            () => db.QuerySingleAsync<decimal>(sql, new { id = orderId }), system: "postgresql");
    }
}
```

Outside a request, wrap work in a scope so users don't leak between jobs:

```csharp
using (WatchupScope.Begin(route: "job.send_email"))
{
    watchup.SetUser(new WatchupUser(job.UserId));
    await SendEmail(job);
}
```

## Without DI

```csharp
await using var watchup = new WatchupClient(new WatchupOptions { ApiKey = "wup_live_..." });
watchup.CaptureError(new InvalidOperationException("boom"), route: "job.import");
await watchup.FlushAsync();
```

`DisposeAsync` stops the background loop and delivers what is queued (up to `ShutdownTimeout`).

## Configuration

| Option | Default | Description |
| --- | --- | --- |
| `ApiKey` | — | **Required.** Secret project key (`wup_live_…`). |
| `BaseUrl` | `https://api.watchup.site` | Self-hosted API URL. |
| `Environment` | `ASPNETCORE_ENVIRONMENT`, then `production` | Label on every item. |
| `Release` / `Service` | — | Deploy and service labels. |
| `FlushInterval` | 5 s | Background flush interval. |
| `MaxBatchSize` / `MaxQueueSize` | 100 / 1000 | Items per request / items kept while offline. |
| `SampleRate` | 1.0 | Fraction of requests traced. |
| `HttpTimeout` / `ShutdownTimeout` | 8 s / 5 s | Per-request and shutdown timeouts. |
| `RedactKeys` | empty | Extra keys to redact. |
| `OnDiagnostic` | — | Delivery diagnostics (never captured data). |
| `CaptureServerErrorResponses` | `true` | Also report 5xx responses that did not throw. |
| `Debug` | `false` | Write diagnostics to stderr. |

## Delivery

Items are redacted and serialized when captured; requests stay under 192 KiB and 100 items; oversized items are truncated; every request has an `Idempotency-Key` and failures are retried with the same key. See the [transport contract](../../spec/README.md) and the [changelog](../CHANGELOG.md).

## License

MIT © Watchup Ltd
