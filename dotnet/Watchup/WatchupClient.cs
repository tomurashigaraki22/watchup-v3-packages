// ─────────────────────────────────────────────────────────────────────────────
// Watchup .NET SDK  ·  WatchupClient
// ─────────────────────────────────────────────────────────────────────────────

using System.Diagnostics;
using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Watchup;

/// <summary>Main entry point for the Watchup SDK. Thread-safe; register as a singleton.</summary>
/// <example>
/// <code>
/// await using var watchup = new WatchupClient(new WatchupOptions { ApiKey = "wup_live_..." });
///
/// // ASP.NET Core:
/// builder.Services.AddWatchup(o => o.ApiKey = builder.Configuration["Watchup:ApiKey"]!);
/// app.UseRouting();
/// app.UseWatchup();
/// </code>
/// </example>
public sealed class WatchupClient : IAsyncDisposable
{
    /// <summary>sdk.name sent in every envelope.</summary>
    public const string SdkName = "watchup-dotnet";

    /// <summary>sdk.version sent in every envelope.</summary>
    public const string SdkVersion = "1.1.1";

    private readonly WatchupOptions _opts;
    private readonly DeliveryQueue _queue;
    private readonly HttpClient? _ownedHttp;
    private WatchupUser? _defaultUser;
    private int _disposed;

    public WatchupClient(WatchupOptions options) : this(options, null) { }

    /// <summary>Create a client that sends with <paramref name="httpClient"/> (e.g. from IHttpClientFactory).</summary>
    public WatchupClient(WatchupOptions options, HttpClient? httpClient)
    {
        if (string.IsNullOrWhiteSpace(options.ApiKey))
            throw new ArgumentException(
                "[watchup] ApiKey is required. Find it in your Watchup dashboard → Project Settings → API Keys.",
                nameof(options));
        if (options.SampleRate is < 0 or > 1)
            throw new ArgumentOutOfRangeException(nameof(options), "[watchup] SampleRate must be between 0 and 1.");

        _opts = options;
        if (httpClient is null) _ownedHttp = httpClient = new HttpClient();
        var transport = new Transport(httpClient, options.BaseUrl, options.ApiKey, options.HttpTimeout);
        _queue = new DeliveryQueue(
            transport.SendAsync,
            EnvelopeBase,
            options.MaxBatchSize,
            options.MaxQueueSize,
            options.RedactKeys,
            OnDiagnostic);
        _queue.Start(options.FlushInterval);
    }

    internal WatchupOptions Options => _opts;

    internal DeliveryQueue Queue => _queue;

    private bool Disposed => Volatile.Read(ref _disposed) == 1;

    private JsonObject EnvelopeBase()
    {
        var b = new JsonObject
        {
            ["sdk"] = new JsonObject { ["name"] = SdkName, ["version"] = SdkVersion },
            ["environment"] = _opts.Environment,
        };
        if (!string.IsNullOrEmpty(_opts.Release)) b["release"] = _opts.Release;
        return b;
    }

    private void OnDiagnostic(WatchupDiagnostic d)
    {
        if (_opts.Debug) Console.Error.WriteLine($"[watchup] {d.Type}: {d.Message}");
        _opts.OnDiagnostic?.Invoke(d);
    }

    private static string Now() => DateTime.UtcNow.ToString("O", CultureInfo.InvariantCulture);

    private Dictionary<string, object?> BaseContext()
    {
        var ctx = new Dictionary<string, object?> { ["source"] = "server" };
        if (_opts.Service is not null) ctx["service"] = _opts.Service;
        var scope = WatchupScope.Current;
        if (scope is not null)
        {
            ctx["request_id"] = scope.RequestId;
            if (scope.TraceId is not null) ctx["trace_id"] = scope.TraceId;
        }
#if NET5_0_OR_GREATER
        else if (Activity.Current is { } activity && activity.IdFormat == ActivityIdFormat.W3C)
        {
            ctx["trace_id"] = activity.TraceId.ToString();
        }
#endif
        return ctx;
    }

