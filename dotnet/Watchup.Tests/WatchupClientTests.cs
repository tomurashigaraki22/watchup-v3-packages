using System.Text.Json;
using Watchup;

namespace Watchup.Tests;

// ── WatchupOptions ────────────────────────────────────────────────────────────

public class WatchupOptionsTests
{
    [Fact]
    public void DefaultBaseUrl_IsWatchupSite()
        => Assert.Equal("https://api.watchup.site", new WatchupOptions().BaseUrl);

    [Fact]
    public void DefaultFlushInterval_Is5Seconds()
        => Assert.Equal(TimeSpan.FromSeconds(5), new WatchupOptions().FlushInterval);

    [Fact]
    public void DefaultSampleRate_Is1()
        => Assert.Equal(1.0, new WatchupOptions().SampleRate);

    [Fact]
    public void DefaultMaxBatchSize_Is100()
        => Assert.Equal(100, new WatchupOptions().MaxBatchSize);
}

// ── Construction ──────────────────────────────────────────────────────────────

public class WatchupClientConstructionTests
{
    [Fact]
    public void Constructor_ThrowsWhenApiKeyEmpty()
    {
        var ex = Assert.Throws<ArgumentException>(() =>
            new WatchupClient(new WatchupOptions { ApiKey = "" }));
        Assert.Contains("ApiKey", ex.Message);
    }

    [Fact]
    public void Constructor_ThrowsWhenApiKeyWhitespace()
        => Assert.Throws<ArgumentException>(() =>
            new WatchupClient(new WatchupOptions { ApiKey = "   " }));

    [Fact]
    public void Constructor_SucceedsWithValidKey()
    {
        var client = new WatchupClient(new WatchupOptions { ApiKey = "wup_live_test" });
        Assert.NotNull(client);
    }
}

// ── Public API — no real server needed, transport swallows all errors ─────────

public class WatchupClientApiTests : IAsyncDisposable
{
    // Points at a port nothing is listening on — transport swallows the error silently.
    private readonly WatchupClient _client = new(new WatchupOptions
    {
        ApiKey        = "wup_live_test",
        BaseUrl       = "http://localhost:19999",
        FlushInterval = TimeSpan.FromHours(1),
    });

    [Fact]
    public async Task Track_DoesNotThrow()
    {
        _client.Track("test.event", new() { ["key"] = "value" });
        await _client.FlushAsync();
    }

    [Fact]
    public async Task Track_EmptyName_IsIgnoredWithoutThrowing()
    {
        _client.Track("");
        await _client.FlushAsync();
    }

    [Fact]
    public async Task CaptureError_ExceptionOverload_DoesNotThrow()
    {
        _client.CaptureError(new InvalidOperationException("boom"), route: "job.test");
        await _client.FlushAsync();
    }

    [Fact]
    public async Task CaptureError_StringOverload_DoesNotThrow()
    {
        _client.CaptureError("something went wrong", route: "POST /api/test");
        await _client.FlushAsync();
    }

    [Fact]
    public void StartTrace_ReturnsNonNullHandle()
    {
        using var handle = _client.StartTrace("job.test");
        Assert.NotNull(handle);
    }

    [Fact]
    public async Task StartTrace_DisposeRecordsTrace_DoesNotThrow()
    {
        using (_client.StartTrace("job.dispose_test"))
            await Task.Delay(10);

        await _client.FlushAsync();
    }

    [Fact]
    public void TraceHandle_CompleteWithErrorStatus_DoesNotThrow()
    {
        var handle = _client.StartTrace("job.failing");
        handle.Complete("err");
        handle.Dispose();
    }

    [Fact]
    public void TraceHandle_DoubleDispose_IsIdempotent()
    {
        var handle = _client.StartTrace("job.double");
        handle.Dispose();
        handle.Dispose(); // must not throw
    }

    [Fact]
    public async Task SendTrace_DoesNotThrow()
    {
        _client.SendTrace(new TracePayload
        {
            Span       = "job.manual",
            Ms         = 123,
            StatusCode = 200,
            Status     = "ok",
            Timestamp  = DateTime.UtcNow.ToString("O"),
        });
        await _client.FlushAsync();
    }

    public async ValueTask DisposeAsync() => await _client.DisposeAsync();
}

// ── Payload serialization ─────────────────────────────────────────────────────

public class PayloadSerializationTests
{
    private static readonly JsonSerializerOptions NullOmit = new()
    {
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
    };

    [Fact]
    public void TracePayload_SerializesSpanAndMs()
    {
        var json = JsonSerializer.Serialize(new TracePayload
        {
            Span = "GET /api/users/{id}", Ms = 42, StatusCode = 200,
            Status = "ok", Timestamp = "2026-01-01T00:00:00Z",
        });
        Assert.Contains("\"span\"", json);
        Assert.Contains("GET /api/users/{id}", json);
        Assert.Contains("\"ms\"", json);
    }

    [Fact]
    public void TracePayload_NullMeta_Omitted()
    {
        var json = JsonSerializer.Serialize(
            new TracePayload { Span = "s", Ms = 1, StatusCode = 200, Status = "ok", Timestamp = "t" },
            NullOmit);
        Assert.DoesNotContain("meta", json);
    }

    [Fact]
    public void ErrorPayload_SerializesMessage()
    {
        var json = JsonSerializer.Serialize(new ErrorPayload { Message = "boom", Timestamp = "t" });
        Assert.Contains("\"message\"", json);
        Assert.Contains("boom", json);
    }

    [Fact]
    public void ErrorPayload_NullStack_Omitted()
    {
        var json = JsonSerializer.Serialize(
            new ErrorPayload { Message = "m", Timestamp = "t", Stack = null },
            NullOmit);
        Assert.DoesNotContain("stack", json);
    }

    [Fact]
    public void EventPayload_SerializesName()
    {
        var json = JsonSerializer.Serialize(new EventPayload { Name = "user.signed_up", OccurredAt = "t" });
        Assert.Contains("\"name\"", json);
        Assert.Contains("user.signed_up", json);
    }

    [Fact]
    public void EventPayload_NullProperties_Omitted()
    {
        var json = JsonSerializer.Serialize(
            new EventPayload { Name = "evt", OccurredAt = "t", Properties = null },
            NullOmit);
        Assert.DoesNotContain("properties", json);
    }

    [Fact]
    public void EventPayload_WithProperties_Included()
    {
        var json = JsonSerializer.Serialize(new EventPayload
        {
            Name = "order.placed",
            OccurredAt = "t",
            Properties = new() { ["amount"] = (object?)49.99 },
        });
        Assert.Contains("properties", json);
        Assert.Contains("amount", json);
    }
}
