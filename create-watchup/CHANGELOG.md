# Changelog — create-watchup

## 0.2.0

### Fixed
- The Next.js installer wrote the same key to `NEXT_PUBLIC_WATCHUP_API_KEY` and `WATCHUP_API_KEY`, which could ship a secret `wup_live_` key to browsers. Keys now go only to the matching variable.
- Generated Express/Node files registered SIGTERM/SIGINT handlers that flushed without exiting; the SDK handles signals itself now.
- The layout patch could add a second provider; an existing `WatchupProvider`/`WatchupInit` or instrumentation file is left alone.

### Added
- SvelteKit installer.
- Fails fast for Python, Go, .NET and unsupported JS frameworks, with the right next step.
- Verifies that packages are published on npm before writing any files (`--skip-verify` to bypass).
- Browser frameworks refuse a secret `wup_live_` key.
