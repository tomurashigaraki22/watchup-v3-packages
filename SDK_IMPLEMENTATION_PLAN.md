# WatchUp SDK implementation plan

This document is the source of truth for completing and maintaining every SDK
advertised by WatchUp. It is deliberately written for an implementation agent:
each phase has a concrete contract, files/repositories to change, tests to add,
and release gates.

> **How to use this file.** Every change to a package in this repository must
> trace back to a section of this plan. Work through the phases in order
> (Section 5), satisfy the shared contract (Sections 2–3) before
> framework-specific work (Section 4), and do not mark an item done until the
> acceptance checklist (Section 6) passes for that package.

## 0. This repository (`watchup-v3-packages`)

This repository is the SDK source monorepo referred to in Phase A. Package
directories live at the repository root:

| Plan section | Package | Directory | Published (npm/PyPI/NuGet) | Version in repo |
| --- | --- | --- | --- | --- |
| 4.1 Browser | `@watchupltd/browser` | `browser/` | 0.2.1 | 0.3.0 |
| 4.2 React | `@watchupltd/react` | `react/` | 0.2.2 | 0.3.0 |
| 4.3 Next.js | `@watchupltd/nextjs` | `nextjs/` | 0.2.2 | 0.3.0 |
| 4.4 Node.js / Express | `@watchupltd/node` | `node/` | 0.2.2 | 0.3.0 |
| 4.5 React Native / Expo | `@watchupltd/react-native` | `react-native/` | 0.1.0 | 0.2.0 |
| 4.6 Svelte / SvelteKit | `@watchupltd/svelte` | `svelte/` | 0.2.2 | 0.3.0 |
| 4.7 Python | `watchup` | `python/` | — | 2.1.0 |
| 4.8 Go | `github.com/tomurashigaraki22/watchup-go-sdk` | `go/` (mirrored on release) | — | 0.1.0 |
| 4.9 .NET / ASP.NET Core | `Watchup` (NuGet) | `dotnet/` | — | 1.1.0 |
| 4.10 MCP | `@watchupltd/mcp` | `mcp/` | 0.1.1 | 0.2.0 |
| 4.11 Setup CLI | `create-watchup` | `create-watchup/` | 0.1.1 | 0.2.0 |
| Shared | `@watchupltd/core` (internal, bundled) | `core/` | never published | — |

Notes:

- Commit `4bdff0e` reconciled the Browser, React, Node and Svelte sources with
  their published npm versions. Versions only move forward from the
  "Published" column; check `npm view <package> version` before every release.
- The Go SDK source now lives in `go/` and is mirrored to its module repository
  by the release workflow (see `docs/RELEASING.md`).

### Implementation status

Implemented in this repository (see the sections and files referenced):

- **Contract (§2–3):** `spec/README.md`, `spec/envelope.schema.json`,
  `spec/fixtures/vectors.json` (chunking, redaction, delivery and flag-bucket
  vectors). Implementations: `core/` (Browser, Node, React Native, and the
  framework packages through them), `python/watchup/_contract.py` +
  `_queue.py`, `go/contract.go` + `queue.go`, `dotnet/Watchup/Contract.cs` +
  `DeliveryQueue.cs`. All four pass the same vectors.
- **Mock ingest server and contract tests (Phase B.3):** `tools/mock-ingest/`
  and `tools/contract/run.mjs`, which pushes one workload (oversized and
  Unicode items, secrets, 150 traces, a scripted 503) through the Node,
  Python, Go and .NET SDKs and checks size, auth, idempotent retry, order and
  redaction.
- **Every SDK in §4.1–4.11**, including the previously missing Go source and
  the Svelte/React Native/MCP/CLI fixes; per-package changes are in each
  `CHANGELOG.md`.
- **Phase C:** route templates, request/trace IDs, request-scoped users
  (AsyncLocalStorage, contextvars, context.Context, AsyncLocal), device
  context, explicit database spans with sanitized SQL, and deterministic
  shutdown/background/offline behaviour.
