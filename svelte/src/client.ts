// ─────────────────────────────────────────────────────────────────────────────
// @watchupltd/svelte  ·  SSR-safe lazy client
//
// The provider must set context synchronously during component init, but the
// browser client can only be created in the browser (onMount). The handle
// below is what goes into context: it forwards to the real client once it
// exists, buffers early captures until then, and is a no-op during SSR —
// so nothing is sent from the server or twice during hydration.
// ─────────────────────────────────────────────────────────────────────────────

import { Watchup, type FlagContext, type WatchupOptions, type WatchupUser } from '@watchupltd/browser';

const MAX_BUFFERED = 100;

type Call = (client: Watchup) => void;
type EndTrace = ReturnType<Watchup['startTrace']>;

export class WatchupHandle {
  private client: Watchup | null = null;
  private buffer: Call[] = [];
  private flagListeners = new Set<() => void>();
  private unsubscribeFlags: (() => void) | null = null;

  /** Create the browser client. Called from the provider's onMount. */
  start(options: WatchupOptions): Watchup {
    if (this.client) return this.client;
    const client = new Watchup(options);
    this.client = client;
    this.unsubscribeFlags = client.onFlagsChange(() => {
      for (const fn of this.flagListeners) fn();
    });
    for (const call of this.buffer.splice(0)) call(client);
    return client;
  }

  async stop(): Promise<void> {
    this.unsubscribeFlags?.();
    const client = this.client;
    this.client = null;
    await client?.shutdown();
  }

  /** The underlying client, or null during SSR / before mount. */
  get current(): Watchup | null {
    return this.client;
  }

  private run(call: Call): void {
    if (this.client) call(this.client);
    else if (typeof window !== 'undefined' && this.buffer.length < MAX_BUFFERED) this.buffer.push(call);
  }

  setUser(user: WatchupUser): void {
    this.run((c) => c.setUser(user));
  }

  clearUser(): void {
    this.run((c) => c.clearUser());
  }

  track(name: string, properties?: Record<string, unknown>): void {
    this.run((c) => c.track(name, properties));
  }

  trackWebView(overrides?: Parameters<Watchup['trackWebView']>[0]): void {
    this.run((c) => c.trackWebView(overrides));
  }

  captureError(error: unknown, context?: Parameters<Watchup['captureError']>[1]): void {
    this.run((c) => c.captureError(error, context));
  }

  captureLog(message: string, context?: Parameters<Watchup['captureLog']>[1]): void {
    this.run((c) => c.captureLog(message, context));
  }

  startTrace(span: string, options?: Parameters<Watchup['startTrace']>[1]): EndTrace {
    if (this.client) return this.client.startTrace(span, options);
    // Not started yet (e.g. an action on a child that mounts before the
    // provider): keep the real start time and send once the client exists.
    const startTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
    return (opts) => this.run((c) => c.startTrace(span, { ...options, startTime })(opts));
  }

  isEnabled(key: string, ctx?: FlagContext): boolean {
    return this.client?.isEnabled(key, ctx) ?? false;
  }

  getVariant(key: string, ctx?: FlagContext): string {
    return this.client?.getVariant(key, ctx) ?? 'control';
  }

  onFlagsChange(listener: () => void): () => void {
    this.flagListeners.add(listener);
    return () => this.flagListeners.delete(listener);
  }

  async flush(): Promise<void> {
    await this.client?.flush();
  }
}
