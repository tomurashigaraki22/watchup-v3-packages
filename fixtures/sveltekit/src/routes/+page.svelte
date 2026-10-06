<script>
  import { trackClick, flag } from '@watchupltd/svelte';
  const beta = flag('beta');
</script>

<h1>WatchUp SvelteKit fixture</h1>
<button use:trackClick={{ event: 'fixture.clicked' }}>Track</button>
{#if $beta}<p>beta</p>{/if}
