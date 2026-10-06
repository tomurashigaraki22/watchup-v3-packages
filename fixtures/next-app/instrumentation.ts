import { registerWatchup } from '@watchupltd/nextjs/server';

// Called once per runtime; WatchUp only initialises on Node.js.
export function register() {
  registerWatchup({ apiKey: process.env.WATCHUP_API_KEY, release: 'fixture' });
}

export { captureRequestError as onRequestError } from '@watchupltd/nextjs/server';
