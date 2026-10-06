export { getWatchup, _createWatchupContext, _getActive, _setActive } from './context.js';
export { WatchupHandle } from './client.js';
export { trackClick, traceAction } from './action.js';
export type { TrackClickParams, TraceActionParams } from './action.js';
export { identify, clearUser } from './identify.js';
export { isFlagEnabled, getFlagVariant, flag, variant } from './flags.js';
export { watchupHandleClientError } from './hooks-client.js';
export { SDK_NAME, SDK_VERSION } from './version.js';

// WatchupProvider is a .svelte component:
//   import WatchupProvider from '@watchupltd/svelte/WatchupProvider.svelte';
// SvelteKit server hooks live in '@watchupltd/svelte/server'.

export type {
  WatchupOptions,
  WatchupUser,
  TracePayload,
  ErrorPayload,
  EventPayload,
  FlagContext,
} from '@watchupltd/browser';
