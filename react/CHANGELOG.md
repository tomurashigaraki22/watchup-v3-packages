# Changelog — @watchupltd/react

## 0.3.0

### Added
- StrictMode-safe client registry: one browser client per key, kept alive across development remounts and shut down after the last provider unmounts.
- Server rendering gets a no-op client, so hooks never throw during SSR. `createNoopWatchup()` is exported.
- `usePageView(path)` for router integrations; a `client` prop to pass your own instance.
- `useFlag`/`useVariant` re-render when the flag cache refreshes (no 5-second polling).

### Changed (migration)
- `WatchupErrorBoundary` without a `fallback` now captures the error and re-throws it to the next boundary, preserving React's normal error flow. Previously it rendered a built-in "Something went wrong" block; pass `fallback` to keep a UI.
- `fallback` functions receive `(error, reset)`.
- Requires `@watchupltd/browser` ^0.3.0.
