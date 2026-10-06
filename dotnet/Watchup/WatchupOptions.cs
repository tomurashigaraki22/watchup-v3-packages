// ─────────────────────────────────────────────────────────────────────────────
// Watchup .NET SDK  ·  WatchupOptions
// ─────────────────────────────────────────────────────────────────────────────

namespace Watchup;

/// <summary>
/// Configuration passed to <see cref="WatchupClient"/> or registered via
/// <c>services.AddWatchup(o => { ... })</c>.
/// </summary>
public sealed class WatchupOptions
{
    /// <summary>Project API key (<c>wup_live_…</c>) from Project Settings → API Keys.</summary>
    public string ApiKey { get; set; } = string.Empty;

    /// <summary>Ingest base URL. Default <c>https://api.watchup.site</c>.</summary>
    public string BaseUrl { get; set; } = "https://api.watchup.site";

    /// <summary>How often the background loop flushes. Default 5 seconds.</summary>
    public TimeSpan FlushInterval { get; set; } = TimeSpan.FromSeconds(5);

    /// <summary>Max items per request (capped at the server's 100). Default 100.</summary>
    public int MaxBatchSize { get; set; } = WatchupLimits.MaxChunkItems;

    /// <summary>Max items held while the API is unreachable; oldest events are dropped first. Default 1000.</summary>
    public int MaxQueueSize { get; set; } = WatchupLimits.MaxQueueItems;

    /// <summary>Write SDK diagnostics to stderr. Default false.</summary>
    public bool Debug { get; set; }

    /// <summary>Environment label. Defaults to <c>ASPNETCORE_ENVIRONMENT</c>, then "production".</summary>
    public string Environment { get; set; } =
        System.Environment.GetEnvironmentVariable("ASPNETCORE_ENVIRONMENT") ?? "production";

    /// <summary>App version / git SHA for deploy correlation.</summary>
    public string? Release { get; set; }

    /// <summary>Service name attached to every item (e.g. "orders-api").</summary>
    public string? Service { get; set; }

    /// <summary>Fraction of requests traced (0–1). Default 1.</summary>
    public double SampleRate { get; set; } = 1.0;

    /// <summary>Timeout per ingest request. Default 8 seconds.</summary>
    public TimeSpan HttpTimeout { get; set; } = TimeSpan.FromSeconds(8);

    /// <summary>Max time <see cref="WatchupClient.DisposeAsync"/> waits for delivery. Default 5 seconds.</summary>
    public TimeSpan ShutdownTimeout { get; set; } = TimeSpan.FromSeconds(5);

    /// <summary>Extra keys to redact on top of the built-in list.</summary>
    public IList<string> RedactKeys { get; } = new List<string>();

    /// <summary>Receives delivery diagnostics (never captured data).</summary>
    public Action<WatchupDiagnostic>? OnDiagnostic { get; set; }

    /// <summary>
    /// Also report a 5xx response that did not throw as an error. Default true
    /// (the 1.0 behaviour); the request trace always records the status.
    /// </summary>
    public bool CaptureServerErrorResponses { get; set; } = true;
}
