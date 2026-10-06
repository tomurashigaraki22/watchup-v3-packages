// Contract workload for the .NET SDK.
using Watchup;

await using var watchup = new WatchupClient(new WatchupOptions
{
    ApiKey = "wup_live_test",
    BaseUrl = Environment.GetEnvironmentVariable("WATCHUP_BASE_URL")!,
    Environment = "contract",
    FlushInterval = TimeSpan.FromHours(1),
    ShutdownTimeout = TimeSpan.FromSeconds(8),
});
watchup.SetUser(new WatchupUser("contract-user"));
watchup.CaptureError(new InvalidOperationException(new string('x', 256_000)), context: new()
{
    ["headers"] = new Dictionary<string, object?> { ["Authorization"] = "Bearer secret-token-123" },
    ["password"] = "hunter2",
});
for (var i = 0; i < 3; i++) watchup.Track($"unicode-{i}", new() { ["text"] = new string('é', 60_000) });
for (var i = 0; i < 150; i++) using (watchup.StartTrace($"contract-trace-{i}")) { }
await watchup.FlushAsync();
