<script>
  import WatchupProvider from '../src/WatchupProvider.svelte';
  import Child from './Child.svelte';

  export let apiKey = 'wup_pub_svelte';
  export let show = true;
</script>

<WatchupProvider
  {apiKey}
  options={{ baseUrl: 'https://ingest.test', flushInterval: 60000, flagRefreshInterval: 0, autoCapture: { pageViews: false, performance: false } }}
>
  {#if show}
    <Child />
  {/if}
</WatchupProvider>