- **CI and releases (Phase A.3, D, E):** `.github/workflows/ci.yml`,
  `.github/workflows/release.yml`, `fixtures/`, `e2e/`, `tools/release/`,
  `tools/check-bundle-size.mjs`, `tools/scan-build-secrets.mjs`,
  `tools/docs/examples.mjs`.
- **Ownership and policy (Phase A.4):** `.github/CODEOWNERS`,
  `docs/GOVERNANCE.md`, `docs/COMPATIBILITY.md`, `docs/RELEASING.md`.

Outside this repository (cannot be done by merging it; tracked in
`docs/OPERATIONS.md`): server-side idempotency deduplication and CORS header,
server telemetry by SDK version, server contract tests, docs-site updates,
moving the VPS apps to declared package versions, registry secrets, the
actual canary/stable publishes, and production monitoring.

## 1. What is actually on the VPS

The VPS contains the WatchUp web application and API. It is **not** a complete
SDK monorepo.

| Integration | Documentation on VPS | Source package on VPS | Installed artifact found | Status |
| --- | --- | --- | --- | --- |
| Browser | `watchup-v3/app/docs/sdks/browser` | No standalone source repo | `@watchupltd/browser` 0.2.1 in `node_modules` | Artifact only |
| React | `watchup-v3/app/docs/sdks/react` | No standalone source repo | `@watchupltd/react` 0.2.2 | Artifact only |
| Next.js | `watchup-v3/app/docs/sdks/nextjs` | No standalone source repo | `@watchupltd/nextjs` 0.2.1 | Artifact only |
| Node.js / Express | `watchup-v3/app/docs/sdks/node` | No standalone source repo | `@watchupltd/node` 0.2.1 | Artifact only |
| React Native / Expo | `watchup-v3/app/docs/sdks/react-native` | Not found | Not found | Docs-only claim; source/package required |
| Svelte / SvelteKit | `watchup-v3/app/docs/sdks/svelte` | Not found | Not found | Docs-only claim; source/package required |
| Python | `watchup-v3/app/docs/sdks/python` | Not found | Not found | Docs-only claim; source/package required |
| Go | `watchup-v3/app/docs/sdks/go` | Not found | Not found | Docs-only claim; source/package required |
| .NET / ASP.NET Core | `watchup-v3/app/docs/sdks/dotnet` | Not found | Not found | Docs-only claim; source/package required |
| MCP | `watchup-v3/app/docs/mcp` | Not found | Not found | Docs-only claim; source/package required |
| REST API | `watchup-v3-server/app/blueprints/ingest` and API docs | Server implementation exists | N/A | Canonical fallback |
| Setup CLI | `watchup-v3/app/docs/setup-cli` | CLI source is not on this VPS | Not verified | Must be audited separately |

The same JavaScript package artifacts also appear in the staging and Trollz
application `node_modules` trees. That is not source ownership. `node_modules`
is generated output and can be replaced on the next install or build.

The only durable SDK-related source currently visible in this workspace is the
documentation and the API contract. A package installed under
`/var/www/watchup-v3/node_modules` must **not** be edited in place. Use the SDK
source repository or a committed `patch-package` patch until the repository is
available. The app's `instrumentation.js` is application integration code, not
the Next.js SDK source.

## 2. Shared contract (all SDKs must implement this first)

Every SDK sends the same envelope to the production ingest API:

```json
{
  "events": [],
  "errors": [],
  "traces": [],
  "sdk": {"name": "@watchupltd/node", "version": "x.y.z"},
  "environment": "production",
  "release": "git-sha-or-version"
}
```

The server remains backward compatible with the legacy project-id header while
SDKs migrate to a `wup_live_`/`wup_pub_` key. New SDK releases must send:

- `Authorization: Bearer <project-key>` (or the documented project-key header);
- `Content-Type: application/json`;
- a unique `Idempotency-Key` for each logical batch;
- a stable `sdk.name` and `sdk.version`;
- canonical fields for route, method, status, duration, source, service,
  environment, release, request/trace/span IDs, user identity, and safe device
  metadata;
