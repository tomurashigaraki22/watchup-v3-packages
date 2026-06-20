export { getWatchup }       from './context.js';
export { trackClick, traceAction } from './action.js';

// WatchupProvider is a .svelte file — imported directly by consumers
// e.g. import WatchupProvider from '@watchupltd/svelte/WatchupProvider.svelte'

export type {
  WatchupOptions,
  TracePayload,
  ErrorPayload,
  EventPayload,
} from '@watchupltd/browser';
