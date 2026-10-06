<script>
  import WatchupProvider from '@watchupltd/svelte/WatchupProvider.svelte';
  import { env } from '$env/dynamic/public';
</script>

<WatchupProvider apiKey={env.PUBLIC_WATCHUP_API_KEY}>
  <slot />
</WatchupProvider>
