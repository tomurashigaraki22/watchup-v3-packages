import { env } from '$env/dynamic/private';
import { Watchup } from '@watchupltd/node';
import { watchupHandle, watchupHandleError } from '@watchupltd/svelte/server';

const watchup = new Watchup({
  apiKey: env.WATCHUP_API_KEY || 'wup_live_placeholder',
  flagRefreshInterval: 0,
  handleSignals: false,
});

export const handle = watchupHandle(watchup);
export const handleError = watchupHandleError(watchup);
