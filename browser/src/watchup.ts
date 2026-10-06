// ─────────────────────────────────────────────────────────────────────────────
// @watchupltd/browser  ·  Watchup client
// ─────────────────────────────────────────────────────────────────────────────

import type {
  WatchupOptions,
  WatchupUser,
  TracePayload,
  ErrorPayload,
  EventPayload,
  WebAnalyticsPayload,
  FeatureFlag,
  FlagContext,
  LogContext,
  LogLevel,
  LoggingOptions,
} from './types.js';
import { Transport }            from './transport.js';
import { Batcher }              from './batcher.js';
import { captureGlobalErrors }  from './error-capture.js';
import { captureFCP, captureLCP, capturePageLoad } from './perf.js';

// ── Flag evaluation helpers ───────────────────────────────────────────────────

function flagBucket(flagKey: string, userId: string): number {
  const str = `${flagKey}:${userId}`;
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash * 33) ^ str.charCodeAt(i)) | 0;
  }
  return (hash >>> 0) % 100;
}

function matchesTargeting(flag: FeatureFlag, ctx: FlagContext): boolean {
  if (!flag.targeting_rules?.length) return true;
  return flag.targeting_rules.every(rule => {
    const val = String(ctx[rule.attribute] ?? '');
    switch (rule.operator) {
      case 'in':       return rule.values.includes(val);
      case 'not_in':   return !rule.values.includes(val);
      case 'contains': return rule.values.some(v => val.includes(v));
      case 'equals':   return rule.values[0] === val;
      default:         return true;
    }
  });
}

