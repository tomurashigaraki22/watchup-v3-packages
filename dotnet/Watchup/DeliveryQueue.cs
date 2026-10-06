// ─────────────────────────────────────────────────────────────────────────────
// Watchup .NET SDK  ·  delivery queue (spec §4, §7, §8)
//
// Items are normalized, redacted and serialized at capture time. A background
// loop sends byte-aware chunks one at a time; failed chunks wait for their
// backoff without blocking newer chunks and keep their idempotency key.
// ─────────────────────────────────────────────────────────────────────────────

using System.Globalization;
using System.Text.Json.Nodes;

namespace Watchup;

/// <summary>Result of sending one chunk.</summary>
public readonly record struct SendResult(bool Ok, int Status = 0, string? Code = null, TimeSpan? RetryAfter = null, string? Error = null);

/// <summary>Summary of one flush.</summary>
public sealed record FlushResult(int Accepted, int DeliveredItems, int Retrying, int Dropped);

/// <summary>A delivery diagnostic. Never contains captured data or keys.</summary>
public sealed record WatchupDiagnostic(string Type, string Message, IReadOnlyDictionary<string, object?> Details);

internal sealed class DeliveryQueue
{
    private readonly Func<Chunk, CancellationToken, Task<SendResult>> _send;
    private readonly Func<JsonObject> _base;
    private readonly int _maxBytes;
    private readonly int _maxItems;
    private readonly int _maxQueueItems;
    private readonly int _maxAttempts;
    private readonly ISet<string> _redactKeys;
    private readonly Action<WatchupDiagnostic>? _onDiagnostic;
    private readonly bool _autoFlush;
    private readonly Func<DateTimeOffset> _now;
    private readonly Func<double> _random;

    private readonly object _lock = new();
    private readonly SemaphoreSlim _drain = new(1, 1);
    private readonly SemaphoreSlim _wake = new(0, int.MaxValue);
    private Dictionary<string, List<Contract.PreparedItem>> _pending = NewGroups();
    private int _pendingBytes;
    private List<Chunk> _retry = new();
    private readonly Dictionary<string, int> _overflow = Contract.Kinds.ToDictionary(k => k, _ => 0);
    private CancellationTokenSource? _loopCts;
    private Task? _loop;

    internal DeliveryQueue(
        Func<Chunk, CancellationToken, Task<SendResult>> send,
        Func<JsonObject> envelopeBase,
        int maxItems = WatchupLimits.MaxChunkItems,
        int maxQueueItems = WatchupLimits.MaxQueueItems,
        IEnumerable<string>? redactKeys = null,
        Action<WatchupDiagnostic>? onDiagnostic = null,
        bool autoFlush = true,
        Func<DateTimeOffset>? now = null,
        Func<double>? random = null,
        int maxBytes = WatchupLimits.MaxChunkBytes,
        int maxAttempts = WatchupLimits.MaxAttempts)
    {
        _send = send;
        _base = envelopeBase;
        _maxBytes = maxBytes;
        _maxItems = Math.Clamp(maxItems, 1, WatchupLimits.MaxChunkItems);
        _maxQueueItems = maxQueueItems > 0 ? maxQueueItems : WatchupLimits.MaxQueueItems;
        _maxAttempts = maxAttempts;
        _redactKeys = new HashSet<string>((redactKeys ?? Array.Empty<string>()).Select(Contract.CanonicalKey));
        _onDiagnostic = onDiagnostic;
        _autoFlush = autoFlush;
        _now = now ?? (() => DateTimeOffset.UtcNow);
        _random = random ?? (() => ThreadSafeRandom.NextDouble());
    }

    private static Dictionary<string, List<Contract.PreparedItem>> NewGroups() =>
        Contract.Kinds.ToDictionary(k => k, _ => new List<Contract.PreparedItem>());

    // ── Background loop ──────────────────────────────────────────────────────

    internal void Start(TimeSpan interval)
    {
        if (_loop is not null) return;
        _loopCts = new CancellationTokenSource();
        var ct = _loopCts.Token;
        _loop = Task.Run(async () =>
        {
            while (!ct.IsCancellationRequested)
            {
                var wait = interval;
                lock (_lock)
                {
                    if (_retry.Count > 0)
                    {
                        var due = _retry.Min(c => c.NextAttemptAt) - _now();
                        if (due < wait) wait = due < TimeSpan.Zero ? TimeSpan.Zero : due;
                    }
                }
                try
                {
                    await _wake.WaitAsync(wait, ct).ConfigureAwait(false);
                    await FlushAsync(false, ct).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    break;
                }
                catch
                {
                    // The loop must survive anything.
                }
            }
        });
    }