    private Dictionary<string, object?>? CurrentUser() => (WatchupScope.Current?.User ?? _defaultUser)?.ToDictionary();

    // ── Identity ─────────────────────────────────────────────────────────────

    /// <summary>
    /// Attach a user. Inside a request (or <see cref="WatchupScope.Begin"/>) it applies to
    /// that scope only; otherwise it becomes the default for this client.
    /// </summary>
    public void SetUser(WatchupUser? user)
    {
        var scope = WatchupScope.Current;
        if (scope is not null) scope.User = user;
        else _defaultUser = user;
    }

    // ── Manual tracking ──────────────────────────────────────────────────────

    /// <summary>Track a custom analytics event.</summary>
    /// <example><code>watchup.Track("user.signed_up", new() { ["plan"] = "pro" });</code></example>
    public void Track(string name, Dictionary<string, object?>? properties = null)
    {
        if (string.IsNullOrEmpty(name) || Disposed) return;
        var props = BaseContext();
        if (CurrentUser() is { } user) props["user"] = user;
        if (properties is not null) foreach (var kv in properties) props[kv.Key] = kv.Value;
        _queue.Enqueue("events", new Dictionary<string, object?> { ["name"] = name, ["properties"] = props, ["occurred_at"] = Now() });
    }

    /// <summary>Capture an exception. Each exception object is reported once.</summary>
    public void CaptureError(Exception exception, string? route = null, string level = "error", Dictionary<string, object?>? context = null)
    {
        if (Disposed) return;
        if (exception.Data.Contains(CapturedKey)) return;
        try { exception.Data[CapturedKey] = true; } catch { /* read-only Data */ }
        Enqueue(exception.Message, exception.GetType().FullName, exception.ToString(), route, level, context);
    }

    private const string CapturedKey = "__watchup_captured__";

    /// <summary>Capture an error message that is not an <see cref="Exception"/>.</summary>
    public void CaptureError(string message, string? route = null, string level = "error", Dictionary<string, object?>? context = null)
    {
        if (Disposed) return;
        Enqueue(message, null, null, route, level, context);
    }

    private void Enqueue(string message, string? type, string? stack, string? route, string level, Dictionary<string, object?>? context)
    {
        var ctx = new Dictionary<string, object?>(context ?? new Dictionary<string, object?>());
        foreach (var kv in BaseContext()) ctx[kv.Key] = kv.Value;
        var item = new Dictionary<string, object?>
        {
            ["message"] = message,
            ["level"] = level,
            ["context"] = ctx,
            ["timestamp"] = Now(),
            ["environment"] = _opts.Environment,
        };
        if (type is not null) item["type"] = type;
        if (stack is not null) item["stack"] = stack;
        var resolvedRoute = route ?? WatchupScope.Current?.Route;
        if (resolvedRoute is not null) item["route"] = resolvedRoute;
        if (_opts.Release is not null) item["release"] = _opts.Release;
        if (CurrentUser() is { } user) item["user"] = user;
        _queue.Enqueue("errors", item);
    }

    /// <summary>Time an operation; dispose the handle (or call <see cref="TraceHandle.Complete"/>) to record it.</summary>
    /// <example>
    /// <code>
    /// using (watchup.StartTrace("job.generate_report")) { await GenerateReport(); }
    /// </code>
    /// </example>
    public TraceHandle StartTrace(string span, Dictionary<string, object?>? meta = null, string type = "custom")
        => new(this, span, meta, type);

