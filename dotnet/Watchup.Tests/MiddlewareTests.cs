using System.Net;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Watchup.Middleware;

namespace Watchup.Tests;

/// <summary>Captures ingest requests instead of sending them.</summary>
public sealed class CaptureHandler : HttpMessageHandler
{
    private readonly object _lock = new();
    public List<JsonNode> Bodies { get; } = new();
    public List<HttpRequestMessage> Requests { get; } = new();
    public Queue<HttpStatusCode> Statuses { get; } = new();

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var body = await request.Content!.ReadAsStringAsync(cancellationToken);
        lock (_lock)
        {
            var status = Statuses.Count > 0 ? Statuses.Dequeue() : HttpStatusCode.Created;
            Requests.Add(request);
            if ((int)status < 300) Bodies.Add(JsonNode.Parse(body)!);
            return new HttpResponseMessage(status) { Content = new StringContent("{\"ok\":true}") };
        }
    }

    public List<JsonNode> Items(string kind)
    {
        lock (_lock) return Bodies.SelectMany(b => b[kind]!.AsArray()).Select(x => x!).ToList();
    }
}

public class MiddlewareTests
{
    private static async Task<(IHost Host, CaptureHandler Capture)> StartAsync(Action<WebApplication> map, Action<WatchupOptions>? configure = null, Action<WebApplication>? outer = null)
    {
        var capture = new CaptureHandler();
        var builder = WebApplication.CreateBuilder();
        builder.WebHost.UseTestServer();
        builder.Services.AddWatchup(o =>
        {
            o.ApiKey = "wup_live_test";
            o.FlushInterval = TimeSpan.FromHours(1);
            o.Service = "api";
            configure?.Invoke(o);
        });
        builder.Services.AddHttpClient(WatchupServiceExtensions.HttpClientName).ConfigurePrimaryHttpMessageHandler(() => capture);
        var app = builder.Build();
        outer?.Invoke(app);
        app.UseRouting();
        app.UseWatchup();
        map(app);
        await app.StartAsync();
        return (app, capture);
    }

    [Fact]
    public async Task RecordsRouteTemplateStatusAndPreservesResponse()
    {
        var (host, capture) = await StartAsync(app =>
            app.MapGet("/orders/{id:int}", (int id, HttpContext ctx) =>
            {
                ctx.RequestServices.GetRequiredService<WatchupClient>().SetUser(new WatchupUser($"user-{id}"));
                ctx.Response.Headers["X-Kept"] = "yes";
                return Results.Json(new { id }, statusCode: 203);
            }));
        var client = host.GetTestClient();
        var request = new HttpRequestMessage(HttpMethod.Get, "/orders/42");
        request.Headers.Add("X-Request-ID", "req-42");
        var response = await client.SendAsync(request);
        Assert.Equal((HttpStatusCode)203, response.StatusCode);
        Assert.Equal("yes", response.Headers.GetValues("X-Kept").Single());

        await host.Services.GetRequiredService<WatchupClient>().FlushAsync();
        var trace = capture.Items("traces").Single();
        Assert.Equal("GET /orders/{id:int}", trace["span"]!.GetValue<string>());
        Assert.Equal(203, trace["status_code"]!.GetValue<int>());
        Assert.Equal("req-42", trace["meta"]!["request_id"]!.GetValue<string>());
        Assert.Equal("user-42", trace["user"]!["id"]!.GetValue<string>());
        var headers = capture.Requests[0].Headers;
        Assert.StartsWith("wu_", headers.GetValues("Idempotency-Key").Single());
        await host.StopAsync();
    }

    [Fact]
    public async Task CapturesExceptionsOnceAndRethrows()
    {
        var (host, capture) = await StartAsync(
            app => app.MapGet("/boom", (Func<string>)(() => throw new InvalidOperationException("boom: Bearer abc.def"))),
            outer: app => app.Use(async (ctx, next) =>
            {
                // The app's own exception handling (outside UseWatchup) still sees the exception.
                try { await next(ctx); }
                catch (InvalidOperationException) { ctx.Response.StatusCode = 418; }
            }));
        var response = await host.GetTestClient().GetAsync("/boom");
        Assert.Equal((HttpStatusCode)418, response.StatusCode);
        await host.Services.GetRequiredService<WatchupClient>().FlushAsync();
        var error = Assert.Single(capture.Items("errors"));
        Assert.Equal("System.InvalidOperationException", error["type"]!.GetValue<string>());
        Assert.Equal("boom: Bearer [REDACTED]", error["message"]!.GetValue<string>());
        Assert.Equal("GET /boom", error["route"]!.GetValue<string>());
        await host.StopAsync();
    }