- no passwords, tokens, authorization headers, cookies, card data, or raw
  request bodies unless the user explicitly opts into a redacted field.

Server limits are currently a 256 KiB request body, a 100-item count guard, and
per-project rate/event quotas. SDKs must enforce safer client-side limits before
the request reaches the server.

## 3. Required byte-aware batching/chunking contract

The current installed Browser and Node artifacts drain arrays by item count. A
large event can still create an oversized JSON request. This is the next SDK
phase and must be implemented in every language, not as a one-off server hack.

### Algorithm

1. Build a candidate envelope with the same fields the server will receive.
2. Serialize with UTF-8 and measure bytes, not characters or item count.
3. Target a maximum of **192 KiB per chunk** (headroom below the server's 256
   KiB limit for proxies and future envelope fields).
4. Preserve FIFO order separately for `errors`, `traces`, and `events`.
5. Greedily add the next item while the serialized envelope remains within the
   target. If it does not fit, flush the current chunk and continue.
6. If one item by itself exceeds the target, apply the documented safe
   truncation policy to stack/message/metadata fields and emit a local SDK
   diagnostic. Never silently drop an error. If it still cannot fit, send it as
   a single request and surface the server response clearly.
7. Every chunk gets its own idempotency key derived from a batch UUID and chunk
   index, for example `wu_<batch-id>_<index>`. Retries reuse that key.
8. A failed chunk is retried with bounded exponential backoff and jitter. The
   queue must continue processing later chunks and must not duplicate a chunk
   already accepted by the server.
9. Browser `sendBeacon` is allowed only for a chunk that has already been split
   below the byte target. Never pass an oversized unsplit payload to Beacon.
10. Shutdown/page-unload flushes synchronously as far as the runtime permits;
    diagnostics report what could not be delivered.

### Shared test vectors

Every SDK must pass the same fixtures:

- empty envelope;
- one normal event;
- 100 small events;
- one 250 KiB message (truncation/rejection path);
- a Unicode message where character count differs from UTF-8 byte count;
- mixed errors/traces/events proving per-array order;
- a failed chunk followed by a successful retry with the same idempotency key;
- two concurrent flush calls proving that an item is present in one chunk only;
- shutdown with pending items;
- redaction of `authorization`, `cookie`, `password`, `token`, and nested
  equivalents.

## 4. SDK-by-SDK implementation requirements

### 4.1 Browser (`@watchupltd/browser`) — `browser/`

**Public surface:** constructor/options, automatic console/error/unhandled
rejection capture, Web Vitals, `track`, `captureError`, `startTrace`, `setUser`,
`clearUser`, `flush`, feature-flag reads, and page visibility/unload handling.

**Implementation work:** move transport, serializer, redactor, byte-aware
chunker, retry queue, and flag cache into the source repository. Keep the
transport dependency-free and browser-safe. Attach route and device context at
capture time, not when a delayed batch is flushed. Use `navigator.sendBeacon`
only for already-sized chunks; use `fetch(..., keepalive)` as the fallback.

**Tests:** Vitest/Jest tests for console/error hooks, Web Vitals, route changes,
redaction, UTF-8 chunk sizing, unload flushing, `fetch`/Beacon fallback,
idempotency keys, retry ordering, and feature-flag cache expiry.

**Release gate:** build ESM/CJS/types, run bundle-size and browser matrix
(Chromium, Firefox, WebKit), publish a canary, then update the React/Next/Svelte
peer ranges.

### 4.2 React (`@watchupltd/react`) — `react/`

**Public surface:** `WatchupProvider`, error boundary, hooks (`useWatchup`,
`useTrack`, `useIdentify`), route/page-view tracking, and flag hooks.

**Implementation work:** keep the provider client-only and StrictMode-safe;
avoid duplicate listeners during development remounts; clean up listeners on
unmount; share the Browser transport rather than maintaining a second queue.
ErrorBoundary must preserve the original React error flow after capture.

**Tests:** React Testing Library tests for provider lifecycle, StrictMode
double-mount, error-boundary rethrow, route changes, hook identity, cleanup,
SSR safety, and flag refresh behavior. Reuse Browser chunk fixtures.

