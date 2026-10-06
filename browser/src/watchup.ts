// ─────────────────────────────────────────────────────────────────────────────
// @watchupltd/browser  ·  Watchup client
// ─────────────────────────────────────────────────────────────────────────────

import {
  DEFAULT_BASE_URL,
  DeliveryQueue,
  FlagStore,
  LIMITS,
  defaultSetInterval,
  parseFlagsResponse,
  uuid,
  type Cancel,
  type Diagnostic,
  type EnvelopeBase,
  type FlagContext,
  type FlushResult,
} from '@watchupltd/core';
import type {
  ErrorPayload,
  EventPayload,
  LogContext,
  LogLevel,
  LoggingOptions,
  TracePayload,
  WatchupOptions,
  WatchupUser,
  WebAnalyticsPayload,
} from './types.js';
import { Transport } from './transport.js';
import { WebQueue } from './web-queue.js';
import { captureGlobalErrors } from './error-capture.js';
import { captureWebVitals } from './perf.js';
import { onLocationChange } from './history.js';
import { forgetUnsent, saveUnsent, takeUnsent } from './unsent.js';
import { SDK_NAME, SDK_VERSION } from './version.js';

const DEFAULTS = {
  baseUrl: DEFAULT_BASE_URL,
  flushInterval: 5_000,
  maxBatchSize: LIMITS.MAX_CHUNK_ITEMS,
  maxQueueSize: LIMITS.MAX_QUEUE_ITEMS,
  debug: false,
  environment: 'production',
  release: '',
  sampleRate: 1,
  flagRefreshInterval: 30_000,
  autoCapture: {
    errors: true,
    performance: true,
    pageViews: true,
  },
  logging: {
    enabled: false,
    captureConsole: false,
    includeDeviceContext: false,
    minLevel: 'debug',
  },
} as const;

const LOG_LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10, info: 20, warning: 30, error: 40, critical: 50,
};

/** Errors already reported, so a boundary + window.onerror report once. */
const captured = new WeakSet<object>();

const VISITOR_KEY = '__wup_vid';
const SESSION_KEY = '__wup_sid';

type ResolvedOptions = Required<Omit<WatchupOptions, 'onDiagnostic' | 'redactKeys' | 'service'>> & {
  logging: Required<LoggingOptions>;
  autoCapture: Required<NonNullable<WatchupOptions['autoCapture']>>;
  onDiagnostic?: (d: Diagnostic) => void;
  redactKeys?: string[];
  service?: string;
};

type EndTrace = (opts?: { status?: TracePayload['status']; meta?: Record<string, unknown> }) => void;

export class Watchup {
  /** Random ID for this page load — correlates everything one tab sends. */
  readonly sessionId: string = uuid();

  private readonly cfg: ResolvedOptions;
  private readonly queue: DeliveryQueue;
  private readonly web: WebQueue;
  private readonly transport: Transport;
  private readonly flags = new FlagStore();
  private readonly cleanup: Array<() => void> = [];
  private readonly warn: (...args: unknown[]) => void;
  private readonly visitorId: string;
  private readonly webSessionId: string;
  private readonly sampled: boolean;
  private user: WatchupUser | null = null;
  private stopTimer: Cancel | null = null;
  private flagsFetchedAt = 0;
  private closed = false;
  private inConsoleCapture = false;

  constructor(options: WatchupOptions) {
    if (!options.apiKey) throw new Error('[watchup] apiKey is required.');
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      throw new Error(
        '[watchup] @watchupltd/browser can only run in a browser. ' +
        'Create the client inside an effect/onMount, or use @watchupltd/node on the server.',
      );
    }

    this.cfg = {
      ...DEFAULTS,
      ...stripUndefined(options),
      autoCapture: { ...DEFAULTS.autoCapture, ...stripUndefined(options.autoCapture ?? {}) },
      logging: { ...DEFAULTS.logging, ...stripUndefined(options.logging ?? {}) },
    } as ResolvedOptions;

    // Keep a reference to the real console so SDK warnings never loop through
    // console capture.
    const realWarn = console.warn.bind(console);
    this.warn = (...args) => {
      if (this.cfg.debug) realWarn(...args);
    };
    if (this.cfg.apiKey.startsWith('wup_live_')) {
      realWarn('[watchup] A secret wup_live_ key was passed to the browser SDK. Use your public wup_pub_ key in client-side code.');
    }