    [Fact]
    public async Task ConcurrentRequestsDoNotShareUsers()
    {
        var (host, capture) = await StartAsync(app =>
            app.MapGet("/u/{name}", async (string name, WatchupClient watchup) =>
            {
                watchup.SetUser(new WatchupUser(name));
                await Task.Delay(name == "slow" ? 30 : 0);
                watchup.Track("seen", new() { ["expected"] = name });
                return "ok";
            }));
        var client = host.GetTestClient();
        await Task.WhenAll(client.GetAsync("/u/slow"), client.GetAsync("/u/fast"));
        await host.Services.GetRequiredService<WatchupClient>().FlushAsync();
        foreach (var e in capture.Items("events"))
            Assert.Equal(e["properties"]!["expected"]!.GetValue<string>(), e["properties"]!["user"]!["id"]!.GetValue<string>());
        await host.StopAsync();
    }

    [Fact]
    public async Task HostShutdownFlushesQueuedItems()
    {
        var (host, capture) = await StartAsync(_ => { });
        host.Services.GetRequiredService<WatchupClient>().Track("queued-before-stop");
        await host.StopAsync();
        Assert.Equal("queued-before-stop", capture.Items("events").Single()["name"]!.GetValue<string>());
    }

    [Fact]
    public async Task RetriesWithSameIdempotencyKey()
    {
        var capture = new CaptureHandler();
        capture.Statuses.Enqueue(HttpStatusCode.ServiceUnavailable);
        await using var client = new WatchupClient(new WatchupOptions { ApiKey = "k", FlushInterval = TimeSpan.FromHours(1) }, new HttpClient(capture));
        client.Track("retry-me");
        await client.FlushAsync();
        await client.Queue.FlushAsync(force: true);
        var keys = capture.Requests.Select(r => r.Headers.GetValues("Idempotency-Key").Single()).ToList();
        Assert.Equal(2, keys.Count);
        Assert.Equal(keys[0], keys[1]);
        Assert.Single(capture.Items("events"));
    }

    [Fact]
    public async Task TraceQuerySanitizesSql()
    {
        var capture = new CaptureHandler();
        await using var client = new WatchupClient(new WatchupOptions { ApiKey = "k", FlushInterval = TimeSpan.FromHours(1) }, new HttpClient(capture));
        var rows = await client.TraceQueryAsync("SELECT * FROM users WHERE email = 'a@b.c' AND id = 7", () => Task.FromResult(3), "postgresql");
        Assert.Equal(3, rows);
        await Assert.ThrowsAsync<TimeoutException>(() => client.TraceQueryAsync<int>("DELETE FROM x WHERE id = @id", () => throw new TimeoutException()));
        await client.FlushAsync();
        var traces = capture.Items("traces");
        Assert.Equal("SELECT * FROM users WHERE email = ? AND id = ?", traces[0]["span"]!.GetValue<string>());
        Assert.Equal("db", traces[0]["type"]!.GetValue<string>());
        Assert.Equal("DELETE FROM x WHERE id = @id", traces[1]["span"]!.GetValue<string>());
        Assert.Equal("err", traces[1]["status"]!.GetValue<string>());
    }

    [Fact]
    public async Task DisposeReportsUndeliveredItems()
    {
        var diagnostics = new List<string>();
        var capture = new CaptureHandler();
        for (var i = 0; i < 10; i++) capture.Statuses.Enqueue(HttpStatusCode.ServiceUnavailable);
        var client = new WatchupClient(new WatchupOptions
        {
            ApiKey = "k",
            FlushInterval = TimeSpan.FromHours(1),
            ShutdownTimeout = TimeSpan.Zero,
            OnDiagnostic = d => { lock (diagnostics) diagnostics.Add(d.Type); },
        }, new HttpClient(capture));
        client.Track("lost");
        await client.DisposeAsync();
        Assert.Contains("undelivered_on_shutdown", diagnostics);
    }
}