**Release gate:** React 18 and 19 peer tests, Vite/webpack/Next consumer
fixtures, type declarations, and a canary package.

### 4.3 Next.js (`@watchupltd/nextjs`) — `nextjs/`

**Public surface:** browser provider, server singleton, route wrapper, and
instrumentation helpers for App Router and Pages Router.

**Implementation work:** keep browser code out of the server bundle; support
Node runtime explicitly and fail with a clear message in Edge runtime; preserve
route templates and request IDs; flush on process shutdown; never expose a
server key through `NEXT_PUBLIC_*`. The route wrapper must capture errors once
and preserve the original response/status.

**Tests:** Next 14/15 App Router and Pages Router fixtures, server/client
boundary tests, instrumentation startup exactly once, route-wrapper status and
headers, Edge-runtime guard, chunk/retry behavior, and build output scans for
secret leakage.

**Release gate:** build all exports (`client`, `server`), test Turbopack and
webpack, run a production `next build`, and publish only after the browser,
React, and Node peer packages are available.

### 4.4 Node.js / Express (`@watchupltd/node`) — `node/`

**Public surface:** request middleware, error middleware, `captureError`,
`startTrace`, `track`, `setUser`, `clearUser`, `flush`, `shutdown`, and local
flag reads.

**Implementation work:** use AsyncLocalStorage for request/user context so
concurrent requests never share identity; normalize Express route templates;
capture rejected promises and `next(err)` exactly once; preserve response
status and headers; add graceful SIGTERM/SIGINT flush; implement the shared
byte-aware queue and idempotent retries.

**Tests:** Node 18/20/22, Express 4/5, concurrent user isolation, route
normalization, thrown/rejected errors, middleware ordering, graceful shutdown,
oversized chunk vectors, and retry idempotency.

**Release gate:** ESM/CJS/types, no dependency on browser globals, typecheck,
lint, integration fixture against a mock WatchUp API, and canary publish.

### 4.5 React Native / Expo (`@watchupltd/react-native`) — `react-native/`

**Current gap:** documentation advertises this package, but no source or
installed artifact was found on the VPS.

**Required implementation:** create the package from the shared core with a
React Native transport. Capture JS exceptions, unhandled promise rejections,
screen/navigation changes, custom events, traces, and user identity. Store a
bounded offline queue using AsyncStorage or SQLite; flush when connectivity
returns; use AppState/background limits; never block UI rendering.

**Tests:** Jest plus React Native Testing Library, iOS/Android device fixtures,
offline/online transitions, app background/foreground, queue persistence,
redaction, byte-aware chunking, and native exception handoff where supported.

**Release gate:** Expo managed workflow and bare React Native fixture, Hermes
compatibility, iOS/Android builds, and a documented minimum RN/Expo matrix.

### 4.6 Svelte / SvelteKit (`@watchupltd/svelte`) — `svelte/`

**Current gap:** docs exist, but package source/artifact was not found on VPS.

**Required implementation:** provider/context helper, `trackClick` and
`traceAction` actions, SvelteKit browser/server boundary, navigation tracking,
and shared Browser transport. SSR must never access `window` or send duplicate
events during hydration.

**Tests:** Svelte 4 and 5, SvelteKit SSR/hydration, action mount/destroy,
navigation, error capture, flags, chunk vectors, and browser fallback.

**Release gate:** package exports and `.svelte` typings, SvelteKit fixture build,
canary publish, and docs examples run in CI.

### 4.7 Python (`watchup`) — `python/`

**Current gap:** docs exist and production telemetry shows a `watchup-python`
user-agent from an external client, but the Python source package is not on this
VPS. Do not infer that user-agent means the source is installed here.

**Required implementation:** framework-neutral client; Flask hooks; Django
middleware; ASGI middleware; WSGI wrapper; Celery/background-task capture;
contextvars for request/user isolation; daemon queue with deterministic
`flush()`/`shutdown()`; stdlib-only baseline; byte-aware chunking and retries.

