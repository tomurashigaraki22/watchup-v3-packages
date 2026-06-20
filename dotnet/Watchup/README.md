# Watchup .NET SDK

Official .NET SDK for [Watchup](https://watchup.site) — request tracing, error capture, and custom event tracking for ASP.NET Core applications.

## Installation

```bash
dotnet add package Watchup
```

## Quick start — ASP.NET Core

```csharp
// Program.cs
using Watchup.Middleware;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddWatchup(o =>
{
    o.ApiKey      = builder.Configuration["Watchup:ApiKey"]!;
    o.Environment = builder.Environment.EnvironmentName;
    o.Release     = "1.2.3";   // optional: git SHA or version
});

var app = builder.Build();

app.UseRouting();
app.UseWatchup();   // ← after UseRouting so route templates resolve
app.MapControllers();

app.Run();
```

The middleware automatically captures:

- **Request traces** — method, route template, duration, status code
- **Unhandled exceptions** — stack trace forwarded as errors
- **5xx responses** — logged as errors even without an exception

---

## Manual tracking

Inject `WatchupClient` wherever you need it:

```csharp
public class OrderService(WatchupClient watchup)
{
    public async Task ProcessOrder(string orderId)
    {
        // Custom event
        watchup.Track("order.received", new() { ["orderId"] = orderId });

        // Time a non-HTTP operation
        using (watchup.StartTrace("job.process_order"))
        {
            await DoWork();
        }

        // Capture an exception from a background job
        try { await SendConfirmationEmail(orderId); }
        catch (Exception ex)
        {
            watchup.CaptureError(ex, route: "job.send_confirmation",
                context: new() { ["orderId"] = orderId });
        }
    }
}
```

---

## Standalone (without DI)

```csharp
var watchup = new WatchupClient(new WatchupOptions
{
    ApiKey  = "wup_live_xxxxxxxxxxxx",
    Debug   = true,   // logs SDK errors to stderr
});

watchup.Track("user.signed_up");
watchup.CaptureError(someException);

await watchup.DisposeAsync(); // flushes remaining items
```

---

## Configuration reference

| Property | Default | Description |
|---|---|---|
| `ApiKey` | *(required)* | Your Watchup project API key |
| `BaseUrl` | `https://api.watchup.site` | Override for self-hosted deployments |
| `Environment` | `ASPNETCORE_ENVIRONMENT` | Attached to every payload |
| `Release` | `null` | App version / git SHA |
| `FlushInterval` | 5 seconds | How often the queue is flushed |
| `MaxBatchSize` | 100 | Items per flush per type |
| `SampleRate` | `1.0` | Fraction of requests to trace (0–1) |
| `HttpTimeout` | 8 seconds | Timeout per ingest HTTP call |
| `Debug` | `false` | Log SDK warnings to stderr |

---

## License

MIT
