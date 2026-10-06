<script>
  import { getWatchup, trackClick, traceAction, flag, identify } from '@watchupltd/svelte';

  const watchup = getWatchup();
  // Called during init, before the provider's onMount: must be buffered.
  identify({ id: 'svelte-user' });
  watchup.track('child.init');
  const beta = flag('beta');

</script>

<button id="cta" use:trackClick={{ event: 'cta.clicked', properties: { variant: 'A' } }}>Go</button>
<div use:traceAction={{ span: 'panel load', onDone: (fn) => (window.__watchupDone = fn) }}>panel</div>
<span id="flag">{$beta ? 'on' : 'off'}</span>