    /// <summary>
    /// Record a database span around <paramref name="query"/>. The statement is sanitized
    /// (literals become ?, max 1 KiB); parameters are never recorded.
    /// </summary>
    public async Task<T> TraceQueryAsync<T>(string statement, Func<Task<T>> query, string? system = null, TimeSpan? slow = null)
    {
        var meta = new Dictionary<string, object?>();
        if (system is not null) meta["db_system"] = system;
        var handle = StartTrace(SqlSanitizer.Sanitize(statement), meta, "db");
        var sw = Stopwatch.StartNew();
        try
        {
            var result = await query().ConfigureAwait(false);
            if (sw.Elapsed > (slow ?? TimeSpan.FromMilliseconds(500)))
            {
                meta["slow"] = true;
                handle.Complete("warn");
            }
            return result;
        }
        catch
        {
            handle.Complete("err");
            throw;
        }
        finally
        {
            handle.Dispose();
        }
    }

    /// <summary>Send a pre-built trace (when you already have timing).</summary>
    public void SendTrace(TracePayload trace)
    {
        if (Disposed) return;
        var node = JsonSerializer.SerializeToNode(trace, Contract.Json) as JsonObject ?? new JsonObject();
        var meta = node["meta"] as JsonObject ?? new JsonObject();
        foreach (var kv in BaseContext()) meta[kv.Key] = JsonValue.Create(kv.Value?.ToString());
        node["meta"] = meta;
        if (CurrentUser() is { } user && node["user"] is null) node["user"] = JsonSerializer.SerializeToNode(user, Contract.Json);
        _queue.Enqueue("traces", node);
    }

    internal void RecordTrace(string span, string type, double ms, int statusCode, string status, DateTime startedAt, Dictionary<string, object?>? meta)
    {
        if (Disposed) return;
        var m = new Dictionary<string, object?>(meta ?? new Dictionary<string, object?>());
        foreach (var kv in BaseContext()) m[kv.Key] = kv.Value;
        var item = new Dictionary<string, object?>
        {
            ["span"] = span,
            ["type"] = type,
            ["ms"] = Math.Round(ms, 2),
            ["status_code"] = statusCode,
            ["status"] = status,
            ["timestamp"] = startedAt.ToString("O", CultureInfo.InvariantCulture),
            ["environment"] = _opts.Environment,
            ["meta"] = m,
        };
        if (_opts.Release is not null) item["release"] = _opts.Release;
        if (CurrentUser() is { } user) item["user"] = user;
        _queue.Enqueue("traces", item);
    }

    // ── Lifecycle ────────────────────────────────────────────────────────────

    /// <summary>Send everything queued now; completes when the attempt finishes.</summary>
    public Task<FlushResult> FlushAsync(CancellationToken cancellationToken = default) => _queue.FlushAsync(false, cancellationToken);

    /// <summary>Stop the background loop and deliver what is queued (up to <see cref="WatchupOptions.ShutdownTimeout"/>).</summary>
    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref _disposed, 1) == 1) return;
        await _queue.ShutdownAsync(_opts.ShutdownTimeout).ConfigureAwait(false);
        _ownedHttp?.Dispose();
    }
}

/// <summary>An in-flight trace span. Dispose to record the duration.</summary>
public sealed class TraceHandle : IDisposable
{
    private readonly WatchupClient _client;
    private readonly string _span;
    private readonly string _type;
    private readonly Dictionary<string, object?>? _meta;
    private readonly Stopwatch _watch = Stopwatch.StartNew();
    private readonly DateTime _startedAt = DateTime.UtcNow;
    private string _status = "ok";
    private int? _statusCode;
    private int _disposed;

    internal TraceHandle(WatchupClient client, string span, Dictionary<string, object?>? meta, string type)
    {
        _client = client;
        _span = span;
        _meta = meta;
        _type = type;
    }

    /// <summary>Set the status ("ok", "warn", "err") and optionally a real status code.</summary>
    public void Complete(string status = "ok", int? statusCode = null)
    {
        _status = status is "warn" or "err" ? status : "ok";
        _statusCode = statusCode;
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) == 1) return;
        var code = _statusCode ?? (_status == "err" ? 500 : _status == "warn" ? 400 : 200);
        _client.RecordTrace(_span, _type, _watch.Elapsed.TotalMilliseconds, code, _status, _startedAt, _meta);
    }
}
