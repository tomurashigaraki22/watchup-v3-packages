// ─────────────────────────────────────────────────────────────────────────────
// @watchupltd/browser  ·  Watchup client
// ─────────────────────────────────────────────────────────────────────────────

import type {
  WatchupOptions,
  TracePayload,
  ErrorPayload,
  EventPayload,
  WebAnalyticsPayload,
} from './types.js';
import { Transport }            from './transport.js';
import { Batcher }              from './batcher.js';
import { captureGlobalErrors }  from './error-capture.js';
import { captureFCP, captureLCP, capturePageLoad } from './perf.js';

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
} as const;

// ── Storage keys ──────────────────────────────────────────────────────────────

const VISITOR_KEY = '__wup_vid';
const SESSION_KEY = '__wup_sid';

// ─────────────────────────────────────────────────────────────────────────────

export class Watchup {
  private readonly cfg:     Required<WatchupOptions>;
  private readonly batcher: Batcher;
  private readonly cleanup: Array<() => void> = [];

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

  constructor(options: WatchupOptions) {
    if (!options.apiKey) {
      throw new Error('[watchup] apiKey is required.');
    }

    this.cfg = {
      ...DEFAULTS,
      autoCapture: { ...DEFAULTS.autoCapture, ...options.autoCapture },
      ...options,
    } as Required<WatchupOptions>;

    const transport = new Transport(this.cfg.baseUrl, this.cfg.apiKey, this.cfg.debug);
    this.batcher    = new Batcher(transport, this.cfg.flushInterval, this.cfg.maxBatchSize);
    this.batcher.start();

    // Initialise visitor & session IDs
    this.visitorId   = this._getOrCreateVisitorId();
    this.webSessionId = this._getOrCreateSessionId();

    this._setupAutoCapture();
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
    };

    this.batcher.addError(payload);
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
      });
    };
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
