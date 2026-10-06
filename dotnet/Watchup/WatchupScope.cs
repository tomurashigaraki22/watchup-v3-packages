// ─────────────────────────────────────────────────────────────────────────────
// Watchup .NET SDK  ·  per-request scope
//
// AsyncLocal keeps the user and request ID per request (and per async flow),
// so concurrent requests never share identity.
// ─────────────────────────────────────────────────────────────────────────────

namespace Watchup;

/// <summary>The user behind a request.</summary>
public sealed class WatchupUser
{
    public WatchupUser(string id, string? email = null, string? name = null)
    {
        Id = id;
        Email = email;
        Name = name;
    }

    public string Id { get; }
    public string? Email { get; }
    public string? Name { get; }
    public Dictionary<string, object?>? Extra { get; set; }

    internal Dictionary<string, object?> ToDictionary()
    {
        var d = Extra is null ? new Dictionary<string, object?>() : new Dictionary<string, object?>(Extra);
        d["id"] = Id;
        if (Email is not null) d["email"] = Email;
        if (Name is not null) d["name"] = Name;
        return d;
    }
}

/// <summary>Request-scoped context: request ID, trace ID, route and user.</summary>
public sealed class WatchupScope : IDisposable
{
    private static readonly AsyncLocal<WatchupScope?> CurrentScope = new();
    private readonly WatchupScope? _previous;
    private bool _disposed;

    private WatchupScope(string? requestId)
    {
        _previous = CurrentScope.Value;
        RequestId = string.IsNullOrEmpty(requestId) ? Guid.NewGuid().ToString() : requestId!;
        CurrentScope.Value = this;
    }

    /// <summary>The scope of the current async flow, if any.</summary>
    public static WatchupScope? Current => CurrentScope.Value;

    /// <summary>
    /// Start a scope for background work (queue consumers, jobs). Dispose it when done.
    /// </summary>
    public static WatchupScope Begin(string? requestId = null, string? route = null) => new(requestId) { Route = route };

    public string RequestId { get; }
    public string? TraceId { get; set; }
    public string? Route { get; set; }
    public WatchupUser? User { get; set; }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        if (CurrentScope.Value == this) CurrentScope.Value = _previous;
    }
}