**Tests:** Python 3.9–3.13, Flask, Django, Starlette/FastAPI, WSGI, async
exceptions, context isolation, fork safety, shutdown, redaction, and the shared
chunk fixtures.

**Release gate:** wheel/sdist, typed public API, `ruff`/`mypy`/pytest, no
network calls during import, PyPI test release, then production release.

### 4.8 Go (`github.com/tomurashigaraki22/watchup-go-sdk`) — separate repository

**Current gap:** docs reference a public Go module, but the source repository is
not on the VPS.

**Required implementation:** `net/http` middleware, Gin/Chi examples, panic
recovery, explicit error capture, trace handles, event tracking, per-request
context/user identity, bounded goroutine-safe queue, context-aware HTTP client,
and `Close`/`Flush` with a deadline. Use `encoding/json` byte measurement before
send.

**Tests:** Go 1.21+ race detector, concurrent context isolation, middleware
status/route normalization, panic recovery, cancellation, chunk fixtures,
retry/idempotency, and graceful close.

**Release gate:** `go test -race ./...`, `go vet`, `staticcheck`, tagged module,
Go proxy visibility, and a real example service build.

### 4.9 .NET / ASP.NET Core (`Watchup` NuGet) — `dotnet/`

**Current gap:** docs exist, but the NuGet source/package is not on the VPS.

**Required implementation:** `AddWatchup`, ASP.NET middleware after routing,
DI singleton, background hosted-service queue, `HttpClientFactory`, request
template/status/duration capture, exception capture/rethrow, manual traces/events,
and `IAsyncDisposable` shutdown. Use `ArrayPool`/streaming serialization only
after correctness; enforce byte limits before HTTP send.

**Tests:** .NET 8/9/10, netstandard2.1 core, DI/middleware ordering,
exception behavior, cancellation, shutdown flush, redaction, and chunk vectors.

**Release gate:** `dotnet test`, analyzers, package signing, NuGet symbols,
ASP.NET sample build, and package compatibility review.

### 4.10 MCP (`@watchupltd/mcp`) — `mcp/`

**Current gap:** MCP documentation exists, but the package source is not on the
VPS.

**Required implementation:** stdio MCP server, project discovery, health,
errors, logs/events, traces, alerts/incidents, flags, and community reads;
guarded write actions only with a dedicated scoped token; project API-key
fallback must remain read-only. Redact secrets in tool output, enforce
timeouts/pagination, and emit structured diagnostics without leaking tokens.

**Tests:** MCP protocol handshake, tool schemas, read-only enforcement,
project authorization, pagination, provider/API failures, timeout handling,
redaction, and CLI configuration examples for Codex/Cursor/Claude Desktop.

**Release gate:** npm package, `npx` smoke test, signed/versioned tool schema,
and a compatibility matrix for MCP client versions.

### 4.11 REST API and Setup CLI (`create-watchup/`)

The REST API is the compatibility reference for all SDKs. Add contract tests
for every envelope, error code, limit, idempotency behavior, and response shape.
The setup CLI must be audited against the package matrix before it is advertised
as an installer: detect framework, install a real published package, write only
the correct public/server environment variable, create one integration, and
never generate duplicate providers or middleware.

## 5. Delivery phases

### Phase A — source ownership and contract

1. Create or obtain a real source repository (prefer a monorepo with `core`,
   browser, react, nextjs, node, react-native, svelte, python, go, dotnet, and
   mcp packages, or clearly linked repositories).
2. Pin the REST schema and shared fixtures in version control.
3. Add CI for format, lint, typecheck, unit tests, contract tests, package
   builds, and secret scans.
4. Record package owners, supported runtimes, release cadence, and deprecation
   policy.

### Phase B — transport hardening and chunking

1. Implement the byte-aware algorithm above in shared core/reference clients.
2. Port it to each language without changing envelope semantics.
3. Add the shared fixture suite and a mock ingest server that validates body
   size, idempotency, ordering, and redaction.
4. Release Browser/Node first, then React/Next/Svelte, then Python/Go/.NET/RN,
   then MCP and CLI.