const DEFAULTS = {
  baseUrl:       'https://api.watchup.site',
  flushInterval: 5_000,
  maxBatchSize:  100,
  debug:         false,
  environment:   'production',
  release:       '',
  sampleRate:    1,
  autoCapture: {
    errors:      true,
    performance: true,
    pageViews:   true,
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

// ── Storage keys ──────────────────────────────────────────────────────────────

const VISITOR_KEY = '__wup_vid';
const SESSION_KEY = '__wup_sid';

// ─────────────────────────────────────────────────────────────────────────────

export class Watchup {
  private readonly cfg:     Required<WatchupOptions> & { logging: Required<LoggingOptions> };
  private readonly batcher: Batcher;
  private readonly cleanup: Array<() => void> = [];
  private _user: WatchupUser | null = null;

  /**
   * A random UUID generated on init.  Stable for the lifetime of the page —
   * useful for correlating all events from one user session.
   */
  readonly sessionId: string = crypto.randomUUID();

  // ── Visitor / session identity ─────────────────────────────────────────────

  /**
   * Persistent visitor ID.  Stored in localStorage so it survives browser
   * sessions.  Falls back to a per-session UUID when localStorage is blocked.
   * The server hashes this value with SHA-256 before persisting.
   */
  private readonly visitorId: string;

  /**
   * Per-session ID stored in sessionStorage.  Resets on tab close.
   * The server hashes this value before persisting.
   */
  private readonly webSessionId: string;

  // Feature flags
  private _flags: Map<string, FeatureFlag> = new Map();
  private _flagTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: WatchupOptions) {
    if (!options.apiKey) {
      throw new Error('[watchup] apiKey is required.');
    }

    this.cfg = {
      ...DEFAULTS,
      ...options,
      autoCapture: { ...DEFAULTS.autoCapture, ...options.autoCapture },
      logging: { ...DEFAULTS.logging, ...options.logging },
    } as Required<WatchupOptions> & { logging: Required<LoggingOptions> };

    const transport = new Transport(this.cfg.baseUrl, this.cfg.apiKey, this.cfg.debug);
    this.batcher    = new Batcher(transport, this.cfg.flushInterval, this.cfg.maxBatchSize);
    this.batcher.start();

    // Initialise visitor & session IDs
    this.visitorId   = this._getOrCreateVisitorId();
    this.webSessionId = this._getOrCreateSessionId();

    this._setupAutoCapture();
    this._setupConsoleCapture();

    // Fetch flags immediately, then poll every 30 seconds
    this._fetchFlags();
    this._flagTimer = setInterval(() => this._fetchFlags(), 30_000);
    this.cleanup.push(() => {
      if (this._flagTimer) clearInterval(this._flagTimer);
    });
  }

  private async _fetchFlags(): Promise<void> {
    try {
      const res = await fetch(`${this.cfg.baseUrl}/api/v1/flags`, {
        headers: { 'X-Api-Key': this.cfg.apiKey },
      });
      if (!res.ok) return;
      const json = await res.json() as { ok: boolean; data?: { flags: FeatureFlag[] } };
      if (json.ok && json.data?.flags) {
        this._flags.clear();
        for (const flag of json.data.flags) {
          this._flags.set(flag.key, flag);
        }
      }
    } catch {
      // silently ignore — stale cache is fine
    }
  }

  // ── Visitor / session identity helpers ─────────────────────────────────────

  private _getOrCreateVisitorId(): string {
    try {
      let id = localStorage.getItem(VISITOR_KEY);
      if (!id) {
        id = crypto.randomUUID();
        localStorage.setItem(VISITOR_KEY, id);
      }
      return id;
    } catch {
      // localStorage blocked (private mode, etc.) — fall back to session scope
      return crypto.randomUUID();
    }
  }

  private _getOrCreateSessionId(): string {
    try {
      let id = sessionStorage.getItem(SESSION_KEY);
      if (!id) {
        id = crypto.randomUUID();
        sessionStorage.setItem(SESSION_KEY, id);
      }
      return id;
    } catch {
      return this.sessionId; // fallback: correlate with SDK sessionId
    }
  }

  // ── User identification ───────────────────────────────────────────────────

  /**
   * Attach a user to all subsequent errors, traces, and events.
   * Call this after login; the context persists until `clearUser()` or page reload.
   *
   * @example
   * watchup.setUser({ id: '42', email: 'ada@example.com', name: 'Ada Lovelace' });
   */
  setUser(user: WatchupUser): void {
    this._user = { ...user };
  }

  /**
   * Remove the current user context (e.g. after logout).
   */
  clearUser(): void {
    this._user = null;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Track a custom analytics event.
   *
   * @example
   * watchup.track('button.clicked', { label: 'Sign Up', variant: 'A' });
   */
  track(name: string, properties?: Record<string, unknown>): void {
    if (!name) return;
    const event: EventPayload = {
      name,
      ...(properties && Object.keys(properties).length && { properties }),
      occurred_at: new Date().toISOString(),
    };
    this.batcher.addEvent(event);
  }

  /**
   * Track a web analytics page view (or custom web event).
   * Enriches the payload with visitor context, UTM params, and device info.
   *
   * Normally called automatically. Call manually when you need custom event_name.
   *
   * @example
   * watchup.trackWebView({ event_name: 'conversion', path: '/checkout/success' });
   */
  trackWebView(overrides: Partial<WebAnalyticsPayload> = {}): void {
    const url    = new URL(window.location.href);
    const params = url.searchParams;

    const payload: WebAnalyticsPayload = {
      path:        url.pathname + (url.search || ''),
      hostname:    url.hostname,
      referrer:    document.referrer || undefined,
      title:       document.title   || undefined,
      screen_w:    window.screen?.width,
      screen_h:    window.screen?.height,
      lang:        navigator.language || undefined,
      timezone:    this._timezone(),
      // UTM parameters
      utm_source:   params.get('utm_source')   || undefined,
      utm_medium:   params.get('utm_medium')   || undefined,
      utm_campaign: params.get('utm_campaign') || undefined,
      utm_term:     params.get('utm_term')     || undefined,
      utm_content:  params.get('utm_content')  || undefined,
      // Identity (raw; the server hashes before storing)
      visitor_id:  this.visitorId,
      session_id:  this.webSessionId,
      event_name:  'pageview',
      occurred_at: new Date().toISOString(),
      // Apply caller overrides last
      ...overrides,
    };

    this.batcher.addWebView(payload);
  }

  /**
   * Manually capture an error.
   *
   * @example
   * try { ... } catch (err) {
   *   watchup.captureError(err, { component: 'CheckoutForm' });
   * }
   */
  captureError(
    error:    Error | string | unknown,
    context?: Record<string, unknown> & { route?: string; level?: ErrorPayload['level'] },
  ): void {
    const { route, level = 'error', ...rest } = context ?? {};
    const err = error instanceof Error ? error : new Error(String(error));

    const payload: ErrorPayload = {
      message: err.message,
      level,
      ...(err.stack !== undefined && { stack: err.stack }),
      route:   route ?? window.location.pathname,
      ...(Object.keys(rest).length && {
        context: { ...rest, url: window.location.href },
      }),
      timestamp:   new Date().toISOString(),
      environment: this.cfg.environment,
      ...(this.cfg.release && { release: this.cfg.release }),
      ...(this._user        && { user: this._user }),
    };

    this.batcher.addError(payload);
  }

  /**
   * Send an opt-in structured browser log. Logs use the events stream so they
   * never increase the project's error count or trigger error-rate alerts.
   */
  captureLog(message: string, context: LogContext = {}): void {
    const { level = 'info', route, ...rest } = context;
    if (!this.cfg.logging.enabled || LOG_LEVEL_WEIGHT[level] < LOG_LEVEL_WEIGHT[this.cfg.logging.minLevel]) return;

    const properties: Record<string, unknown> = {
      message,
      level,
      source: 'browser',
      route: route ?? window.location.pathname,
      url: window.location.href,
      ...(this._user && { user: this._user }),
      ...rest,
    };
    if (this.cfg.logging.includeDeviceContext) properties.device = this._deviceContext();

    this.batcher.addEvent({
      name: `log.${level}`,
      properties,
      occurred_at: new Date().toISOString(),
    });
  }

  /**
   * Time any async operation and record it as a trace.
   * Returns an `end()` function — call it when the operation finishes.
   *
   * @example
   * const end = watchup.startTrace('fetch /api/cart');
   * const cart = await fetch('/api/cart');
   * end({ status: cart.ok ? 'ok' : 'err' });
   */
  startTrace(
    span: string,
  ): (opts?: { status?: TracePayload['status']; meta?: Record<string, unknown> }) => void {
    const start = Date.now();
    return (opts = {}) => {
      const status = opts.status ?? 'ok';
      this.batcher.addTrace({
        span,
        ms:          Date.now() - start,
        status_code: status === 'err' ? 500 : status === 'warn' ? 400 : 200,
        status,
        timestamp:   new Date().toISOString(),
        environment: this.cfg.environment,
        ...(this.cfg.release && { release: this.cfg.release }),
        ...(opts.meta        && { meta: opts.meta }),
        ...(this._user       && { user: this._user }),
      });
    };
  }

  // ── Feature flags ─────────────────────────────────────────────────────────

  /**
   * Check whether a feature flag is enabled. Evaluated locally — zero
   * network latency. Flag rules refresh every 30 seconds in the background.
   * Falls back to the identified user (via `setUser`) when no context is given.
   *
   * @example
   * if (watchup.isEnabled('new-checkout')) {
   *   renderNewCheckout();
   * }
   */
  isEnabled(key: string, ctx: FlagContext = {}): boolean {
    const flag = this._flags.get(key);
    if (!flag || !flag.enabled) return false;
    const mergedCtx: FlagContext = { userId: this._user?.id, email: this._user?.email, ...ctx };
    if (!matchesTargeting(flag, mergedCtx)) return false;
    if (flag.rollout_percentage >= 100) return true;
    if (flag.rollout_percentage <= 0)   return false;
    const userId = String(mergedCtx.userId ?? mergedCtx.email ?? this.visitorId);
    return flagBucket(key, userId) < flag.rollout_percentage;
  }

  /**
   * Get the variant key for a multivariate (A/B) flag.
   * Returns `"control"` if the flag is off or the visitor isn't in the rollout.
   *
   * @example
   * const variant = watchup.getVariant('pricing-layout');
   * // → "control" | "variant-a" | "variant-b"
   */
  getVariant(key: string, ctx: FlagContext = {}): string {
    if (!this.isEnabled(key, ctx)) return 'control';
    const flag = this._flags.get(key)!;
    if (!flag.variants?.length) return 'on';

    const mergedCtx: FlagContext = { userId: this._user?.id, email: this._user?.email, ...ctx };
    const userId = String(mergedCtx.userId ?? mergedCtx.email ?? this.visitorId);
    const bucket = flagBucket(key, userId);

    let cumulative = 0;
    for (const variant of flag.variants) {
      cumulative += variant.weight;
      if (bucket < cumulative) return variant.key;
    }
    return flag.variants[flag.variants.length - 1]!.key;
  }

  /** Immediately flush all queued items (both telemetry and web analytics). */
  flush(): void { this.batcher.flush(); }

  /** Stop the flush timer and release all listeners. */
  shutdown(): void {
    this.batcher.stop();
    this.batcher.flush();
    this.cleanup.forEach((fn) => fn());
  }

  // ── Auto-capture setup ────────────────────────────────────────────────────

  private _setupAutoCapture(): void {
    const { autoCapture, environment } = this.cfg;

    if (autoCapture.errors) {
      this.cleanup.push(
        captureGlobalErrors((e) => this.batcher.addError(e), environment),
      );
    }

    if (autoCapture.performance) {
      captureFCP((t)      => this.batcher.addTrace(t), environment);
      captureLCP((t)      => this.batcher.addTrace(t), environment);
      capturePageLoad((t) => this.batcher.addTrace(t), environment);
    }

    if (autoCapture.pageViews) {
      this._setupPageViewTracking();
    }
  }

  private _setupConsoleCapture(): void {
    if (!this.cfg.logging.enabled || !this.cfg.logging.captureConsole) return;

    const levels: Array<['debug' | 'info' | 'warn' | 'error', LogLevel]> = [
      ['debug', 'debug'],
      ['info', 'info'],
      ['warn', 'warning'],
      ['error', 'error'],
    ];

    for (const [method, level] of levels) {
      const original = console[method] as (...args: unknown[]) => void;

      const wrapped = (...args: unknown[]) => {
        original.apply(console, args);
        this.captureLog(this._consoleMessage(args), { level, console: true });
      };
      (console[method] as (...args: unknown[]) => void) = wrapped;
      this.cleanup.push(() => { (console[method] as (...args: unknown[]) => void) = original; });
    }
  }

  private _consoleMessage(args: unknown[]): string {
    return args.map((value) => {
      if (value instanceof Error) return value.message;
      if (typeof value === 'string') return value;
      try { return JSON.stringify(value); } catch { return String(value); }
    }).join(' ');
  }

  private _deviceContext(): Record<string, unknown> {
    return {
      userAgent: navigator.userAgent,
      language: navigator.language,
      platform: navigator.platform,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      screen: { width: window.screen.width, height: window.screen.height, colorDepth: window.screen.colorDepth },
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
  }

  private _setupPageViewTracking(): void {
    const trackView = () => {
      // Small delay so the page title has settled after navigation
      setTimeout(() => this.trackWebView(), 0);
    };

    // Initial view
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', trackView, { once: true });
    } else {
      setTimeout(() => this.trackWebView(), 0);
    }

    // SPA navigation — patch History API
    const origPush    = history.pushState.bind(history);
    const origReplace = history.replaceState.bind(history);

    history.pushState = (...args: Parameters<typeof history.pushState>) => {
      origPush(...args);
      trackView();
    };
    history.replaceState = (...args: Parameters<typeof history.replaceState>) => {
      origReplace(...args);
      // replaceState is often used for URL canonicalisation — don't track.
    };

    const onPopState = () => trackView();
    window.addEventListener('popstate', onPopState);

    this.cleanup.push(() => {
      history.pushState    = origPush;
      history.replaceState = origReplace;
      window.removeEventListener('popstate', onPopState);
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private _timezone(): string | undefined {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
    } catch {
      return undefined;
    }
  }
}
