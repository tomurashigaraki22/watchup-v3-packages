<script>
  // ─────────────────────────────────────────────────────────────────────────
  // @watchupltd/svelte  ·  WatchupProvider
  //
  // Mount once near the root of your Svelte/SvelteKit app. SSR-safe: the
  // browser client is created in onMount, so nothing runs or is sent on the
  // server, and hydration never sends duplicates.
  //
  // Usage (+layout.svelte): import WatchupProvider from
  // '@watchupltd/svelte/WatchupProvider.svelte' and wrap the page slot in
  // <WatchupProvider apiKey={PUBLIC_WATCHUP_API_KEY}>. See README.md.
  // (No literal script tags here: they would end this block early.)
  // ─────────────────────────────────────────────────────────────────────────

  import { onDestroy, onMount } from 'svelte';
  // Self-reference: this file ships as source, so it imports the compiled
  // package entry (same module instance as the app's getWatchup()).
  import { _createWatchupContext, _getActive, _setActive } from '@watchupltd/svelte';

  // Plain JS (types in WatchupProvider.svelte.d.ts) so apps without a
  // TypeScript preprocessor can compile this component.
  /** @type {string | undefined} */
  export let apiKey;
  /** @type {Omit<import('@watchupltd/browser').WatchupOptions, 'apiKey'>} */
  export let options = {};

  const handle = _createWatchupContext();
  // Children (and their actions) mount before this component's onMount, so
  // register the handle now. Browser only: module state on the server would
  // leak between requests.
  if (typeof window !== 'undefined') _setActive(handle);

  onMount(() => {
    if (!apiKey) {
      console.warn('[watchup] Monitoring is disabled because <WatchupProvider> has no apiKey.');
      return;
    }
    handle.start({ ...options, apiKey });
  });

  onDestroy(() => {
    if (_getActive() === handle) _setActive(null);
    void handle.stop();
  });
</script>

<slot />
