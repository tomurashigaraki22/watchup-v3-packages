// ─────────────────────────────────────────────────────────────────────────────
// Watchup .NET SDK  ·  transport contract (spec/README.md)
//
// Limits, normalization + redaction, truncation and the byte-aware chunker.
// Mirrors @watchupltd/core; VectorTests runs spec/fixtures/vectors.json here.
// ─────────────────────────────────────────────────────────────────────────────

using System.Collections;
using System.Globalization;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace Watchup;

/// <summary>Contract limits shared by every WatchUp SDK.</summary>
public static class WatchupLimits
{
    public const int MaxChunkBytes = 196_608;
    public const int MaxChunkItems = 100;
    public const int BeaconMaxBytes = 61_440;
    public const int MaxQueueItems = 1_000;
    public const int MaxAttempts = 5;
    public const int BaseBackoffMs = 1_000;
    public const int MaxBackoffMs = 30_000;
    public const int MaxRetryAfterMs = 60_000;
    public const int MaxRetryChunks = 50;
    public const int TruncateMessageBytes = 8_192;
    public const int TruncateStackBytes = 32_768;
    public const int TruncateFieldBytes = 8_192;
    public const int TruncateMessageFinalBytes = 1_024;
    public const int TruncateStackFinalBytes = 4_096;
    public const int MaxDepth = 10;
    public const int MaxKeys = 200;
    public const int MaxArray = 200;
    public const string Redacted = "[REDACTED]";
}

internal static class Contract
{
    internal static readonly string[] Kinds = { "errors", "traces", "events" };

