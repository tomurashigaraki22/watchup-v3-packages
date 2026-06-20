// ─────────────────────────────────────────────────────────────────────────────
// Watchup .NET SDK  ·  payload types
// ─────────────────────────────────────────────────────────────────────────────

using System.Text.Json.Serialization;

namespace Watchup;

/// <summary>A single captured request or operation trace.</summary>
public sealed class TracePayload
{
    /// <summary>Human-readable span name, e.g. <c>"GET /api/users/{id}"</c>.</summary>
    [JsonPropertyName("span")]
    public string Span { get; set; } = string.Empty;

    /// <summary>End-to-end duration in milliseconds.</summary>
    [JsonPropertyName("ms")]
    public long Ms { get; set; }

    /// <summary>HTTP status code, or a synthetic code for non-HTTP spans (200/400/500).</summary>
    [JsonPropertyName("status_code")]
    public int StatusCode { get; set; }

    /// <summary>Derived health status.</summary>
    [JsonPropertyName("status")]
    public string Status { get; set; } = "ok"; // "ok" | "warn" | "err"

    /// <summary>ISO-8601 timestamp of when the operation finished.</summary>
    [JsonPropertyName("timestamp")]
    public string Timestamp { get; set; } = string.Empty;

    [JsonPropertyName("environment")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Environment { get; set; }

    [JsonPropertyName("release")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Release { get; set; }

    /// <summary>Arbitrary extra metadata (user ID, tenant, feature flag…).</summary>
    [JsonPropertyName("meta")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public Dictionary<string, object?>? Meta { get; set; }
}

/// <summary>A captured error or exception.</summary>
public sealed class ErrorPayload
{
    /// <summary>Error message string.</summary>
    [JsonPropertyName("message")]
    public string Message { get; set; } = string.Empty;

    /// <summary>Severity level.</summary>
    [JsonPropertyName("level")]
    public string Level { get; set; } = "error"; // "debug"|"info"|"warning"|"error"|"fatal"

    /// <summary>Route that produced the error, e.g. <c>"POST /api/orders"</c>.</summary>
    [JsonPropertyName("route")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Route { get; set; }

    /// <summary>Full stack trace.</summary>
    [JsonPropertyName("stack")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Stack { get; set; }

    /// <summary>Arbitrary structured context (request headers, user ID…).</summary>
    [JsonPropertyName("context")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public Dictionary<string, object?>? Context { get; set; }

    /// <summary>ISO-8601 timestamp.</summary>
    [JsonPropertyName("timestamp")]
    public string Timestamp { get; set; } = string.Empty;

    [JsonPropertyName("environment")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Environment { get; set; }

    [JsonPropertyName("release")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Release { get; set; }
}

/// <summary>A custom analytics event.</summary>
public sealed class EventPayload
{
    /// <summary>Event name, e.g. <c>"user.signed_up"</c>.</summary>
    [JsonPropertyName("name")]
    public string Name { get; set; } = string.Empty;

    /// <summary>Arbitrary event properties. Must be JSON-serialisable.</summary>
    [JsonPropertyName("properties")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public Dictionary<string, object?>? Properties { get; set; }

    /// <summary>ISO-8601 timestamp of when the event occurred.</summary>
    [JsonPropertyName("occurred_at")]
    public string OccurredAt { get; set; } = string.Empty;
}

/// <summary>Shape of a single HTTP batch request body sent to the ingest endpoint.</summary>
internal sealed class IngestBatch
{
    [JsonPropertyName("traces")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public List<TracePayload>? Traces { get; set; }

    [JsonPropertyName("errors")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public List<ErrorPayload>? Errors { get; set; }

    [JsonPropertyName("events")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public List<EventPayload>? Events { get; set; }
}
