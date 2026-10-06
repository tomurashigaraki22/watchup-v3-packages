# watchup-v3-packages

Official SDK monorepo for [Watchup](https://watchup.site) — application monitoring, error capture, request tracing, custom events, logs and feature flags.

Every SDK implements one transport contract ([`spec/`](./spec)): byte-aware chunks under 192 KiB, redaction before anything is queued, idempotency keys and retries. A shared test-vector file and a cross-language contract run keep them identical.

## Packages

| Package | Directory | Registry | Version |
| --- | --- | --- | --- |
| Browser | [`browser/`](./browser) | npm `@watchupltd/browser` | 0.3.0 |
| Node.js / Express | [`node/`](./node) | npm `@watchupltd/node` | 0.3.0 |
| React | [`react/`](./react) | npm `@watchupltd/react` | 0.3.0 |
| Next.js | [`nextjs/`](./nextjs) | npm `@watchupltd/nextjs` | 0.3.0 |
| Svelte / SvelteKit | [`svelte/`](./svelte) | npm `@watchupltd/svelte` | 0.3.0 |
| React Native / Expo | [`react-native/`](./react-native) | npm `@watchupltd/react-native` | 0.2.0 |
| MCP server | [`mcp/`](./mcp) | npm `@watchupltd/mcp` | 0.2.0 |
| Setup CLI | [`create-watchup/`](./create-watchup) | npm `create-watchup` | 0.2.0 |
| Python | [`python/`](./python) | PyPI `watchup` | 2.1.0 |
| Go | [`go/`](./go) | `github.com/tomurashigaraki22/watchup-go-sdk` (mirrored) | 0.1.0 |
| .NET | [`dotnet/`](./dotnet) | NuGet `Watchup` | 1.1.0 |

Internal: [`core/`](./core) (shared TypeScript transport, bundled into the JS packages), [`spec/`](./spec) (contract + vectors), [`tools/`](./tools) (mock ingest server, contract runner, release checks), [`fixtures/`](./fixtures) (consumer apps), [`e2e/`](./e2e) (browser matrix).

Supported runtimes and package compatibility: [`docs/COMPATIBILITY.md`](./docs/COMPATIBILITY.md).

## Quick install

```bash
npx create-watchup@latest          # detects your framework and sets everything up
npm install @watchupltd/node       # or browser, react, nextjs, svelte, react-native
pip install watchup
go get github.com/tomurashigaraki22/watchup-go-sdk
dotnet add package Watchup
```

## Development

```bash
npm ci
npm run lint && npm run build && npm run typecheck && npm test   # JS workspaces (vitest)
node tools/release/check-versions.mjs                           # versions, changelogs, peer ranges
node tools/check-bundle-size.mjs                                # browser bundle budgets
npx playwright test                                             # Chromium, Firefox, WebKit
node tools/contract/run.mjs                                      # same workload through every SDK
node tools/docs/examples.mjs check && node tools/docs/examples.mjs run

cd python && pip install -e ".[dev]" && ruff check watchup tests && mypy && pytest
cd go && go test -race ./... && go vet ./...
dotnet test dotnet/Watchup.Tests
```

CI runs all of the above on every pull request ([`.github/workflows/ci.yml`](./.github/workflows/ci.yml)). Releases: [`docs/RELEASING.md`](./docs/RELEASING.md). Ownership and policies: [`docs/GOVERNANCE.md`](./docs/GOVERNANCE.md). Work that lives outside this repository (server, docs site, VPS): [`docs/OPERATIONS.md`](./docs/OPERATIONS.md). The plan these all implement: [`SDK_IMPLEMENTATION_PLAN.md`](./SDK_IMPLEMENTATION_PLAN.md).

## License

MIT © Watchup Ltd
