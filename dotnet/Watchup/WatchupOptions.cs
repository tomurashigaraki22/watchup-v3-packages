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
    /// <summary>
    /// Your project's API key, found in the Watchup dashboard under
    /// Project Settings → API Keys.  Format: <c>wup_live_xxxxxxxxxxxx</c>
    /// </summary>
    public string ApiKey { get; set; } = string.Empty;

    /// <summary>
    /// Watchup ingest base URL.  Defaults to <c>https://api.watchup.site</c>.
    /// Override for self-hosted deployments.
    /// </summary>
    public string BaseUrl { get; set; } = "https://api.watchup.site";

    /// <summary>
    /// How often to flush the event queue to the API.
    /// Default: 5 seconds.
    /// </summary>
    public TimeSpan FlushInterval { get; set; } = TimeSpan.FromSeconds(5);

    /// <summary>
    /// Maximum number of items of each type to hold before forcing a flush.
    /// Default: 100.
    /// </summary>
    public int MaxBatchSize { get; set; } = 100;

    /// <summary>
    /// Log SDK warnings and HTTP errors.  Default: false.
    /// </summary>
    public bool Debug { get; set; } = false;

    /// <summary>
    /// Runtime environment label attached to every payload.
    /// Defaults to the <c>ASPNETCORE_ENVIRONMENT</c> environment variable,
    /// falling back to <c>"production"</c>.
    /// </summary>
    public string Environment { get; set; } =
        System.Environment.GetEnvironmentVariable("ASPNETCORE_ENVIRONMENT") ?? "production";

    /// <summary>
    /// App version / git SHA attached to every payload.
    /// Useful for correlating errors to deploys.
    /// </summary>
    public string? Release { get; set; }

    /// <summary>
    /// Fraction of requests to capture as traces (0–1).
    /// <c>1</c> = 100 %, <c>0.1</c> = 10 %.  Default: 1.
    /// </summary>
    public double SampleRate { get; set; } = 1.0;

    /// <summary>
    /// Timeout for each HTTP call to the ingest endpoint.
    /// Default: 8 seconds.
    /// </summary>
    public TimeSpan HttpTimeout { get; set; } = TimeSpan.FromSeconds(8);
}
