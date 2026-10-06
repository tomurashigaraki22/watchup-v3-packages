# Releasing

Automated by [`.github/workflows/release.yml`](../.github/workflows/release.yml). Every release re-runs the full CI workflow first.

## One-time setup (repository admins)

| Secret / setting | Used for |
| --- | --- |
| `NPM_TOKEN` (automation token for the `@watchupltd` scope) | npm publish with `--provenance` |
| PyPI and TestPyPI trusted publishers for this repository (environments `pypi`, `testpypi`) | Python publish (no token needed) |
| `NUGET_API_KEY`, `NUGET_SIGNING_CERT_BASE64`, `NUGET_SIGNING_CERT_PASSWORD` | NuGet push and package signing |
| `GO_MIRROR_TOKEN` (write access to `tomurashigaraki22/watchup-go-sdk`) | Mirroring `go/` and tagging the module |
| Environments `npm`, `npm-canary`, `pypi`, `testpypi`, `nuget`, `go-mirror` with required reviewers on the stable ones | Release approval |

## 1. Prepare

1. Bump the version in the package manifest (`package.json`, `pyproject.toml` + `watchup/_version.py`, `Watchup.csproj` + `WatchupClient.SdkVersion`, `go/watchup.go`).
2. For JS packages run `node tools/release/sync-versions.mjs` (updates `src/version.ts`).
3. Add a `## <version>` section to the package `CHANGELOG.md`, with a **Migration** subsection for any behaviour change.
4. `node tools/release/check-versions.mjs` must pass.

## 2. Canary

Actions → **Release** → Run workflow → package id, channel `canary`.

- npm: `<version>-canary.<run>` under the `canary` dist-tag; Python: `<version>.dev<run>` on TestPyPI.
- Install the canary in the fixture apps (`fixtures/`) and in staging (see [OPERATIONS.md](./OPERATIONS.md)), and watch the canary dashboard for 24 hours: ingest acceptance, `chunk_rejected`/`payload_too_large`, queue age, SDK error rate.

## 3. Stable

Push a tag `<id>-v<version>` (for example `node-v0.3.0`, `python-v2.1.0`, `go-v0.1.0`, `dotnet-v1.1.0`). The workflow checks the tag matches the manifest, publishes with provenance (npm `--provenance`, `actions/attest-build-provenance` for every artifact; NuGet packages are signed and ship a `.snupkg`), creates the GitHub release from the changelog section, and finishes with a clean install from the registry.

Go: `go/` is split with `git subtree` and pushed to `github.com/tomurashigaraki22/watchup-go-sdk` with tag `v<version>`; the workflow waits until `proxy.golang.org` serves it.

Release in dependency order so peer ranges resolve: **browser, node → react, svelte → nextjs → react-native, python, go, dotnet → mcp, create-watchup.**

## 4. Rollback

- npm: `npm dist-tag add @watchupltd/<pkg>@<previous> latest`, then `npm deprecate @watchupltd/<pkg>@<bad> "<reason>; use <previous>"`. Do not unpublish.
- PyPI: yank the release (`Yank` in the project settings) and re-pin docs to the previous version.
- NuGet: unlist the version (`dotnet nuget delete` unlists on nuget.org).
- Go: publish `v<next-patch>` that restores the previous code and add a `retract` directive for the bad version in `go/go.mod`.
- Update [COMPATIBILITY.md](./COMPATIBILITY.md) and the docs site, and post the migration/rollback note in the changelog.

Keep the previous release set's versions in the compatibility matrix until the next release set is stable.
