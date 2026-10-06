# Changelog — @watchupltd/nextjs

## 0.3.0

### Added
- `registerWatchup()` for `instrumentation.ts` (initialises once, Node.js runtime only) and `captureRequestError` for Next 15's `onRequestError`.
- `withWatchupApi()` for the Pages Router; a `route` option on both wrappers for template grouping.
- Route handlers run in a request context, so `setUser()` is per request; traces record the real status code.

### Fixed
- The client provider created a second client under StrictMode; it now uses the shared React registry.
- `useSearchParams` is wrapped in Suspense, so static pages build.
- `notFound()`/`redirect()` are no longer reported as errors.
- The server singleton survives HMR and duplicated module instances (stored on `globalThis`).

### Changed
- `@watchupltd/nextjs/server` throws a clear error on the Edge runtime instead of failing later.
- Requires `@watchupltd/browser`, `@watchupltd/react` and `@watchupltd/node` ^0.3.0.
