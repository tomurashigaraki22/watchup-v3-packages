// ─────────────────────────────────────────────────────────────────────────────
// Watchup .NET SDK  ·  Batcher
//
// Accumulates traces/errors/events and flushes them in batches.
// Uses System.Threading.Channels for lock-free, thread-safe queuing.
// ─────────────────────────────────────────────────────────────────────────────

using System.Threading.Channels;

namespace Watchup;

internal sealed class Batcher : IAsyncDisposable
{
    private readonly Channel<TracePayload> _traces;
    private readonly Channel<ErrorPayload> _errors;
    private readonly Channel<EventPayload> _events;

    private readonly Transport  _transport;
    private readonly int        _maxBatchSize;
    private readonly TimeSpan   _flushInterval;

    private readonly CancellationTokenSource _cts = new();
    private Task? _timerTask;

    internal Batcher(Transport transport, WatchupOptions opts)
    {
        _transport     = transport;
        _maxBatchSize  = opts.MaxBatchSize;
        _flushInterval = opts.FlushInterval;

        var co = new BoundedChannelOptions(opts.MaxBatchSize * 4)
        {
            FullMode     = BoundedChannelFullMode.DropOldest,
            SingleReader = true,
        };

        _traces = Channel.CreateBounded<TracePayload>(co);
        _errors = Channel.CreateBounded<ErrorPayload>(co);
        _events = Channel.CreateBounded<EventPayload>(co);
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    internal void Start()
    {
        _timerTask = RunFlushLoopAsync(_cts.Token);
    }

    private async Task RunFlushLoopAsync(CancellationToken ct)
    {
        try
        {
            while (!ct.IsCancellationRequested)
            {
                await Task.Delay(_flushInterval, ct).ConfigureAwait(false);
                await FlushAsync(ct).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException) { }
    }

    // ── Enqueue ───────────────────────────────────────────────────────────────

    internal void AddTrace(TracePayload trace)
    {
        _traces.Writer.TryWrite(trace);
        if (_traces.Reader.Count >= _maxBatchSize)
            _ = FlushAsync(CancellationToken.None);
    }

    internal void AddError(ErrorPayload error)
    {
        _errors.Writer.TryWrite(error);
        // Errors are higher priority — flush at half capacity
        if (_errors.Reader.Count >= Math.Max(1, _maxBatchSize / 2))
            _ = FlushAsync(CancellationToken.None);
    }

    internal void AddEvent(EventPayload evt)
    {
        _events.Writer.TryWrite(evt);
        if (_events.Reader.Count >= _maxBatchSize)
            _ = FlushAsync(CancellationToken.None);
    }

    // ── Flush ─────────────────────────────────────────────────────────────────

    internal async Task FlushAsync(CancellationToken ct = default)
    {
        var traces = Drain(_traces.Reader, _maxBatchSize);
        var errors = Drain(_errors.Reader, _maxBatchSize);
        var events = Drain(_events.Reader, _maxBatchSize);

        if (traces.Count == 0 && errors.Count == 0 && events.Count == 0)
            return;

        var batch = new IngestBatch
        {
            Traces = traces.Count > 0 ? traces : null,
            Errors = errors.Count > 0 ? errors : null,
            Events = events.Count > 0 ? events : null,
        };

        await _transport.SendAsync(batch, ct).ConfigureAwait(false);
    }

    private static List<T> Drain<T>(ChannelReader<T> reader, int max)
    {
        var list = new List<T>();
        while (list.Count < max && reader.TryRead(out var item))
            list.Add(item);
        return list;
    }

    // ── IAsyncDisposable ──────────────────────────────────────────────────────

    public async ValueTask DisposeAsync()
    {
        _cts.Cancel();

        if (_timerTask is not null)
        {
            try { await _timerTask.ConfigureAwait(false); }
            catch (OperationCanceledException) { }
        }

        // Final flush
        await FlushAsync(CancellationToken.None).ConfigureAwait(false);

        _cts.Dispose();
        _traces.Writer.Complete();
        _errors.Writer.Complete();
        _events.Writer.Complete();
    }
}
