# Shared test vectors

`vectors.json` is loaded by the test suite of every SDK:

| SDK | Loader |
| --- | --- |
| `@watchupltd/core` (Browser, Node, React Native) | `core/test/vectors.test.ts` |
| Python | `python/tests/test_vectors.py` |
| Go | `go/vectors_test.go` |
| .NET | `dotnet/Watchup.Tests/VectorTests.cs` |

## Generator syntax

To keep the file small, `generate` blocks expand into input items:

- `{"events": {"count": N, "template": {...}}}` produces N items. Every string
  in the template has `{i}` replaced with the item index.
- `{"$repeat": "x", "times": N}` becomes the string `x` repeated N times.
- `{"$object": {"key": "k{j}", "value": <v>, "count": N}}` becomes an object
  with N keys `k0…k(N-1)`, each set to `<v>` (expanded).

## Labels

`sequence` lists items as `<array>:<label>`, where the label is `message` for
errors, `span` for traces and `name` for events.

## Expectations

- `chunks` — number of chunks produced by one flush.
- `items_per_chunk` — total items in each chunk.
- `truncated` — whether each item (in send order) carries
  `_watchup_truncated: true`.
- `max_message_bytes` — the truncated `message` is at most this many UTF-8 bytes
  plus the `…[truncated <n> bytes]` suffix.
- `context_marker` — `context` was replaced with
  `{"_watchup_truncated": true, "original_bytes": <n>}`.
- Every chunk body must be at most `MAX_CHUNK_BYTES` UTF-8 bytes and at most
  `MAX_CHUNK_ITEMS` items, and must validate against `../envelope.schema.json`.

`flag_buckets` pins feature-flag bucketing (djb2-xor over UTF-16 code units,
modulo 100) so a user gets the same rollout decision in every SDK.

Delivery vectors list scripted HTTP responses in order (`always_200` and
`always_503` repeat forever). Time is simulated so retries happen immediately in
tests.