### Phase C — framework behavior and context quality

1. Verify route templates, request IDs, user context, device context, source,
   service, environment, release, and stack traces for every SDK.
2. Add database/slow-query spans through explicit instrumentation hooks; never
   capture raw credentials or unbounded SQL parameters.
3. Make lifecycle behavior deterministic (shutdown, process restart, mobile
   backgrounding, serverless invocation limits).

### Phase D — compatibility rollout

1. Publish canaries and test them in fixture applications.
2. Update WatchUp docs only when the package exists and the quickstart runs in
   CI.
3. Update the setup CLI package map and fail fast for unsupported frameworks.
4. Add server-side telemetry for SDK name/version, rejected oversized payloads,
   retry counts, and contract failures.
5. Migrate the WatchUp web app and staging apps from generated artifacts to
   declared package versions; never copy edited `node_modules` into production.

### Phase E — production release and operations

1. Tag each package with a changelog and provenance metadata.
2. Publish signed packages and verify installation from a clean environment.
3. Deploy the docs and server contract together with a compatibility window.
4. Monitor ingest acceptance, chunk rejection, queue age, SDK error rate, and
   version adoption.
5. Keep rollback packages and a migration note for every breaking contract.

## 6. Acceptance checklist for an AI implementation agent

Status as of the 2026-10 release set. A box is ticked only when it is done
and verified in this repository; the rest name what is still needed.

- [x] Source repository path is identified; no edit is made inside
      `node_modules` as a substitute for source.
      *This monorepo; packages build from `*/src`.*
- [x] The package exists for every advertised SDK, or the docs explicitly mark
      it as planned rather than available.
      *Source exists for all eleven, including Go in `go/`. The docs site must
      keep Go (and anything not yet released) marked planned until published —
      `docs/OPERATIONS.md` §2.*
- [x] Shared envelope and redaction fixtures pass in every implementation.
      *`spec/fixtures/vectors.json` runs in `core/test`, `python/tests`,
      `go/vectors_test.go` and `dotnet/Watchup.Tests/VectorTests.cs`.*
- [x] Byte-aware chunking is tested with Unicode and oversized fields.
- [x] Retries reuse idempotency keys and never duplicate accepted chunks.
      *Client side: an accepted chunk is never resent, retries reuse the key
      (vectors + `tools/contract/run.mjs`). Deduplicating a retry whose first
      response was lost needs the server change in `docs/OPERATIONS.md` §1.*
- [ ] Context fields are present and human-readable in dashboard events,
      incidents, email, Telegram, Slack, Discord, webhook, and MCP output.
      *The SDKs send the canonical fields (route, method, status, duration,
      source, service, environment, release, request/trace IDs, user, device);
      rendering them in the dashboard and notification channels is
      server/dashboard work.*
- [x] Shutdown/background behavior is tested for the runtime.
      *Node signals and shutdown, browser unload/beacon/persistence,
      React Native background/offline/restart, Python fork/atexit, Go
      `Close(ctx)`, .NET hosted-service stop.*
- [x] Package build, type/lint checks, integration fixture, and clean-install
      smoke test pass.
      *Verified locally: build, typecheck, Biome, ruff, mypy, go vet, .NET
      analyzers, Next 14/15 and SvelteKit fixtures from packed tarballs. The
      full matrix (Node 18/20/22, Python 3.9–3.13, Go 1.21–1.23, .NET 8/9/10,
      Firefox, Expo, bare RN/Hermes) runs in `.github/workflows/ci.yml`.*
- [x] Documentation examples are executed in CI before publication.
      *`tools/docs/examples.mjs` (snippets match files; examples run against
      the mock API), Go examples and the .NET sample build, MCP config tests.*
- [ ] Production rollout has a canary, monitoring, rollback version, and a
      recorded package/version compatibility matrix.
      *Canary and rollback procedures (`docs/RELEASING.md`) and the
      compatibility matrix (`docs/COMPATIBILITY.md`) are in place; running the
      canary and setting up monitoring are operations work
      (`docs/OPERATIONS.md` §4).*
