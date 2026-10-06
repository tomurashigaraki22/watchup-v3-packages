using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Watchup.Tests;

/// <summary>Shared contract vectors (spec/fixtures/vectors.json).</summary>
public class VectorTests
{
    private static readonly JsonObject Vectors = LoadVectors();
    private static readonly string[] Kinds = { "errors", "traces", "events" };

    private static JsonObject LoadVectors()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "spec", "fixtures", "vectors.json"))) dir = dir.Parent;
        if (dir is null) throw new InvalidOperationException("spec/fixtures/vectors.json not found above the test directory");
        return JsonNode.Parse(File.ReadAllText(Path.Combine(dir.FullName, "spec", "fixtures", "vectors.json")))!.AsObject();
    }

    public static IEnumerable<object[]> Chunking() => Vectors["chunking"]!.AsArray().Select(v => new object[] { v!["name"]!.GetValue<string>() });
    public static IEnumerable<object[]> Delivery() => Vectors["delivery"]!.AsArray().Select(v => new object[] { v!["name"]!.GetValue<string>() });

    private static JsonObject Find(string section, string name) =>
        Vectors[section]!.AsArray().First(v => v!["name"]!.GetValue<string>() == name)!.AsObject();

    private static JsonNode? Expand(JsonNode? node, int i) => node switch
    {
        JsonValue v when v.TryGetValue<string>(out var s) => JsonValue.Create(s.Replace("{i}", i.ToString())),
        JsonObject o when o.ContainsKey("$repeat") => JsonValue.Create(string.Concat(Enumerable.Repeat(o["$repeat"]!.GetValue<string>(), o["times"]!.GetValue<int>()))),
        JsonObject o when o.ContainsKey("$object") => ExpandObject(o["$object"]!.AsObject(), i),
        JsonObject o => new JsonObject(o.Select(kv => KeyValuePair.Create(kv.Key, Expand(kv.Value, i)))),
        JsonArray a => new JsonArray(a.Select(x => Expand(x, i)).ToArray()),
        _ => node?.DeepClone(),
    };

    private static JsonObject ExpandObject(JsonObject spec, int i)
    {
        var o = new JsonObject();
        for (var j = 0; j < spec["count"]!.GetValue<int>(); j++) o[spec["key"]!.GetValue<string>().Replace("{j}", j.ToString())] = Expand(spec["value"], i);
        return o;
    }

    private static Dictionary<string, List<JsonObject>> Input(JsonObject vector)
    {
        var output = Kinds.ToDictionary(k => k, _ => new List<JsonObject>());
        foreach (var kind in Kinds)
        {
            if (vector["input"]?[kind] is JsonArray list) output[kind].AddRange(list.Select(x => x!.AsObject().DeepClone().AsObject()));
            if (vector["generate"]?[kind] is JsonObject gen)
                for (var i = 0; i < gen["count"]!.GetValue<int>(); i++) output[kind].Add(Expand(gen["template"], i)!.AsObject());
        }
        return output;
    }

    private static string Label(string kind, JsonNode item) =>
        $"{kind}:{item[kind == "errors" ? "message" : kind == "traces" ? "span" : "name"]!.GetValue<string>()}";

    private sealed class Harness
    {
        public readonly List<Chunk> Sent = new();
        public readonly List<(string Key, string Body)> Attempts = new();
        public readonly List<string> Diagnostics = new();
        private readonly Queue<int>? _script;
        private readonly string? _mode;
        public readonly DeliveryQueue Queue;

        public Harness(JsonNode? responses, int maxItems = WatchupLimits.MaxChunkItems)
        {
            if (responses is JsonArray a) _script = new Queue<int>(a.Select(x => x!.GetValue<int>()));
            else _mode = responses?.GetValue<string>();
            var sdk = Vectors["sdk"]!.DeepClone();
            Queue = new DeliveryQueue(
                Send,
                () => new JsonObject { ["sdk"] = sdk.DeepClone(), ["environment"] = "test" },
                maxItems, 10_000, null, d => { lock (Diagnostics) Diagnostics.Add(d.Type); }, autoFlush: false,
                now: () => DateTimeOffset.FromUnixTimeSeconds(1_700_000_000), random: () => 0);
        }

        private Task<SendResult> Send(Chunk chunk, CancellationToken _)
        {
            lock (Attempts)
            {
                Attempts.Add((chunk.IdempotencyKey, chunk.Body));
                var status = _script is not null ? (_script.Count > 0 ? _script.Dequeue() : 200) : _mode == "always_503" ? 503 : 200;
                if (status < 300)
                {
                    Sent.Add(chunk);
                    return Task.FromResult(new SendResult(true, status));
                }
                return Task.FromResult(new SendResult(false, status));
            }
        }
    }

    [Fact]
    public void Constants_MatchSpec()
    {
        foreach (var (key, value) in Vectors["constants"]!.AsObject())
        {
            var field = typeof(WatchupLimits).GetField(string.Concat(key.Split('_').Select(p => p[0] + p.Substring(1).ToLowerInvariant())));
            Assert.True(field is not null, key);
            Assert.Equal(value!.ToJsonString(), JsonSerializer.Serialize(field!.GetValue(null)));
        }
    }

    [Theory]
    [MemberData(nameof(Chunking))]
    public async Task ChunkingVector(string name)
    {
        var vector = Find("chunking", name);
        var h = new Harness("always_200", vector["options"]?["max_items"]?.GetValue<int>() ?? WatchupLimits.MaxChunkItems);
        foreach (var (kind, items) in Input(vector)) foreach (var item in items) h.Queue.Enqueue(kind, item);
        await h.Queue.FlushAsync();
        var expect = vector["expect"]!.AsObject();

        Assert.Equal(expect["chunks"]!.GetValue<int>(), h.Sent.Count);
        var order = new List<(string Kind, JsonNode Item)>();
        var sequence = new List<List<string>>();
        foreach (var chunk in h.Sent)
        {
            Assert.Equal(Encoding.UTF8.GetByteCount(chunk.Body), chunk.Bytes);
            Assert.True(chunk.Bytes <= WatchupLimits.MaxChunkBytes);
            var body = JsonNode.Parse(chunk.Body)!;
            Assert.Matches(@"^wu_[A-Za-z0-9-]+_\d+$", body["idempotency_key"]!.GetValue<string>());
            var labels = new List<string>();
            foreach (var kind in Kinds)
                foreach (var item in body[kind]!.AsArray())
                {
                    order.Add((kind, item!));
                    labels.Add(Label(kind, item!));
                }
            Assert.True(labels.Count <= WatchupLimits.MaxChunkItems);
            sequence.Add(labels);
        }
        if (expect["items_per_chunk"] is JsonArray perChunk)
            Assert.Equal(perChunk.Select(x => x!.GetValue<int>()), h.Sent.Select(c => c.Items));
        if (expect["sequence"] is JsonArray seq)
            Assert.Equal(seq.Select(r => r!.AsArray().Select(x => x!.GetValue<string>()).ToList()).ToList(), sequence);
        if (expect["truncated"] is JsonArray truncated)
            Assert.Equal(truncated.Select(x => x!.GetValue<bool>()), order.Select(o => o.Item["_watchup_truncated"]?.GetValue<bool>() == true));
        if (expect["max_message_bytes"] is JsonValue max)
        {
            foreach (var (_, item) in order)
            {
                var message = item["message"]!.GetValue<string>();
                Assert.Matches(@"…\[truncated \d+ bytes\]$", message);
                Assert.True(Encoding.UTF8.GetByteCount(Regex.Replace(message, @"…\[truncated \d+ bytes\]$", "")) <= max.GetValue<int>());
                Assert.DoesNotContain('�', message);
            }
        }
        if (expect["context_marker"]?.GetValue<bool>() == true)
        {
            var ctx = order[0].Item["context"]!;
            Assert.True(ctx["_watchup_truncated"]!.GetValue<bool>());
            Assert.True(ctx["original_bytes"]!.GetValue<int>() > WatchupLimits.MaxChunkBytes);
        }
        foreach (var d in expect["diagnostics"]?.AsArray() ?? new JsonArray()) Assert.Contains(d!.GetValue<string>(), h.Diagnostics);
    }

    [Fact]
    public void RedactionVectors()
    {
        foreach (var vector in Vectors["redaction"]!.AsArray())
        {
            var got = Contract.Normalize(vector!["input"]);
            Assert.True(JsonNode.DeepEquals(vector["expected"], got), $"{vector["name"]}: {got?.ToJsonString()}");
        }
    }

    [Theory]
    [MemberData(nameof(Delivery))]
    public async Task DeliveryVector(string name)
    {
        var vector = Find("delivery", name);
        var h = new Harness(vector["responses"]);
        var n = 0;
        foreach (var kind in Kinds)
        {
            var count = vector["items"]![kind]?.GetValue<int>() ?? 0;
            for (var i = 0; i < count; i++)
            {
                var id = $"{kind}-{n++}";
                h.Queue.Enqueue(kind, kind switch
                {
                    "errors" => new Dictionary<string, object?> { ["message"] = id, ["level"] = "error", ["timestamp"] = "t" },
                    "traces" => new Dictionary<string, object?> { ["span"] = id, ["ms"] = 1, ["status_code"] = 200, ["status"] = "ok", ["timestamp"] = "t" },
                    _ => new Dictionary<string, object?> { ["name"] = id, ["occurred_at"] = "t" },
                });
            }
        }

        if (name.StartsWith("shutdown", StringComparison.Ordinal))
            await h.Queue.ShutdownAsync(name == "shutdown_reports_undelivered" ? TimeSpan.Zero : TimeSpan.FromSeconds(5));
        else if (vector["concurrent_flushes"] is JsonValue c)
            await Task.WhenAll(Enumerable.Range(0, c.GetValue<int>()).Select(_ => Task.Run(() => h.Queue.FlushAsync())));
        else
        {
            await h.Queue.FlushAsync();
            for (var i = 0; i < 10 && h.Queue.RetryingCount > 0; i++) await h.Queue.FlushAsync(force: true);
        }

        var expect = vector["expect"]!.AsObject();
        var delivered = h.Sent.SelectMany(ch => Kinds.SelectMany(k => JsonNode.Parse(ch.Body)![k]!.AsArray().Select(it => Label(k, it!)))).ToList();
        Assert.Equal(expect["delivered_items"]!.GetValue<int>(), delivered.Count);
        if (expect["unique_items"] is JsonValue u) Assert.Equal(u.GetValue<int>(), delivered.Distinct().Count());
        if (expect["attempts"] is JsonValue a) Assert.Equal(a.GetValue<int>(), h.Attempts.Count);
        if (expect["same_idempotency_key"]?.GetValue<bool>() == true) Assert.Single(h.Attempts.Select(x => x.Key).Distinct());
        if (expect["retried_key_equals_first_key"]?.GetValue<bool>() == true) Assert.Equal(h.Attempts[0].Key, h.Attempts[2].Key);
        if (expect["first_pass_keys_distinct"]?.GetValue<bool>() == true) Assert.NotEqual(h.Attempts[0].Key, h.Attempts[1].Key);
        if (expect["pending_after_shutdown"] is JsonValue p) Assert.Equal(p.GetValue<int>(), h.Queue.PendingCount + h.Queue.RetryingCount);
        foreach (var d in expect["diagnostics"]?.AsArray() ?? new JsonArray()) Assert.Contains(d!.GetValue<string>(), h.Diagnostics);
        foreach (var group in h.Attempts.GroupBy(x => x.Key)) Assert.Single(group.Select(x => x.Body).Distinct());
    }
}
