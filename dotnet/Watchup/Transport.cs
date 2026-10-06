// ─────────────────────────────────────────────────────────────────────────────
// Watchup .NET SDK  ·  Transport
//
// Posts one chunk. Never throws: failures become SendResults so the queue can
// decide about retries.
// ─────────────────────────────────────────────────────────────────────────────

using System.Net;
using System.Text;
using System.Text.Json;

namespace Watchup;

internal sealed class Transport
{
    private readonly HttpClient _http;
    private readonly Uri _url;
    private readonly string _apiKey;
    private readonly TimeSpan _timeout;

    internal Transport(HttpClient http, string baseUrl, string apiKey, TimeSpan timeout)
    {
        _http = http;
        _url = new Uri($"{baseUrl.TrimEnd('/')}/api/v1/ingest/batch");
        _apiKey = apiKey;
        _timeout = timeout;
    }

    internal async Task<SendResult> SendAsync(Chunk chunk, CancellationToken ct)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(_timeout);
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, _url)
            {
                Content = new StringContent(chunk.Body, Encoding.UTF8, "application/json"),
            };
            request.Headers.TryAddWithoutValidation("Authorization", $"Bearer {_apiKey}");
            request.Headers.TryAddWithoutValidation("X-Api-Key", _apiKey);
            request.Headers.TryAddWithoutValidation("Idempotency-Key", chunk.IdempotencyKey);
            request.Headers.TryAddWithoutValidation("User-Agent", $"{WatchupClient.SdkName}/{WatchupClient.SdkVersion}");

            using var response = await _http.SendAsync(request, timeout.Token).ConfigureAwait(false);
            var status = (int)response.StatusCode;
            if (response.IsSuccessStatusCode) return new SendResult(true, status);

            string? code = null;
            try
            {
                var body = await response.Content.ReadAsStringAsync().ConfigureAwait(false);
                using var doc = JsonDocument.Parse(body);
                if (doc.RootElement.TryGetProperty("code", out var c) && c.ValueKind == JsonValueKind.String) code = c.GetString();
            }
            catch
            {
                // Non-JSON error body.
            }
            if (code is null && response.StatusCode == HttpStatusCode.RequestEntityTooLarge) code = "payload_too_large";
            return new SendResult(false, status, code, RetryAfter(response));
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            return new SendResult(false, Error: $"Timed out after {_timeout.TotalSeconds:0}s");
        }
        catch (Exception ex)
        {
            return new SendResult(false, Error: ex.Message);
        }
    }

    private static TimeSpan? RetryAfter(HttpResponseMessage response)
    {
        var header = response.Headers.RetryAfter;
        TimeSpan? delay = header?.Delta ?? (header?.Date is { } date ? date - DateTimeOffset.UtcNow : null);
        if (delay is null) return null;
        var max = TimeSpan.FromMilliseconds(WatchupLimits.MaxRetryAfterMs);
        return delay < TimeSpan.Zero ? TimeSpan.Zero : delay > max ? max : delay;
    }
}