    internal async Task StopAsync()
    {
        if (_loopCts is null) return;
        _loopCts.Cancel();
        try { if (_loop is not null) await _loop.ConfigureAwait(false); } catch { /* ignored */ }
        _loopCts.Dispose();
        _loopCts = null;
        _loop = null;
    }

    // ── Enqueue ──────────────────────────────────────────────────────────────

    internal bool Enqueue(string kind, object item)
    {
        if (Contract.Normalize(item, _redactKeys) is not JsonObject normalized) return false;
        var budget = _maxBytes - Contract.EnvelopeOverhead(_base());
        var fit = Contract.FitItem(normalized, budget);
        var bytes = Contract.Utf8Length(fit.Json);
        var noun = kind.Substring(0, kind.Length - 1);
        if (fit.Truncated) Diagnose("item_truncated", $"A {noun} was truncated to fit the request size limit.", ("kind", kind), ("bytes", bytes));
        if (fit.Oversized) Diagnose("item_oversized", $"A {noun} is still larger than the chunk limit; it will be sent alone.", ("kind", kind), ("bytes", bytes));

        bool flush;
        lock (_lock)
        {
            _pending[kind].Add(new Contract.PreparedItem(kind, fit.Json, bytes));
            _pendingBytes += bytes;
            EnforceBound();
            flush = _autoFlush && (PendingCountLocked() >= _maxItems || _pendingBytes >= _maxBytes || _pending["errors"].Count >= (_maxItems + 1) / 2);
        }
        if (flush) _wake.Release(); // never send on the caller's thread
        return true;
    }

    private int PendingCountLocked() => _pending.Values.Sum(l => l.Count);

    internal int PendingCount { get { lock (_lock) return PendingCountLocked(); } }

    internal int RetryingCount { get { lock (_lock) return _retry.Sum(c => c.Items); } }

    // ── Flush ────────────────────────────────────────────────────────────────

