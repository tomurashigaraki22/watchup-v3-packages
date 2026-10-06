# @watchupltd/svelte

Official Watchup SDK for **Svelte 4/5 and SvelteKit**: an SSR-safe provider, actions, flag stores, and SvelteKit server/client hooks.

## Install

```bash
npm install @watchupltd/svelte @watchupltd/browser
npm install @watchupltd/node   # for SvelteKit server hooks
```

## Provider

```svelte
<!-- src/routes/+layout.svelte -->
<script>
  import WatchupProvider from '@watchupltd/svelte/WatchupProvider.svelte';
  import { PUBLIC_WATCHUP_API_KEY } from '$env/static/public';
</script>

<WatchupProvider apiKey={PUBLIC_WATCHUP_API_KEY}>
  <slot />
</WatchupProvider>
```

The browser client starts in `onMount`, so nothing runs or is sent during server rendering and hydration never double-sends. Calls made before mount (in child components' scripts) are buffered and replayed. The component is plain JavaScript, so no TypeScript preprocessor is required.

## In components

```svelte
<script>
  import { getWatchup, trackClick, traceAction, flag, identify } from '@watchupltd/svelte';

  const watchup = getWatchup();
  const newCheckout = flag('new-checkout'); // store, updates on refresh
  identify({ id: '42' });
  let done;
</script>

<button use:trackClick={{ event: 'cta.clicked', properties: { variant: 'A' } }}>Get started</button>
<div use:traceAction={{ span: 'dashboard load', onDone: (fn) => (done = fn) }}>…</div>
{#if $newCheckout}<NewCheckout />{/if}
```

`traceAction` records the trace when `done()` is called, or as cancelled if the element is destroyed first.

## SvelteKit hooks

```ts
// src/hooks.server.ts
import { env } from '$env/dynamic/private';
import { Watchup } from '@watchupltd/node';
import { watchupHandle, watchupHandleError } from '@watchupltd/svelte/server';

const watchup = new Watchup({ apiKey: env.WATCHUP_API_KEY });
export const handle = watchupHandle(watchup);           // traces with route IDs, request-scoped users
export const handleError = watchupHandleError(watchup); // 5xx errors only
```

```ts
// src/hooks.client.ts
import { watchupHandleClientError } from '@watchupltd/svelte';
export const handleError = watchupHandleClientError();
```

## Links

- [Svelte SDK docs](https://watchup.site/docs/sdks/svelte) · [Changelog](./CHANGELOG.md) · [Fixture app](../fixtures/sveltekit)

## License

MIT © Watchup Ltd