    const publicKey = this.cfg.apiKey.startsWith('wup_live_') ? undefined : this.cfg.apiKey;
    this.transport = new Transport(this.cfg.baseUrl, this.cfg.apiKey, this.warn);
    this.web = new WebQueue(publicKey, Math.min(this.cfg.maxBatchSize, LIMITS.MAX_CHUNK_ITEMS));
    this.queue = new DeliveryQueue({
      send: (chunk) => this.transport.send(chunk),
      base: () => this.envelopeBase(publicKey),
      maxItems: this.cfg.maxBatchSize,
      maxQueueItems: this.cfg.maxQueueSize,
      ...(this.cfg.redactKeys && { normalize: { redactKeys: this.cfg.redactKeys } }),
      onDiagnostic: (d) => this.diagnostic(d),
    });

    this.visitorId = this.storedId(() => localStorage, VISITOR_KEY, uuid);
    this.webSessionId = this.storedId(() => sessionStorage, SESSION_KEY, () => this.sessionId);
    this.sampled = this.cfg.sampleRate >= 1 || Math.random() < this.cfg.sampleRate;

    this.stopTimer = defaultSetInterval(() => void this.flush(), this.cfg.flushInterval);
    this.setupAutoCapture();
    this.setupConsoleCapture();
    // Registered after Web Vitals so final vitals are queued before the drain.
    this.setupUnloadFlush();
    this.setupFlags();
  }

  // ── Identity ──────────────────────────────────────────────────────────────

  /**
   * Attach a user to all subsequent errors, traces, logs and events.
   * Persists until `clearUser()` or page reload.
   *
   * @example
   * watchup.setUser({ id: '42', email: 'ada@example.com', name: 'Ada Lovelace' });
   */
  setUser(user: WatchupUser): void {
    this.user = { ...user };
  }

  /** Remove the current user context (e.g. after logout). */
  clearUser(): void {
    this.user = null;
  }

  // ── Capture ───────────────────────────────────────────────────────────────

  /**
   * Track a custom analytics event.
   *
   * @example
   * watchup.track('button.clicked', { label: 'Sign Up', variant: 'A' });
   */
  track(name: string, properties?: Record<string, unknown>): void {
    if (!name || this.closed) return;
    const event: EventPayload = {
      name,
      properties: {
        source: 'browser',
        route: window.location.pathname,
        session_id: this.sessionId,
        ...(this.cfg.service && { service: this.cfg.service }),
        ...(this.user && { user: this.user }),
        ...properties,
      },
      occurred_at: new Date().toISOString(),
    };
    this.queue.enqueue('events', event as unknown as Record<string, unknown>);
  }

  /**
   * Track a web analytics page view (or custom web event), enriched with
   * visitor context, UTM parameters and screen info. Normally automatic.
   *
   * @example
   * watchup.trackWebView({ event_name: 'conversion', path: '/checkout/success' });
   */
  trackWebView(overrides: Partial<WebAnalyticsPayload> = {}): void {
    if (this.closed) return;
    const url = new URL(window.location.href);
    const params = url.searchParams;
    const payload: WebAnalyticsPayload = {
      path: url.pathname + (url.search || ''),
      hostname: url.hostname,
      referrer: document.referrer || undefined,
      title: document.title || undefined,
      screen_w: window.screen?.width,
      screen_h: window.screen?.height,
      lang: navigator.language || undefined,
      timezone: timezone(),
      utm_source: params.get('utm_source') || undefined,
      utm_medium: params.get('utm_medium') || undefined,
      utm_campaign: params.get('utm_campaign') || undefined,
      utm_term: params.get('utm_term') || undefined,
      utm_content: params.get('utm_content') || undefined,
      visitor_id: this.visitorId,
      session_id: this.webSessionId,
      event_name: 'pageview',
      occurred_at: new Date().toISOString(),
      ...overrides,
    };
    if (this.web.add(payload)) void this.flushWeb();
  }

  /**
   * Manually capture an error. Route, URL, device and user context are
   * recorded now, not when the batch is sent.
   *
   * @example
   * try { ... } catch (err) {
   *   watchup.captureError(err, { component: 'CheckoutForm' });
   * }
   */
  captureError(
    error: Error | string | unknown,
    context?: Record<string, unknown> & { route?: string; level?: ErrorPayload['level'] },
  ): void {
    if (this.closed) return;
    if (error && typeof error === 'object') {
      if (captured.has(error)) return;
      captured.add(error);
    }
    const { route, level = 'error', context: nested, ...rest } = context ?? {};
    const err = error instanceof Error ? error : new Error(typeof error === 'string' ? error : safeString(error));

    const payload: ErrorPayload = {
      message: err.message || String(error),
      type: err.name || 'Error',
      level,
      ...(err.stack !== undefined && { stack: err.stack }),
      route: route ?? window.location.pathname,
      context: {
        ...(nested && typeof nested === 'object' ? (nested as Record<string, unknown>) : {}),
        ...rest,
        ...this.captureContext(),
        device: this.deviceContext(),
      },
      timestamp: new Date().toISOString(),
      environment: this.cfg.environment,
      ...(this.cfg.release && { release: this.cfg.release }),
      ...(this.user && { user: this.user }),
    };
    this.queue.enqueue('errors', payload as unknown as Record<string, unknown>);
  }

  /**
   * Send an opt-in structured browser log. Logs use the events stream so they
   * never increase the project's error count or trigger error-rate alerts.
   */
  captureLog(message: string, context: LogContext = {}): void {
    const { level = 'info', route, ...rest } = context;
    if (this.closed || !this.cfg.logging.enabled) return;
    if (LOG_LEVEL_WEIGHT[level] < LOG_LEVEL_WEIGHT[this.cfg.logging.minLevel]) return;

    const properties: Record<string, unknown> = {
      ...rest,
      message,
      level,
      ...this.captureContext(),
      route: route ?? window.location.pathname,
      ...(this.user && { user: this.user }),
    };
    if (this.cfg.logging.includeDeviceContext) properties.device = this.deviceContext();

    this.queue.enqueue('events', { name: `log.${level}`, properties, occurred_at: new Date().toISOString() });
  }

  /**
   * Time any operation and record it as a trace. Returns `end()`.
   *
   * @example
   * const end = watchup.startTrace('fetch /api/cart');
   * const cart = await fetch('/api/cart');
   * end({ status: cart.ok ? 'ok' : 'err' });
   */
  startTrace(span: string, options: { type?: TracePayload['type']; startTime?: number } = {}): EndTrace {
    // `startTime` (a performance.now() value) lets wrappers that buffer calls
    // keep the real start of the operation.
    const start = options.startTime ?? now();
    const startedAt = new Date(Date.now() - (now() - start)).toISOString();
    const route = window.location.pathname;
    const user = this.user;
    let ended = false;
    return (opts = {}) => {
      if (ended || this.closed) return;
      ended = true;
      const status = opts.status ?? 'ok';
      const trace: TracePayload = {
        span,
        type: options.type ?? 'custom',
        ms: Math.round((now() - start) * 100) / 100,
        status_code: status === 'err' ? 500 : status === 'warn' ? 400 : 200,
        status,
        timestamp: startedAt,
        environment: this.cfg.environment,
        ...(this.cfg.release && { release: this.cfg.release }),
        meta: { ...opts.meta, ...this.captureContext(), route },
        ...(user && { user }),
      };
      this.queue.enqueue('traces', trace as unknown as Record<string, unknown>);
    };
  }

  // ── Feature flags ─────────────────────────────────────────────────────────

  /**
   * Whether a feature flag is enabled. Evaluated locally from a cache that
   * refreshes every 30 s. Falls back to the identified user, then the visitor.
   *
   * @example
   * if (watchup.isEnabled('new-checkout')) renderNewCheckout();
   */
  isEnabled(key: string, ctx: FlagContext = {}): boolean {
    return this.flags.isEnabled(key, this.flagContext(ctx), this.visitorId);
  }

  /**
   * Variant key for a multivariate flag; `"control"` when off or not in rollout.
   *
   * @example
   * const variant = watchup.getVariant('pricing-layout');
   */
  getVariant(key: string, ctx: FlagContext = {}): string {
    return this.flags.getVariant(key, this.flagContext(ctx), this.visitorId);
  }

  /** Subscribe to flag cache refreshes (used by framework hooks). */
  onFlagsChange(listener: () => void): () => void {
    return this.flags.subscribe(listener);
  }

  /** Fetch flags now instead of waiting for the next poll. */
  async refreshFlags(): Promise<void> {
    try {
      const res = await fetch(`${this.cfg.baseUrl.replace(/\/+$/, '')}/api/v1/flags`, {
        headers: { Authorization: `Bearer ${this.cfg.apiKey}`, 'X-Api-Key': this.cfg.apiKey },
      });
      if (!res.ok) return;
      const flags = parseFlagsResponse(await res.json());
      if (flags) {
        this.flags.replace(flags);
        this.flagsFetchedAt = Date.now();
      }
    } catch {
      // Keep serving the cached flags.
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /** True after `shutdown()`; a closed client ignores new captures. */
  get isClosed(): boolean {
    return this.closed;
  }

  /** Send everything queued now. Resolves when the attempt finishes; never rejects. */
  async flush(): Promise<FlushResult> {
    const [result] = await Promise.all([this.queue.flush(), this.flushWeb()]);
    return result;
  }

  /** Stop timers and listeners, then deliver what is queued (up to 2 s). */
  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stopTimer?.();
    for (const fn of this.cleanup.splice(0)) fn();
    await Promise.all([this.queue.shutdown(2_000), this.flushWeb()]);
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private envelopeBase(publicKey: string | undefined): EnvelopeBase {
    return {
      sdk: { name: SDK_NAME, version: SDK_VERSION },
      environment: this.cfg.environment,
      ...(this.cfg.release && { release: this.cfg.release }),
      ...(publicKey && { project_id: publicKey }),
    };
  }

  private captureContext(): Record<string, unknown> {
    return {
      source: 'browser',
      url: window.location.href,
      session_id: this.sessionId,
      ...(this.cfg.service && { service: this.cfg.service }),
    };
  }

  private deviceContext(): Record<string, unknown> {
    return {
      user_agent: navigator.userAgent,
      language: navigator.language,
      timezone: timezone(),
      viewport: { width: window.innerWidth, height: window.innerHeight },
      screen: { width: window.screen?.width, height: window.screen?.height },
    };
  }

  private flagContext(ctx: FlagContext): FlagContext {
    return { userId: this.user?.id, email: this.user?.email, ...ctx };
  }

  private async flushWeb(): Promise<void> {
    for (const batch of this.web.drain()) await this.transport.sendWeb(batch);
  }

  private diagnostic(d: Diagnostic): void {
    this.warn(`[watchup] ${d.type}: ${d.message}`);
    try {
      this.cfg.onDiagnostic?.(d);
    } catch {
      // User handler errors are ignored.
    }
  }

  private setupAutoCapture(): void {
    const { autoCapture } = this.cfg;

    if (autoCapture.errors) {
      this.cleanup.push(
        captureGlobalErrors(({ error, message, context }) => {
          this.captureError(error instanceof Error ? error : message, { ...context });
        }),
      );
    }

    if (autoCapture.performance && this.sampled) {
      this.cleanup.push(
        captureWebVitals(({ span, value, status, meta }) => {
          if (this.closed) return;
          this.queue.enqueue('traces', {
            span,
            type: 'custom',
            ms: value,
            status_code: status === 'err' ? 500 : status === 'warn' ? 400 : 200,
            status,
            timestamp: new Date().toISOString(),
            environment: this.cfg.environment,
            ...(this.cfg.release && { release: this.cfg.release }),
            meta: { ...meta, ...this.captureContext(), route: window.location.pathname },
          });
        }),
      );
    }

    if (autoCapture.pageViews) {
      if (document.readyState === 'loading') {
        const initial = () => this.trackWebView();
        document.addEventListener('DOMContentLoaded', initial, { once: true });
        this.cleanup.push(() => document.removeEventListener('DOMContentLoaded', initial));
      } else {
        setTimeout(() => this.trackWebView(), 0);
      }
      // Small delay so the page title has settled after navigation.
      this.cleanup.push(onLocationChange(() => setTimeout(() => this.trackWebView(), 0)));
    }
  }

  private setupUnloadFlush(): void {
    const unload = () => {
      for (const chunk of this.queue.takeAll(LIMITS.BEACON_MAX_BYTES)) {
        if (this.transport.beaconChunk(chunk)) continue;
        // Over the browser's in-flight budget: keep it for the next page, and
        // still try a keepalive fetch in case the page survives (tab switch).
        const stored = saveUnsent(chunk);
        void this.transport.send(chunk).then((res) => {
          if (res.ok) forgetUnsent(chunk.idempotencyKey);
        });
        if (!stored) {
          this.diagnostic({
            type: 'undelivered_on_shutdown',
            message: 'The browser refused to send a batch during page unload and it could not be stored.',
            details: { items: chunk.counts.errors + chunk.counts.traces + chunk.counts.events },
          });
        }
      }
      for (const batch of this.web.drain()) this.transport.sendWebOnUnload(batch);
    };
    const onHidden = () => {
      if (document.visibilityState === 'hidden') {
        unload();
        return;
      }
      this.resendUnsent();
      if (Date.now() - this.flagsFetchedAt > this.cfg.flagRefreshInterval && this.cfg.flagRefreshInterval > 0) {
        void this.refreshFlags();
      }
    };
    // Chunks a previous page could not send.
    this.resendUnsent();
    document.addEventListener('visibilitychange', onHidden);
    window.addEventListener('pagehide', unload);
    this.cleanup.push(() => {
      document.removeEventListener('visibilitychange', onHidden);
      window.removeEventListener('pagehide', unload);
    });
  }

  /** Queue chunks a previous page (or this one, before a tab switch) could not send. */
  private resendUnsent(): void {
    const stored = takeUnsent();
    if (!stored.length) return;
    this.queue.restore({ version: 1, pending: { errors: [], traces: [], events: [] }, retry: stored });
    void this.queue.flush();
  }

  private setupFlags(): void {
    // 0 (or less) turns feature flags off entirely: no requests at all.
    if (this.cfg.flagRefreshInterval <= 0) return;
    void this.refreshFlags();
    const stop = defaultSetInterval(() => {
      // Don't poll from background tabs; refresh when the tab is shown again.
      if (document.visibilityState !== 'hidden') void this.refreshFlags();
    }, this.cfg.flagRefreshInterval);
    this.cleanup.push(stop);
  }

  private setupConsoleCapture(): void {
    if (!this.cfg.logging.enabled || !this.cfg.logging.captureConsole) return;

    const levels: Array<['debug' | 'info' | 'warn' | 'error', LogLevel]> = [
      ['debug', 'debug'],
      ['info', 'info'],
      ['warn', 'warning'],
      ['error', 'error'],
    ];

    for (const [method, level] of levels) {
      const original = console[method] as (...args: unknown[]) => void;
      let active = true;
      const wrapped = (...args: unknown[]) => {
        original.apply(console, args);
        if (!active || this.inConsoleCapture) return;
        this.inConsoleCapture = true;
        try {
          this.captureLog(consoleMessage(args), { level, console: true });
        } finally {
          this.inConsoleCapture = false;
        }
      };
      (console[method] as (...args: unknown[]) => void) = wrapped;
      this.cleanup.push(() => {
        active = false;
        // Only unwrap if nobody wrapped console after us.
        if (console[method] === wrapped) (console[method] as (...args: unknown[]) => void) = original;
      });
    }
  }

  private storedId(storage: () => Storage, key: string, create: () => string): string {
    try {
      const store = storage();
      let id = store.getItem(key);
      if (!id) {
        id = create();
        store.setItem(key, id);
      }
      return id;
    } catch {
      // Storage blocked (private mode, sandboxed iframe) — session scope only.
      return create();
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function now(): number {
  return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
}

function timezone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

function safeString(value: unknown): string {
  try {
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  } catch {
    return String(value);
  }
}

function consoleMessage(args: unknown[]): string {
  return args.map((value) => {
    if (value instanceof Error) return value.message;
    if (typeof value === 'string') return value;
    return safeString(value);
  }).join(' ');
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  const out: Partial<T> = {};
  for (const key of Object.keys(value) as Array<keyof T>) {
    if (value[key] !== undefined) out[key] = value[key];
  }
  return out;
}
