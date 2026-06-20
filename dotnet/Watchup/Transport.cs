// ─────────────────────────────────────────────────────────────────────────────
// Watchup .NET SDK  ·  Transport
//
// Thin HTTP layer around HttpClient.
// All failures are swallowed — the SDK must never crash the host application.
// ─────────────────────────────────────────────────────────────────────────────

using System.Net.Http.Json;
using System.Text.Json;

namespace Watchup;

internal sealed class Transport
{
    private readonly HttpClient    _http;
    private readonly string        _url;
    private readonly bool          _debug;

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
    };

    internal Transport(HttpClient http, string baseUrl, bool debug)
    {
        _http  = http;
        _url   = $"{baseUrl.TrimEnd('/')}/api/v1/ingest/batch";
        _debug = debug;
    }

    /// <summary>
    /// POST <paramref name="batch"/> to the Watchup ingest endpoint.
    /// Never throws — any error is logged (if debug) and silently dropped.
    /// </summary>
    internal async Task SendAsync(IngestBatch batch, CancellationToken ct = default)
    {
        try
        {
            using var response = await _http
                .PostAsJsonAsync(_url, batch, JsonOpts, ct)
                .ConfigureAwait(false);

            if (_debug && !response.IsSuccessStatusCode)
            {
                var body = await response.Content.ReadAsStringAsync().ConfigureAwait(false);
                Console.Error.WriteLine($"[watchup] ingest {(int)response.StatusCode}: {body}");
            }
        }
        catch (Exception ex) when (_debug)
        {
            Console.Error.WriteLine($"[watchup] send failed: {ex.Message}");
        }
        catch
        {
            // Intentionally swallowed — SDK must never crash the host.
        }
    }
}
