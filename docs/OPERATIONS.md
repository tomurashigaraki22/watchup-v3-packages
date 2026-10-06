# Operations hand-off

The SDK plan has steps that live outside this repository: the ingest server, the docs site, the VPS apps, and dashboards. This file lists each one with the exact change needed. Nothing here is done by merging this repository.

## 1. Ingest server (`watchup-v3-server`)

| Change | Why | Plan |
| --- | --- | --- |
| Add `Idempotency-Key` to `Access-Control-Allow-Headers` | Lets browsers send the key as a header too (today it travels in the body only). | §2, §3.7 |
| Deduplicate on the idempotency key (header, else body `idempotency_key`): store accepted keys for 24 h and answer `200 {"duplicate": true}` without re-ingesting | Retries after a lost response must not double-count. The SDKs already reuse keys. | §3.7–3.8 |
| Make sure `/api/v1/ingest/batch` parses JSON whatever the `Content-Type` (verified on `/ingest/ping` with `text/plain`) | Browser beacons are `text/plain` to avoid a credentialed CORS preflight. | §3.9 |
| Accept the batch envelope fields `sdk`, `environment`, `release`, `idempotency_key`, `sent_at`, `project_id`, and item fields `type`, `_watchup_truncated` | Contract v1 ([`spec/envelope.schema.json`](../spec/envelope.schema.json)). | §2 |
| Count `body.errors/traces/events` together against the 100-item guard and return `422` instead of silently dropping extras | SDKs never exceed 100, but the guard should be visible. | §2 |
| Record per request: `sdk.name`, `sdk.version`, accepted/rejected counts, `413`s, duplicate keys | Adoption, oversized payloads and retry visibility. | Phase D.4 |
| Add server-side contract tests: validate request bodies against `spec/envelope.schema.json`, replay the `spec/fixtures/vectors.json` workloads, and assert the documented error codes (`missing_key`, `invalid_key`, `validation_error`, `payload_too_large`) and response shapes. (`tools/contract/run.mjs` checks the SDK side against the mock; it reads the mock's internal state, so it cannot target a real server.) | Contract tests for every envelope, error code, limit and response shape. | §4.11 |

## 2. Docs site (`watchup-v3/app/docs`)

- Publish the package READMEs as the SDK pages; keep the version shown in sync with [COMPATIBILITY.md](./COMPATIBILITY.md).
- **Go:** keep the page marked *planned* until the first `go-v0.1.0` release has mirrored the module and `go get` works.
- **React Native, Svelte, Python, .NET, MCP:** source is now in this repository; mark each page *available* only after its stable release is published (plan §6, second item).
- Replace hand-written quick starts with the files CI executes: `examples/node-express.mjs`, `examples/python_flask.py`, `go/examples/*`, `dotnet/samples/AspNetCoreSample`.
- Document `create-watchup` from [`create-watchup/README.md`](../create-watchup/README.md), including the fail-fast list.

## 3. VPS applications (`/var/www/watchup-v3`, staging, Trollz)

1. Replace any edited files under `node_modules/@watchupltd/*` with declared versions in `package.json` (`"@watchupltd/nextjs": "^0.3.0"`, etc.) and run a clean `npm ci`. Never copy edited `node_modules` into production.
2. Move `instrumentation.js` to `registerWatchup()` + `export { captureRequestError as onRequestError }`.
3. Set `NEXT_PUBLIC_WATCHUP_API_KEY` to the **public** key and `WATCHUP_API_KEY` to the **secret** key. Check the built `.next/static` with `node tools/scan-build-secrets.mjs .next/static`.
4. Roll out the canary to staging first; promote after 24 hours on the dashboard below.

## 4. Monitoring

A dashboard (or saved queries) per release set:

| Signal | Source | Alert when |
| --- | --- | --- |
| Ingest acceptance rate by `sdk.name`/`sdk.version` | server telemetry (§1) | below 99 % for 15 min |
| `413 payload_too_large` and `422` by SDK version | server | any from a contract-v1 SDK |
| Duplicate idempotency keys | server | sustained spike (retry storm) |
| `chunk_dropped`, `queue_overflow`, `undelivered_on_shutdown` | SDK diagnostics (`onDiagnostic`) forwarded from the WatchUp apps themselves | any in production |
| SDK error rate in the WatchUp apps | WatchUp project for the WatchUp apps | above baseline after a rollout |
| Version adoption | server telemetry | old versions still > 10 % six months after a release set |

## 5. Rollback

Per [RELEASING.md](./RELEASING.md#4-rollback). Server and docs changes ship together with a compatibility window: the server must keep accepting pre-contract envelopes for at least 6 months ([COMPATIBILITY.md](./COMPATIBILITY.md#deprecated)).