    /// <summary>Compact JSON without escaping non-ASCII, so byte counts match the body.</summary>
    internal static readonly JsonSerializerOptions Json = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        ReferenceHandler = ReferenceHandler.IgnoreCycles,
        WriteIndented = false,
    };

    internal static string Serialize(JsonNode? node) => node is null ? "null" : node.ToJsonString(Json);

    internal static int Utf8Length(string s) => Encoding.UTF8.GetByteCount(s);

    // ── UTF-8 truncation ─────────────────────────────────────────────────────

    internal static (string Value, int Removed) TruncateUtf8(string value, int maxBytes)
    {
        var bytes = Encoding.UTF8.GetBytes(value);
        if (bytes.Length <= maxBytes) return (value, 0);
        var cut = maxBytes;
        while (cut > 0 && (bytes[cut] & 0xC0) == 0x80) cut--; // back up to a code-point start
        return (Encoding.UTF8.GetString(bytes, 0, cut), bytes.Length - cut);
    }

    internal static (string Value, bool Truncated) TruncateWithMarker(string value, int maxBytes)
    {
        var (kept, removed) = TruncateUtf8(value, maxBytes);
        return removed == 0 ? (value, false) : ($"{kept}…[truncated {removed.ToString(CultureInfo.InvariantCulture)} bytes]", true);
    }

    // ── Redaction ────────────────────────────────────────────────────────────

    private static readonly HashSet<string> SensitiveKeys = new(StringComparer.Ordinal)
    {
        "authorization", "proxyauthorization", "cookie", "setcookie", "password", "passwd", "pwd",
        "secret", "clientsecret", "apikey", "xapikey", "apisecret", "privatekey", "creditcard",
        "cardnumber", "ccnumber", "cvv", "cvc", "ssn", "sessiontoken",
    };

    internal static string CanonicalKey(string key)
    {
        var sb = new StringBuilder(key.Length);
        foreach (var ch in key.ToLowerInvariant())
            if (ch is not ('-' or '_' or '.' or ' ')) sb.Append(ch);
        return sb.ToString();
    }

    internal static bool IsSensitiveKey(string key, ISet<string>? extra = null)
    {
        var k = CanonicalKey(key);
        if (SensitiveKeys.Contains(k) || (extra?.Contains(k) ?? false) || k.EndsWith("token", StringComparison.Ordinal)) return true;
        return k.Contains("password") || k.Contains("secret") || k.Contains("credential");
    }

    private static readonly Regex AuthScheme = new(@"\b(Bearer|Basic)\s+[A-Za-z0-9\-._~+/]+=*", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex LiveKey = new(@"\bwup_live_[A-Za-z0-9]+", RegexOptions.Compiled);
    private static readonly Regex SensitiveQuery = new(@"([?&](?:token|access_token|password|api_key|apikey|secret|key)=)[^&#\s""']*", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex CardCandidate = new(@"\b(?:\d[ -]?){12,18}\d\b", RegexOptions.Compiled);
    private static readonly Regex FourDigits = new(@"\d{4}", RegexOptions.Compiled);

    private static bool Luhn(string digits)
    {
        int sum = 0;
        bool dbl = false;
        for (int i = digits.Length - 1; i >= 0; i--)
        {
            int d = digits[i] - '0';
            if (dbl) { d *= 2; if (d > 9) d -= 9; }
            sum += d;
            dbl = !dbl;
        }
        return sum % 10 == 0;
    }

    /// <summary>Remove credentials and card numbers embedded in free text.</summary>
    internal static string ScrubString(string value)
    {
        if (value.Length < 8) return value;
        var output = value;
        if (output.IndexOf("bearer", StringComparison.OrdinalIgnoreCase) >= 0 || output.IndexOf("basic", StringComparison.OrdinalIgnoreCase) >= 0)
            output = AuthScheme.Replace(output, m => $"{m.Groups[1].Value} {WatchupLimits.Redacted}");
        if (output.Contains("wup_live_")) output = LiveKey.Replace(output, WatchupLimits.Redacted);
        if (output.Contains('=')) output = SensitiveQuery.Replace(output, m => m.Groups[1].Value + WatchupLimits.Redacted);
        if (FourDigits.IsMatch(output))
        {
            output = CardCandidate.Replace(output, m =>
            {
                var digits = m.Value.Replace(" ", "").Replace("-", "");
                return digits.Length is >= 13 and <= 19 && Luhn(digits) ? WatchupLimits.Redacted : m.Value;
            });
        }
        return output;
    }

    // ── Normalization ────────────────────────────────────────────────────────

    /// <summary>Convert an arbitrary value into redacted, bounded JSON. Never throws.</summary>
    internal static JsonNode? Normalize(object? value, ISet<string>? extraKeys = null)
    {
        try
        {
            return Walk(ToNode(value), 0, extraKeys);
        }
        catch
        {
            return JsonValue.Create("[Unserializable]");
        }
    }

    private static JsonNode? ToNode(object? value)
    {
        switch (value)
        {
            case null: return null;
            case JsonNode node: return node.DeepClone();
            case string s: return JsonValue.Create(s);
            case bool b: return JsonValue.Create(b);
            case double d: return double.IsNaN(d) || double.IsInfinity(d) ? null : JsonValue.Create(d);
            case float f: return float.IsNaN(f) || float.IsInfinity(f) ? null : JsonValue.Create(f);
            case byte[] bytes: return JsonValue.Create($"[Binary {bytes.Length} bytes]");
            case Exception ex:
                var obj = new JsonObject { ["name"] = ex.GetType().Name, ["message"] = ex.Message };
                if (ex.StackTrace is not null) obj["stack"] = ex.ToString();
                return obj;
            case IDictionary dict:
                var result = new JsonObject();
                foreach (DictionaryEntry entry in dict)
                {
                    var key = Convert.ToString(entry.Key, CultureInfo.InvariantCulture) ?? "";
                    if (!result.ContainsKey(key)) result[key] = ToNode(entry.Value);
                }
                return result;
            case IEnumerable list when value is not string:
                var array = new JsonArray();
                foreach (var item in list) array.Add(ToNode(item));
                return array;
            case Delegate:
                return null;
        }
        return JsonSerializer.SerializeToNode(value, value.GetType(), Json);
    }

    private static JsonNode? Walk(JsonNode? node, int depth, ISet<string>? extra)
    {
        switch (node)
        {
            case null:
                return null;
            case JsonValue v:
                return v.TryGetValue<string>(out var s) ? JsonValue.Create(ScrubString(s)) : v.DeepClone();
            case JsonObject when depth >= WatchupLimits.MaxDepth:
            case JsonArray when depth >= WatchupLimits.MaxDepth:
                return JsonValue.Create("[MaxDepth]");
            case JsonObject obj:
            {
                var output = new JsonObject();
                int kept = 0, total = obj.Count;
                foreach (var (key, child) in obj)
                {
                    if (kept >= WatchupLimits.MaxKeys)
                    {
                        output["_watchup_dropped_keys"] = total - kept;
                        break;
                    }
                    output[key] = IsSensitiveKey(key, extra) ? JsonValue.Create(WatchupLimits.Redacted) : Walk(child, depth + 1, extra);
                    kept++;
                }
                return output;
            }
            case JsonArray arr:
            {
                var output = new JsonArray();
                for (int i = 0; i < arr.Count && i < WatchupLimits.MaxArray; i++) output.Add(Walk(arr[i], depth + 1, extra));
                if (arr.Count > WatchupLimits.MaxArray) output.Add($"[… {arr.Count - WatchupLimits.MaxArray} more]");
                return output;
            }
        }
        return node.DeepClone();
    }

    // ── Truncation (spec §5) ─────────────────────────────────────────────────

    private static readonly string[] Containers = { "context", "meta", "properties" };

    private static bool CapStrings(JsonNode? node, int maxBytes, out JsonNode? result)
    {
        switch (node)
        {
            case JsonValue v when v.TryGetValue<string>(out var s):
                var (value, truncated) = TruncateWithMarker(s, maxBytes);
                result = JsonValue.Create(value);
                return truncated;
            case JsonArray arr:
            {
                var changed = false;
                var output = new JsonArray();
                foreach (var child in arr)
                {
                    changed |= CapStrings(child, maxBytes, out var r);
                    output.Add(r);
                }
                result = output;
                return changed;
            }
            case JsonObject obj:
            {
                var changed = false;
                var output = new JsonObject();
                foreach (var (key, child) in obj)
                {
                    changed |= CapStrings(child, maxBytes, out var r);
                    output[key] = r;
                }
                result = output;
                return changed;
            }
        }
        result = node?.DeepClone();
        return false;
    }

    private static bool CapField(JsonObject item, string field, int maxBytes)
    {
        if (item[field] is JsonValue v && v.TryGetValue<string>(out var s))
        {
            var (value, truncated) = TruncateWithMarker(s, maxBytes);
            if (truncated) item[field] = value;
            return truncated;
        }
        return false;
    }

    internal readonly record struct FitResult(string Json, bool Truncated, bool Oversized);

    internal static FitResult FitItem(JsonObject item, int budget)
    {
        var json = Serialize(item);
        if (Utf8Length(json) <= budget) return new FitResult(json, false, false);

        var output = (JsonObject)item.DeepClone();
        var truncated = false;
        truncated |= CapField(output, "message", WatchupLimits.TruncateMessageBytes);
        truncated |= CapField(output, "stack", WatchupLimits.TruncateStackBytes);
        foreach (var key in Containers)
        {
            if (!output.ContainsKey(key)) continue;
            if (CapStrings(output[key], WatchupLimits.TruncateFieldBytes, out var capped))
            {
                output[key] = capped;
                truncated = true;
            }
        }
        output["_watchup_truncated"] = true;
        json = Serialize(output);

        if (Utf8Length(json) > budget)
        {
            foreach (var key in Containers)
            {
                if (!output.ContainsKey(key)) continue;
                output[key] = new JsonObject { ["_watchup_truncated"] = true, ["original_bytes"] = Utf8Length(Serialize(item[key])) };
                truncated = true;
            }
            json = Serialize(output);
        }
        if (Utf8Length(json) > budget)
        {
            truncated |= CapField(output, "message", WatchupLimits.TruncateMessageFinalBytes);
            truncated |= CapField(output, "stack", WatchupLimits.TruncateStackFinalBytes);
            json = Serialize(output);
        }
        if (!truncated)
        {
            output.Remove("_watchup_truncated");
            json = Serialize(output);
        }
        return new FitResult(json, truncated, Utf8Length(json) > budget);
    }

    // ── Chunker (spec §4) ────────────────────────────────────────────────────

    internal sealed record PreparedItem(string Kind, string Json, int Bytes);

    private static readonly string[] Prefix = { "{\"errors\":[", "],\"traces\":[", "],\"events\":[", "]," };
    private static readonly int FixedBytes = string.Concat(Prefix).Length;

    private static string Tail(JsonObject envelopeBase, string key, string sentAt)
    {
        var tail = (JsonObject)envelopeBase.DeepClone();
        tail["idempotency_key"] = key;
        tail["sent_at"] = sentAt;
        return Serialize(tail).Substring(1);
    }

    internal static int EnvelopeOverhead(JsonObject envelopeBase) =>
        FixedBytes + Utf8Length(Tail(envelopeBase, $"wu_{new string('0', 36)}_999999", "2026-01-01T00:00:00.000Z"));

    internal static List<Chunk> BuildChunks(
        IReadOnlyDictionary<string, List<PreparedItem>> pending,
        JsonObject envelopeBase,
        int maxBytes,
        int maxItems,
        string batchId,
        string sentAt)
    {
        var overhead = EnvelopeOverhead(envelopeBase);
        var chunks = new List<Chunk>();
        var groups = Kinds.ToDictionary(k => k, _ => new List<string>());
        int size = overhead, count = 0;

        void Close()
        {
            if (count == 0) return;
            var key = $"wu_{batchId}_{chunks.Count.ToString(CultureInfo.InvariantCulture)}";
            var body = Prefix[0] + string.Join(",", groups["errors"]) +
                       Prefix[1] + string.Join(",", groups["traces"]) +
                       Prefix[2] + string.Join(",", groups["events"]) +
                       Prefix[3] + Tail(envelopeBase, key, sentAt);
            chunks.Add(new Chunk(key, body, Utf8Length(body), Kinds.ToDictionary(k => k, k => groups[k].Count)));
            groups = Kinds.ToDictionary(k => k, _ => new List<string>());
            size = overhead;
            count = 0;
        }

        foreach (var kind in Kinds)
        {
            if (!pending.TryGetValue(kind, out var items)) continue;
            foreach (var item in items)
            {
                var added = item.Bytes + (groups[kind].Count > 0 ? 1 : 0);
                if (count > 0 && (size + added > maxBytes || count + 1 > maxItems))
                {
                    Close();
                    added = item.Bytes;
                }
                groups[kind].Add(item.Json);
                size += added;
                count++;
                if (size > maxBytes) Close();
            }
        }
        Close();
        return chunks;
    }

    internal static bool IsRetryableStatus(int status) => status is 408 or 425 or 429 || status >= 500;
}

/// <summary>One request body, ready to send or retry with the same idempotency key.</summary>
public sealed class Chunk
{
    internal Chunk(string key, string body, int bytes, Dictionary<string, int> counts)
    {
        IdempotencyKey = key;
        Body = body;
        Bytes = bytes;
        Counts = counts;
    }

    public string IdempotencyKey { get; }
    public string Body { get; }
    public int Bytes { get; }
    public IReadOnlyDictionary<string, int> Counts { get; }
    public int Attempts { get; internal set; }
    internal DateTimeOffset NextAttemptAt { get; set; }
    public int Items => Counts.Values.Sum();
}