    internal async Task<FlushResult> FlushAsync(bool force = false, CancellationToken ct = default)
    {
        int accepted = 0, delivered = 0, retrying = 0, dropped = 0;
        await _drain.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            List<Chunk> work;
            lock (_lock)
            {
                ReportOverflow();
                var now = _now();
                var due = _retry.Where(c => force || c.NextAttemptAt <= now).ToList();
                _retry = _retry.Where(c => !due.Contains(c)).ToList();
                work = due.Concat(Cut()).ToList();
            }
            foreach (var chunk in work)
            {
                switch (await SendOneAsync(chunk, ct).ConfigureAwait(false))
                {
                    case Outcome.Accepted: accepted++; delivered += chunk.Items; break;
                    case Outcome.Retrying: retrying++; break;
                    case Outcome.Dropped: dropped++; break;
                }
            }
        }
        finally
        {
            _drain.Release();
        }
        return new FlushResult(accepted, delivered, retrying, dropped);
    }

    private List<Chunk> Cut()
    {
        if (PendingCountLocked() == 0) return new List<Chunk>();
        var groups = _pending;
        _pending = NewGroups();
        _pendingBytes = 0;
        var sentAt = DateTimeOffset.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", CultureInfo.InvariantCulture);
        return Contract.BuildChunks(groups, _base(), _maxBytes, _maxItems, Guid.NewGuid().ToString(), sentAt);
    }

    private enum Outcome { Accepted, Retrying, Dropped }

    private async Task<Outcome> SendOneAsync(Chunk chunk, CancellationToken ct)
    {
        chunk.Attempts++;
        SendResult res;
        try
        {
            res = await _send(chunk, ct).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            res = new SendResult(false, Error: ex.Message);
        }
        if (res.Ok) return Outcome.Accepted;

        var details = new List<(string, object?)> { ("idempotency_key", chunk.IdempotencyKey), ("attempt", chunk.Attempts), ("items", chunk.Items) };
        if (res.Status != 0) details.Add(("status", res.Status));
        if (res.Code is not null) details.Add(("code", res.Code));
        if (res.Error is not null) details.Add(("error", res.Error));

        if (res.Status != 0 && !Contract.IsRetryableStatus(res.Status))
        {
            Diagnose("chunk_rejected", $"The server rejected a batch (HTTP {res.Status}{(res.Code is null ? "" : " " + res.Code)}); it will not be retried.", details.ToArray());
            return Outcome.Dropped;
        }
        if (chunk.Attempts >= _maxAttempts)
        {
            Diagnose("chunk_dropped", $"A batch failed {chunk.Attempts} times and was dropped.", details.ToArray());
            return Outcome.Dropped;
        }

        var delay = Backoff(chunk.Attempts, res.RetryAfter);
        chunk.NextAttemptAt = _now() + delay;
        lock (_lock)
        {
            _retry.Add(chunk);
            while (_retry.Count > WatchupLimits.MaxRetryChunks)
            {
                var old = _retry[0];
                _retry.RemoveAt(0);
                Diagnose("chunk_dropped", "Too many batches waiting for a retry; the oldest was dropped.", ("idempotency_key", old.IdempotencyKey), ("items", old.Items));
            }
        }
        details.Add(("delay_ms", (long)delay.TotalMilliseconds));
        Diagnose("chunk_retry", $"Batch delivery failed; retrying in {(long)delay.TotalMilliseconds} ms.", details.ToArray());
        _wake.Release();
        return Outcome.Retrying;
    }

    private TimeSpan Backoff(int attempt, TimeSpan? retryAfter)
    {
        if (retryAfter is { } ra) return ra > TimeSpan.FromMilliseconds(WatchupLimits.MaxRetryAfterMs) ? TimeSpan.FromMilliseconds(WatchupLimits.MaxRetryAfterMs) : ra;
        var exp = Math.Min(WatchupLimits.MaxBackoffMs, WatchupLimits.BaseBackoffMs * Math.Pow(2, attempt - 1));
        return TimeSpan.FromMilliseconds(Math.Round(exp * (0.5 + _random() * 0.5)));
    }

    // ── Shutdown ─────────────────────────────────────────────────────────────

    /// <summary>Stop the loop and deliver until <paramref name="timeout"/>. Returns undelivered items.</summary>
    internal async Task<int> ShutdownAsync(TimeSpan timeout)
    {
        await StopAsync().ConfigureAwait(false);
        var deadline = DateTimeOffset.UtcNow + timeout;
        while (true)
        {
            using var cts = new CancellationTokenSource(Max(deadline - DateTimeOffset.UtcNow, TimeSpan.FromMilliseconds(1)));
            try { await FlushAsync(false, cts.Token).ConfigureAwait(false); } catch (OperationCanceledException) { break; }
            DateTimeOffset next;
            lock (_lock)
            {
                if (_retry.Count == 0) break;
                next = _retry.Min(c => c.NextAttemptAt);
            }
            var wait = next - _now();
            if (DateTimeOffset.UtcNow + wait > deadline) break;
            if (wait > TimeSpan.Zero) await Task.Delay(wait).ConfigureAwait(false);
        }
        var pending = PendingCount;
        var retrying = RetryingCount;
        if (pending + retrying > 0)
        {
            Diagnose("undelivered_on_shutdown", $"{pending + retrying} item(s) could not be delivered before shutdown.", ("pending", pending), ("retrying", retrying));
        }
        return pending + retrying;
    }

    private static TimeSpan Max(TimeSpan a, TimeSpan b) => a > b ? a : b;

    // ── Internals ────────────────────────────────────────────────────────────

    private void EnforceBound()
    {
        var excess = PendingCountLocked() - _maxQueueItems;
        foreach (var kind in new[] { "events", "traces", "errors" })
        {
            while (excess > 0 && _pending[kind].Count > 0)
            {
                _pendingBytes -= _pending[kind][0].Bytes;
                _pending[kind].RemoveAt(0);
                _overflow[kind]++;
                excess--;
            }
        }
    }

    private void ReportOverflow()
    {
        var total = _overflow.Values.Sum();
        if (total == 0) return;
        var details = _overflow.Select(kv => (kv.Key, (object?)kv.Value)).ToArray();
        foreach (var k in Contract.Kinds) _overflow[k] = 0;
        Diagnose("queue_overflow", $"The queue was full; dropped {total} oldest item(s).", details);
    }

    private void Diagnose(string type, string message, params (string Key, object? Value)[] details)
    {
        if (_onDiagnostic is null) return;
        try
        {
            _onDiagnostic(new WatchupDiagnostic(type, message, details.ToDictionary(d => d.Key, d => d.Value)));
        }
        catch
        {
            // A throwing handler must never break delivery.
        }
    }
}

internal static class ThreadSafeRandom
{
#if NET6_0_OR_GREATER
    internal static double NextDouble() => Random.Shared.NextDouble();
#else
    [ThreadStatic] private static Random? _random;
    internal static double NextDouble() => (_random ??= new Random(Guid.NewGuid().GetHashCode())).NextDouble();
#endif
}
