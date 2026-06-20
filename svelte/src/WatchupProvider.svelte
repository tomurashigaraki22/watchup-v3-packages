<script lang="ts">
  // ─────────────────────────────────────────────────────────────────────────
  // @watchupltd/svelte  ·  WatchupProvider
  //
  // Mount this once near the root of your Svelte/SvelteKit app.
  //
  // @example
  // <!-- +layout.svelte -->
  // <script>
  //   import { WatchupProvider } from '@watchupltd/svelte';
  // </script>
  // <WatchupProvider apiKey="wup_live_xxx">
  //   <slot />
  // </WatchupProvider>
  // ─────────────────────────────────────────────────────────────────────────

  import { onDestroy }              from 'svelte';
  import { Watchup, type WatchupOptions } from '@watchupltd/browser';
  import { _setWatchupContext }     from './context.js';

  export let apiKey:  string;
  export let options: Omit<WatchupOptions, 'apiKey'> = {};

  const instance = new Watchup({ apiKey, ...options });
  _setWatchupContext(instance);

  onDestroy(() => {
    instance.shutdown();
  });
</script>

<slot />
