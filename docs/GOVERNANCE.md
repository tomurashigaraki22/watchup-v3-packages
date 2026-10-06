# Governance

Ownership, support and release policies for the WatchUp SDKs (SDK plan Phase A.4).

## Owners

| Area | Owner | Backup |
| --- | --- | --- |
| Contract (`spec/`, `core/`, `tools/`) | @tomurashigaraki22 | — |
| JavaScript SDKs (browser, node, react, nextjs, svelte, react-native) | @tomurashigaraki22 | — |
| MCP server, setup CLI | @tomurashigaraki22 | — |
| Python, Go, .NET | @tomurashigaraki22 | — |

[`.github/CODEOWNERS`](../.github/CODEOWNERS) enforces review. Add a backup owner per area before the first stable release of each package line; a single owner is a bus-factor risk.

## Supported runtimes

The current list is in [COMPATIBILITY.md](./COMPATIBILITY.md). Policy:

- Support every runtime version that is still maintained upstream (Node LTS lines, CPython versions in security support, the last three Go releases, .NET LTS + STS).
- Drop a runtime only in a minor release, announced in the previous release's changelog.
- Framework majors (React, Next, Svelte, Express, Django…) are added within one month of their stable release.

## Versioning

- Semantic versioning per package. While a package is `0.x`, a minor bump may contain breaking changes, and the changelog must have a **Migration** section.
- The transport contract has its own version (`CONTRACT_VERSION`). A contract change ships in every SDK in the same release set and is documented in [COMPATIBILITY.md](./COMPATIBILITY.md).
- `tools/release/check-versions.mjs` fails CI if a package version, its compiled-in `sdk.version`, its changelog or a peer range disagree.

## Release cadence

- **Canary:** on demand from `main`, for fixture and staging testing (`<version>-canary.<run>`, npm `canary` tag, TestPyPI, GitHub prerelease).
- **Stable:** every two weeks when there are changes, or immediately for security fixes. A stable release requires a canary that ran in the fixture apps and in staging for at least 24 hours (see [RELEASING.md](./RELEASING.md)).

## Deprecation

1. Mark the API deprecated in code (JSDoc `@deprecated`, Python `DeprecationWarning`, `[Obsolete]`, Go `// Deprecated:`) and in the changelog.
2. Keep it working for at least two minor releases or 6 months, whichever is longer.
3. Remove it only in a major release (or a `0.x` minor with a Migration section).

## Security

Report vulnerabilities privately through GitHub's **Report a vulnerability** (Security Advisories) on this repository — enable private vulnerability reporting in the repository settings. Fixes are released as patch versions of every affected line and noted in the changelog after the release.
