import { SvelteComponent } from 'svelte';
import type { WatchupOptions } from '@watchupltd/browser';

export interface WatchupProviderProps {
  /** Your public project key (wup_pub_…). */
  apiKey: string | undefined;
  options?: Omit<WatchupOptions, 'apiKey'>;
}

export default class WatchupProvider extends SvelteComponent<
  WatchupProviderProps,
  Record<string, never>,
  { default: Record<string, never> }
> {}
