# Compatibility

## Supported runtimes

Each row is tested in CI ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)).

| Package | Runtimes and frameworks | CI job |
| --- | --- | --- |
| `@watchupltd/browser` | Chromium, Firefox, WebKit (evergreen, ES2019) | `browsers`, `js` |
| `@watchupltd/node` | Node 18, 20, 22; Express 4 and 5 | `js`, `js-compat` |
| `@watchupltd/react` | React 18 and 19; Vite, webpack (via Next) | `js-compat`, `fixtures` |
| `@watchupltd/nextjs` | Next 14 and 15; App Router and Pages Router; webpack and Turbopack; Node.js runtime (Edge throws a clear error) | `fixtures` |
| `@watchupltd/svelte` | Svelte 4 and 5; SvelteKit 2 | `js-compat`, `fixtures` |
| `@watchupltd/react-native` | React Native 0.72+, Expo SDK 50+ (CI: RN 0.76 / Expo 52), Hermes and JSC | `fixtures`, `js` |
| `@watchupltd/mcp` | Node 18+; MCP SDK 1.x clients over stdio (Claude Desktop, Claude Code, Cursor, Codex) | `js`, `mcp-smoke` |
| `create-watchup` | Node 18+; npm, pnpm, yarn, bun | `js` |
| `watchup` (Python) | CPython 3.9–3.13; Flask 2.3+, Django 4.2+, Starlette/FastAPI, WSGI, Celery 5.2+ | `python` |
| Go module | Go 1.21+ (route patterns need 1.23+) | `go` |
| `Watchup` (.NET) | .NET 8, 9, 10 (ASP.NET Core); `netstandard2.1` core client | `dotnet` |

Minimum versions are raised only in a minor release, with at least one release of notice in the changelog (see [GOVERNANCE.md](./GOVERNANCE.md)).

## Package/version matrix

Contract version **1** ([`spec/`](../spec)). All of these speak it and can be mixed freely in one project.

| Release set | browser | node | react | nextjs | svelte | react-native | mcp | create-watchup | python | go | dotnet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **2026-10 (this release)** | 0.3.0 | 0.3.0 | 0.3.0 | 0.3.0 | 0.3.0 | 0.2.0 | 0.2.0 | 0.2.0 | 2.1.0 | 0.1.0 | 1.1.0 |
| Previous | 0.2.1 | 0.2.2 | 0.2.2 | 0.2.2 | 0.2.2 | 0.1.0 | 0.1.1 | 0.1.1 | 2.0.0 | — | 1.0.0 |

Peer ranges inside a release set are checked by `tools/release/check-versions.mjs`:

- `@watchupltd/react@0.3` needs `@watchupltd/browser@^0.3`.
- `@watchupltd/nextjs@0.3` needs `browser`, `react` and `node` `^0.3`.
- `@watchupltd/svelte@0.3` needs `browser@^0.3` (and optionally `node@^0.3` for the server hooks).

## Server compatibility

Every SDK in the current release set works with the production API as it is today:

- Auth: `Authorization: Bearer` (preferred) and `X-Api-Key` carry the same key; browsers add the public key as `project_id` in the body for `sendBeacon`.
- `Idempotency-Key` is sent by server SDKs and React Native, and in the body by browsers. A server that ignores it still works; deduplication of retried chunks needs the server change in [OPERATIONS.md](./OPERATIONS.md).
- Extra envelope fields (`sdk`, `idempotency_key`, `sent_at`, `project_id`, `_watchup_truncated`) are additive.

## Migration notes for this release

Behaviour changes worth checking when upgrading (details in each package's `CHANGELOG.md`):

- **React:** `WatchupErrorBoundary` without `fallback` re-throws after capturing. Add a `fallback` if you relied on the built-in message.
- **Node / Browser:** `flush()` and `shutdown()` return promises.
- **Node:** signal handling no longer removes your own SIGTERM/SIGINT handlers; with no handlers of your own, the signal is re-raised after flushing.
- **Svelte:** `getWatchup()` returns a `WatchupHandle` (same capture API).
- **MCP:** write tools need `WATCHUP_TOKEN`; list tools paginate.
- **Python:** the Flask integration listens to `got_request_exception` (404s are no longer errors); `watchup.batcher` is gone.
- **.NET:** middleware and DI need .NET 8+; the ASP.NET Core 2.2 packages are no longer referenced.

## Deprecated

| What | Since | Removal |
| --- | --- | --- |
| Envelopes without `sdk`/`idempotency_key` (pre-contract SDKs) | 2026-10 | Server keeps accepting them for at least 6 months after this release set ships. |
| `X-Api-Key` header | 2026-10 | Still sent alongside `Authorization`; dropped no earlier than the next major of each SDK. |
