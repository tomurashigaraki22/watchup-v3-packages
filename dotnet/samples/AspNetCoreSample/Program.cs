// Minimal ASP.NET Core app wired to WatchUp. Built in CI as the sample check.
using Watchup;
using Watchup.Middleware;

var builder = WebApplication.CreateBuilder(args);

// Reads Watchup:ApiKey, Watchup:Release, ... from configuration / environment.
builder.Services.AddWatchup(builder.Configuration.GetSection("Watchup"));

var app = builder.Build();
app.UseRouting();
app.UseWatchup(); // after routing, so traces use route templates

app.MapGet("/orders/{id:int}", async (int id, WatchupClient watchup) =>
{
    watchup.SetUser(new WatchupUser($"customer-{id}"));
    var total = await watchup.TraceQueryAsync(
        "SELECT total FROM orders WHERE id = @id",
        () => Task.FromResult(42.0m),
        system: "postgresql");
    watchup.Track("order.viewed", new() { ["order_id"] = id });
    return Results.Ok(new { id, total });
});

app.MapGet("/fail", (Func<string>)(() => throw new InvalidOperationException("Sample failure")));

app.Run();
