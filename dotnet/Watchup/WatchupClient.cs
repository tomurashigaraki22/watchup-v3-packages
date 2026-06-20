// ─────────────────────────────────────────────────────────────────────────────
// Watchup .NET SDK  ·  WatchupClient
// ─────────────────────────────────────────────────────────────────────────────

namespace Watchup;

/// <summary>
/// Main entry point for the Watchup SDK.
/// </summary>
/// <example>
/// <code>
/// var watchup = new WatchupClient(new WatchupOptions { ApiKey = "wup_live_..." });
///
/// // In ASP.NET Core, prefer DI:
/// builder.Services.AddWatchup(o => o.ApiKey = "wup_live_...");
/// app.UseWatchup();
/// </code>
/// </example>
public sealed class WatchupClient : IAsyncDisposable
{
    private readonly WatchupOptions _opts;
    private readonly Batcher        _batcher;

    public WatchupClient(WatchupOptions options)
    {
        if (string.IsNullOrWhiteSpace(options.ApiKey))
            throw new ArgumentException(
                "[watchup] ApiKey is required. " +
                "Find it in your Watchup dashboard → Project Settings → API Keys.",
                nameof(options));

        _opts = options;

        var http = new HttpClient { Timeout = options.HttpTimeout };
        http.DefaultRequestHeaders.Add("X-Api-Key",  options.ApiKey);
        http.DefaultRequestHeaders.Add("User-Agent", "watchup-dotnet/1.0");

        var transport = new Transport(http, options.BaseUrl, options.Debug);
        _batcher      = new Batcher(transport, options);
        _batcher.Start();
    }

    // ── Manual tracking ───────────────────────────────────────────────────────

    /// <summary>
    /// Track a custom analytics event.
    /// Events appear in the Watchup dashboard under <b>Events</b>.
    /// </summary>
    /// <example>
    /// <code>
    /// watchup.Track("user.signed_up", new() { ["plan"] = "pro" });
    /// watchup.Track("payment.completed", new() { ["amount"] = 49.99 });
    /// </code>
    /// </example>
    public void Track(string name, Dictionary<string, object?>? properties = null)
    {
        if (string.IsNullOrEmpty(name)) return;

        _batcher.AddEvent(new EventPayload
        {
            Name        = name,
            Properties  = properties,
            OccurredAt  = DateTime.UtcNow.ToString("O"),
        });
    }

    /// <summary>
    /// Manually capture an error that isn't caught by the ASP.NET Core middleware
    /// (e.g. inside background jobs, queue consumers, or scheduled tasks).
    /// </summary>
    /// <example>
    /// <code>
    /// try { await ProcessOrder(orderId); }
    /// catch (Exception ex)
    /// {
    ///     watchup.CaptureError(ex, route: "job.process_order",
    ///         context: new() { ["orderId"] = orderId });
    /// }
    /// </code>
    /// </example>
    public void CaptureError(
        Exception                   exception,
        string?                     route   = null,
        string                      level   = "error",
        Dictionary<string, object?>? context = null)
    {
        _batcher.AddError(new ErrorPayload
        {
            Message     = exception.Message,
            Level       = level,
            Route       = route,
            Stack       = exception.StackTrace,
            Context     = context,
            Timestamp   = DateTime.UtcNow.ToString("O"),
            Environment = _opts.Environment,
            Release     = _opts.Release,
        });
    }

    /// <summary>
    /// Capture a raw error message that isn't an <see cref="Exception"/>.
    /// </summary>
    public void CaptureError(
        string                      message,
        string?                     route   = null,
        string                      level   = "error",
        Dictionary<string, object?>? context = null)
    {
        _batcher.AddError(new ErrorPayload
        {
            Message     = message,
            Level       = level,
            Route       = route,
            Context     = context,
            Timestamp   = DateTime.UtcNow.ToString("O"),
            Environment = _opts.Environment,
            Release     = _opts.Release,
        });
    }

    /// <summary>
    /// Time a non-HTTP operation (background job, cron, queue consumer, RPC…)
    /// and send it as a trace.
    /// <para>
    /// Dispose the returned handle when the operation finishes —
    /// use a <c>using</c> statement for automatic timing.
    /// </para>
    /// </summary>
    /// <example>
    /// <code>
    /// using (watchup.StartTrace("job.generate_report"))
    /// {
    ///     await GenerateReport();
    /// }
    ///
    /// // Or with explicit error status:
    /// var trace = watchup.StartTrace("job.send_email");
    /// try   { await SendEmail(); trace.Complete(); }
    /// catch { trace.Complete(status: "err"); throw; }
    /// </code>
    /// </example>
    public TraceHandle StartTrace(string span, Dictionary<string, object?>? meta = null)
        => new TraceHandle(span, meta, _opts, _batcher);

    // ── Manual trace ──────────────────────────────────────────────────────────

    /// <summary>
    /// Send a pre-built trace directly — useful when you already have timing.
    /// </summary>
    public void SendTrace(TracePayload trace) => _batcher.AddTrace(trace);

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    /// <summary>
    /// Immediately flush all queued items.
    /// Normally not needed — the batcher flushes on interval and on shutdown.
    /// </summary>
    public Task FlushAsync() => _batcher.FlushAsync();

    /// <summary>
    /// Stop the background flush timer and send any remaining items.
    /// Called automatically when the <see cref="IHostedService"/> stops.
    /// </summary>
    public async ValueTask DisposeAsync() => await _batcher.DisposeAsync();

    internal WatchupOptions Options => _opts;
}

// ─────────────────────────────────────────────────────────────────────────────
// TraceHandle — returned by StartTrace(), disposed to end the span
// ─────────────────────────────────────────────────────────────────────────────

/// <summary>
/// Represents an in-flight trace span. Dispose to record the duration.
/// </summary>
public sealed class TraceHandle : IDisposable
{
    private readonly string          _span;
    private readonly long            _startMs;
    private readonly WatchupOptions  _opts;
    private readonly Batcher         _batcher;
    private readonly Dictionary<string, object?>? _meta;

    private string  _status   = "ok";
    private bool    _disposed = false;

    internal TraceHandle(string span, Dictionary<string, object?>? meta, WatchupOptions opts, Batcher batcher)
    {
        _span    = span;
        _meta    = meta;
        _opts    = opts;
        _batcher = batcher;
        _startMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    }

    /// <summary>
    /// Mark this span as completed with the given status before disposing.
    /// </summary>
    public void Complete(string status = "ok") => _status = status;

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;

        var ms = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - _startMs;

        _batcher.AddTrace(new TracePayload
        {
            Span        = _span,
            Ms          = ms,
            StatusCode  = _status == "err" ? 500 : _status == "warn" ? 400 : 200,
            Status      = _status,
            Timestamp   = DateTime.UtcNow.ToString("O"),
            Environment = _opts.Environment,
            Release     = _opts.Release,
            Meta        = _meta,
        });
    }
}
