// ─────────────────────────────────────────────────────────────────────────────
// Watchup .NET SDK  ·  ASP.NET Core Middleware + DI extensions
// ─────────────────────────────────────────────────────────────────────────────

using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

namespace Watchup.Middleware;

// ─────────────────────────────────────────────────────────────────────────────
// DI extensions
// ─────────────────────────────────────────────────────────────────────────────

public static class WatchupServiceExtensions
{
    /// <summary>
    /// Register Watchup and start the background flush timer.
    /// </summary>
    /// <example>
    /// <code>
    /// builder.Services.AddWatchup(o =>
    /// {
    ///     o.ApiKey      = builder.Configuration["Watchup:ApiKey"]!;
    ///     o.Environment = builder.Environment.EnvironmentName;
    ///     o.Release     = "1.2.3";
    /// });
    /// </code>
    /// </example>
    public static IServiceCollection AddWatchup(
        this IServiceCollection services,
        Action<WatchupOptions>  configure)
    {
        var opts = new WatchupOptions();
        configure(opts);

        var client = new WatchupClient(opts);
        services.AddSingleton(client);

        // Wire the client into the hosted service lifecycle so it flushes on shutdown.
        services.AddSingleton<IHostedService>(sp =>
            new WatchupHostedService(sp.GetRequiredService<WatchupClient>()));

        return services;
    }

    /// <summary>
    /// Add the Watchup request-tracing middleware to the pipeline.
    /// Call this after <c>UseRouting()</c> so route templates are resolved.
    /// </summary>
    /// <example>
    /// <code>
    /// app.UseRouting();
    /// app.UseWatchup();   // ← here
    /// app.MapControllers();
    /// </code>
    /// </example>
    public static IApplicationBuilder UseWatchup(this IApplicationBuilder app)
        => app.UseMiddleware<WatchupMiddleware>();
}

// ─────────────────────────────────────────────────────────────────────────────
// Request middleware
// ─────────────────────────────────────────────────────────────────────────────

/// <summary>
/// Captures HTTP request traces and forwards unhandled exceptions as errors.
/// </summary>
public sealed class WatchupMiddleware
{
    private readonly RequestDelegate _next;

    public WatchupMiddleware(RequestDelegate next) => _next = next;

    public async Task InvokeAsync(HttpContext ctx, WatchupClient watchup)
    {
        var start = DateTimeOffset.UtcNow;
        Exception? caught = null;

        try
        {
            await _next(ctx);
        }
        catch (Exception ex)
        {
            caught = ex;
            throw;
        }
        finally
        {
            var ms = (long)(DateTimeOffset.UtcNow - start).TotalMilliseconds;

            // Prefer the matched route template over raw path to avoid high-cardinality explosion.
            string? routeTemplate = null;
            var endpoint = ctx.Features.Get<IEndpointFeature>()?.Endpoint;
            if (endpoint is RouteEndpoint re)
                routeTemplate = re.RoutePattern.RawText;

            var span = routeTemplate is not null
                ? $"{ctx.Request.Method} /{routeTemplate.TrimStart('/')}"
                : $"{ctx.Request.Method} {ctx.Request.Path.Value}";

            var statusCode = ctx.Response.StatusCode;
            var status = statusCode >= 500 ? "err"
                       : statusCode >= 400 ? "warn"
                       : "ok";

            var opts = watchup.Options;
            var sampleRate = opts.SampleRate;
#pragma warning disable CA5394
            if (sampleRate >= 1.0 || new Random().NextDouble() < sampleRate)
#pragma warning restore CA5394
            {
                watchup.SendTrace(new TracePayload
                {
                    Span       = span,
                    Ms         = ms,
                    StatusCode = statusCode,
                    Status     = status,
                    Timestamp  = start.UtcDateTime.ToString("O"),
                    Environment = opts?.Environment,
                    Release     = opts?.Release,
                });
            }

            if (caught is not null)
            {
                watchup.CaptureError(caught, route: span, level: "error");
            }
            else if (statusCode >= 500)
            {
                watchup.CaptureError(
                    $"HTTP {statusCode} on {span}",
                    route: span,
                    level: "error");
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Hosted service — ties WatchupClient to the app lifetime
// ─────────────────────────────────────────────────────────────────────────────

internal sealed class WatchupHostedService : IHostedService
{
    private readonly WatchupClient _client;
    public WatchupHostedService(WatchupClient client) => _client = client;

    public Task StartAsync(CancellationToken ct) => Task.CompletedTask;

    public async Task StopAsync(CancellationToken ct)
    {
        await _client.FlushAsync();
        await _client.DisposeAsync();
    }
}
