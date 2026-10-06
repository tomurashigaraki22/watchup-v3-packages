# Changelog — @watchupltd/svelte

## 0.3.0

### Fixed
- `WatchupProvider` created the browser client during component init, which crashed SvelteKit server rendering. It now starts in `onMount`; calls made before mount are buffered, and nothing is sent from the server or twice during hydration.
- `trackClick` and `traceAction` called `getContext()` outside component init and silently did nothing.
- The shipped `WatchupProvider.svelte` had a literal script tag inside a comment and imported a `.ts` file that was not published.
- The component is now plain JavaScript, so apps without a TypeScript preprocessor can compile it.

### Added
- `@watchupltd/svelte/server`: `watchupHandle` and `watchupHandleError` for `hooks.server.ts`, and `watchupHandleClientError` for `hooks.client.ts`.
- `flag()` / `variant()` stores; `identify`, `clearUser`, `isFlagEnabled` and `getFlagVariant` exported from the root.
- `traceAction` records a cancelled trace when the element is destroyed first.

### Migration
- `getWatchup()` returns a `WatchupHandle` (same capture methods; `handle.current` is the underlying client once mounted).
