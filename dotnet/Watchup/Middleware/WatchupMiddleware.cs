// ─────────────────────────────────────────────────────────────────────────────
// Watchup .NET SDK  ·  ASP.NET Core middleware + DI extensions (.NET 8+)
// ─────────────────────────────────────────────────────────────────────────────

using System.Diagnostics;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Options;

namespace Watchup.Middleware;

public static class WatchupServiceExtensions
{
    internal const string HttpClientName = "Watchup";

    /// <summary>
    /// Register a singleton <see cref="WatchupClient"/> (sending through IHttpClientFactory)
    /// and a hosted service that flushes it on application shutdown.
    /// </summary>
    /// <example>
    /// <code>
    /// builder.Services.AddWatchup(o =>
    /// {
    ///     o.ApiKey      = builder.Configuration["Watchup:ApiKey"]!;
    ///     o.Environment = builder.Environment.EnvironmentName;
    /// });
    /// </code>
    /// </example>
    public static IServiceCollection AddWatchup(this IServiceCollection services, Action<WatchupOptions> configure)
    {
        services.Configure(configure);
        return services.AddWatchupCore();
    }

    /// <summary>Register WatchUp from a configuration section (e.g. <c>Configuration.GetSection("Watchup")</c>).</summary>
    public static IServiceCollection AddWatchup(this IServiceCollection services, IConfiguration section)
    {
        services.Configure<WatchupOptions>(section);
        return services.AddWatchupCore();
    }

    private static IServiceCollection AddWatchupCore(this IServiceCollection services)
    {
        services.AddHttpClient(HttpClientName);
        services.AddSingleton(sp => new WatchupClient(
            sp.GetRequiredService<IOptions<WatchupOptions>>().Value,
            sp.GetRequiredService<IHttpClientFactory>().CreateClient(HttpClientName)));
        services.AddHostedService<WatchupHostedService>();
        return services;
    }

    /// <summary>
    /// Add request tracing and exception capture. Call after <c>UseRouting()</c> so route
    /// templates are known, and before endpoints.
    /// </summary>
    public static IApplicationBuilder UseWatchup(this IApplicationBuilder app) => app.UseMiddleware<WatchupMiddleware>();
}

/// <summary>
/// One trace per request (route template, real status, duration), a per-request
/// <see cref="WatchupScope"/>, and exception capture. Exceptions are re-thrown
/// unchanged, so the rest of the pipeline behaves exactly as before.
/// </summary>
public sealed class WatchupMiddleware
{
    private static readonly Regex SafeId = new(@"^[\w\-.:]{1,128}$", RegexOptions.Compiled);
    private readonly RequestDelegate _next;

    public WatchupMiddleware(RequestDelegate next) => _next = next;

    public async Task InvokeAsync(HttpContext ctx, WatchupClient watchup)
    {
        var header = ctx.Request.Headers["X-Request-ID"].ToString();
        using var scope = WatchupScope.Begin(SafeId.IsMatch(header) ? header : ctx.TraceIdentifier);
        if (Activity.Current is { IdFormat: ActivityIdFormat.W3C } activity) scope.TraceId = activity.TraceId.ToString();

        var started = DateTime.UtcNow;
        var watch = Stopwatch.StartNew();
        Exception? caught = null;
        try
        {
            await _next(ctx).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            caught = ex;
            throw;
        }
        finally
        {
            var span = $"{ctx.Request.Method} {RouteOf(ctx)}";
            scope.Route = span;
            var status = caught is not null && !ctx.Response.HasStarted ? 500 : ctx.Response.StatusCode;
            var request = new Dictionary<string, object?>
            {
                ["method"] = ctx.Request.Method,
                ["path"] = Normalise(ctx.Request.Path.Value ?? "/"),
                ["user_agent"] = ctx.Request.Headers.UserAgent.ToString(),
            };

            var opts = watchup.Options;
            if (opts.SampleRate >= 1.0 || ThreadSafeRandom.NextDouble() < opts.SampleRate)
            {
                watchup.RecordTrace(span, "http", watch.Elapsed.TotalMilliseconds, status,
                    status >= 500 ? "err" : status >= 400 ? "warn" : "ok", started, request);
            }

            if (caught is not null)
            {
                watchup.CaptureError(caught, span, "error", new() { ["request"] = request });
            }
            else if (status >= 500 && opts.CaptureServerErrorResponses)
            {
                watchup.CaptureError($"HTTP {status} on {span}", span, "error", new() { ["request"] = request });
            }
        }
    }

    private static string RouteOf(HttpContext ctx)
    {
        if (ctx.GetEndpoint() is RouteEndpoint endpoint && endpoint.RoutePattern.RawText is { } raw)
            return "/" + raw.TrimStart('/');
        return Normalise(ctx.Request.Path.Value ?? "/");
    }

    private static readonly Regex Ids = new(@"/(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{24,64}|\d+)(?=/|$)", RegexOptions.Compiled | RegexOptions.IgnoreCase);

    internal static string Normalise(string path)
    {
        var p = Ids.Replace(path, "/:id");
        return p.Length > 1 ? p.TrimEnd('/') : p;
    }
}

/// <summary>Flushes the client when the host stops.</summary>
internal sealed class WatchupHostedService : IHostedService
{
    private readonly WatchupClient _client;

    public WatchupHostedService(WatchupClient client) => _client = client;

    public Task StartAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    public async Task StopAsync(CancellationToken cancellationToken) => await _client.DisposeAsync().ConfigureAwait(false);
}
