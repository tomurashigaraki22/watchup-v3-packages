// ─────────────────────────────────────────────────────────────────────────────
// @watchupltd/node  ·  Watchup client
// ─────────────────────────────────────────────────────────────────────────────

import type { WatchupOptions, WatchupUser, TracePayload, ErrorPayload, EventPayload, FeatureFlag, FlagContext, LogContext, LogLevel, LoggingOptions } from './types.js';
import { Transport }                                  from './transport.js';
import { Batcher }                                    from './batcher.js';
import { createRequestMiddleware, createErrorMiddleware } from './middleware.js';

const DEFAULTS = {
  baseUrl:       'https://api.watchup.site',
  flushInterval: 5_000,
  maxBatchSize:  100,
  debug:         false,
  sampleRate:    1,
  release:       '',
  logging: {
    enabled: false,
    captureConsole: false,
    minLevel: 'debug',
  },
} as const;

const LOG_LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10, info: 20, warning: 30, error: 40, critical: 50,
};

// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────

export class Watchup {
  private readonly cfg: Required<WatchupOptions> & { logging: Required<LoggingOptions> };
  private readonly batcher: Batcher;
  private _user: WatchupUser | null = null;
  private _consoleCleanup: Array<() => void> = [];

  // Feature flags
  private _flags: Map<string, FeatureFlag> = new Map();
  private _flagTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: WatchupOptions) {
    if (!options.apiKey) {
      throw new Error(
        '[watchup] apiKey is required. ' +
        'Find it in your Watchup dashboard → Project Settings → API Keys.',
      );
    }

    this.cfg = {
      ...DEFAULTS,
      environment: process.env.NODE_ENV ?? 'production',
      ...options,
      logging: { ...DEFAULTS.logging, ...options.logging },
    } as Required<WatchupOptions> & { logging: Required<LoggingOptions> };

    // Keep SDK diagnostics outside the user console capture wrapper.
    const transport  = new Transport(this.cfg.baseUrl, this.cfg.apiKey, this.cfg.debug, console.warn.bind(console));
    this.batcher     = new Batcher(transport, this.cfg.flushInterval, this.cfg.maxBatchSize);
    this.batcher.start();
    this._setupConsoleCapture();

    // Fetch flags immediately, then poll every 30 seconds
    this._fetchFlags();
    this._flagTimer = setInterval(() => this._fetchFlags(), 30_000);
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

  // ── User identification ───────────────────────────────────────────────────

  /**
   * Attach a user to all subsequent errors and traces captured by this instance.
   * In Express, call this per-request from middleware using `AsyncLocalStorage`
   * or store the identified client on your request object.
   *
   * @example
   * watchup.setUser({ id: req.user.id, email: req.user.email });
   */
  setUser(user: WatchupUser): void {
    this._user = { ...user };
  }

  /** Remove the current user context. */
  clearUser(): void {
    this._user = null;
  }

  // ── Express middleware ────────────────────────────────────────────────────

  /**
   * Captures timing, status code, and route for every incoming HTTP request.
   *
   * Mount **before** your routes so the `res.finish` handler is registered
   * in time.
   *
   * @example
   * ```ts
   * app.use(watchup.requestMiddleware());
   * app.get('/users', handler);
   * ```
   */
  requestMiddleware() {
    return createRequestMiddleware(this.batcher, {
      environment: this.cfg.environment,
      release:     this.cfg.release,
      sampleRate:  this.cfg.sampleRate,
    });
  }

  /**
   * Captures errors passed to Express's `next(err)` or thrown in async handlers.
   *
   * Mount **after** all routes and non-error middleware.
   * The middleware is transparent — it forwards the error to the next handler.
   *
   * @example
   * ```ts
   * app.get('/users', handler);
   * app.use(watchup.errorMiddleware());   // ← after routes
   * app.use(myOwnErrorHandler);           // still runs
   * ```
   */
  errorMiddleware() {
    return createErrorMiddleware(this.batcher, {
      environment: this.cfg.environment,
      release:     this.cfg.release,
    });
  }

  // ── Manual tracking ───────────────────────────────────────────────────────

  /**
   * Track a custom analytics event.
   *
   * Events appear in the Watchup dashboard under **Events** and are included
   * in the Analytics summary counts.
   *
   * @example
   * ```ts
   * watchup.track('user.signed_up', { plan: 'pro', source: 'invite' });
   * watchup.track('payment.completed', { amount: 49.99, currency: 'USD' });
   * ```
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
   * Manually capture an error that isn't caught by the Express error middleware
   * (e.g. inside background jobs, queue consumers, or scheduled tasks).
   *
   * @example
   * ```ts
   * try {
   *   await processOrder(orderId);
   * } catch (err) {
   *   watchup.captureError(err, { route: 'job.process_order', orderId });
   * }
   * ```
   */
  captureError(
    error:   Error | string | unknown,
    context?: Record<string, unknown> & {
      route?: string;
      level?: ErrorPayload['level'];
    },
  ): void {
    const { route, level = 'error', ...rest } = context ?? {};
    const err = error instanceof Error ? error : new Error(String(error));

    const payload: ErrorPayload = {
      message: err.message,
      level,
      ...(err.stack !== undefined && { stack: err.stack }),
      ...(route                    && { route }),
      ...(Object.keys(rest).length && { context: rest }),
      timestamp:   new Date().toISOString(),
      environment: this.cfg.environment,
      ...(this.cfg.release && { release: this.cfg.release }),
      ...(this._user       && { user: this._user }),
    };

    this.batcher.addError(payload);
  }

  /**
   * Send a structured operational log without affecting error-rate alerts.
   * Logging is opt-in through `logging.enabled`.
   */
  captureLog(message: string, context: LogContext = {}): void {
    const { level = 'info', route, ...rest } = context;
    if (!this.cfg.logging.enabled || LOG_LEVEL_WEIGHT[level] < LOG_LEVEL_WEIGHT[this.cfg.logging.minLevel]) return;

    const properties: Record<string, unknown> = {
      message,
      level,
      source: 'server',
      runtime: {
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
      },
      ...(route && { route }),
      ...(this._user && { user: this._user }),
      ...rest,
    };

    this.batcher.addEvent({
      name: `log.${level}`,
      properties,
      occurred_at: new Date().toISOString(),
    });
  }

  /**
   * Forward Node console output into structured logs when explicitly enabled.
   * The original console methods still run, so application output is unchanged.
   */
  private _setupConsoleCapture(): void {
    if (!this.cfg.logging.enabled || !this.cfg.logging.captureConsole) return;

    const levels: Array<['debug' | 'info' | 'log' | 'warn' | 'error', LogLevel]> = [
      ['debug', 'debug'],
      ['info', 'info'],
      ['log', 'info'],
      ['warn', 'warning'],
      ['error', 'error'],
    ];

    for (const [method, level] of levels) {
      const original = console[method] as (...args: unknown[]) => void;
      const wrapped = (...args: unknown[]) => {
        original.apply(console, args);
        this.captureLog(this._consoleMessage(args), { level, console: true, method });
      };
      (console[method] as (...args: unknown[]) => void) = wrapped;
      this._consoleCleanup.push(() => {
        (console[method] as (...args: unknown[]) => void) = original;
      });
    }
  }

  private _consoleMessage(args: unknown[]): string {
    return args.map((value) => {
      if (value instanceof Error) return value.message;
      if (typeof value === 'string') return value;
      try {
        const serialized = JSON.stringify(value);
        return serialized === undefined ? String(value) : serialized;
      } catch {
        return String(value);
      }
    }).join(' ');
  }

  /**
   * Time a non-HTTP operation (background job, cron, queue consumer, RPC call…)
   * and send it as a trace.
   *
   * Returns an `end()` function — call it when the operation finishes.
   *
   * @example
   * ```ts
   * const end = watchup.startTrace('job.generate_report');
   * try {
   *   await generateReport();
   *   end();               // status defaults to 'ok'
   * } catch (err) {
   *   end({ status: 'err' });
   *   throw err;
   * }
   * ```
   */
  startTrace(
    span: string,
  ): (opts?: { status?: TracePayload['status']; meta?: Record<string, unknown> }) => void {
    const start = Date.now();
    return (opts = {}) => {
      const status = opts.status ?? 'ok';
      const payload: TracePayload = {
        span,
        ms:          Date.now() - start,
        status_code: status === 'err' ? 500 : status === 'warn' ? 400 : 200,
        status,
        timestamp:   new Date().toISOString(),
        environment: this.cfg.environment,
        ...(this.cfg.release && { release: this.cfg.release }),
        ...(opts.meta        && { meta: opts.meta }),
        ...(this._user       && { user: this._user }),
      };
      this.batcher.addTrace(payload);
    };
  }

  // ── Feature flags ─────────────────────────────────────────────────────────

  /**
   * Check whether a feature flag is enabled for a given user context.
   * Evaluated locally with zero network latency. Flag rules are refreshed
   * every 30 seconds in the background.
   *
   * @example
   * ```ts
   * if (watchup.isEnabled('new-checkout', { userId: req.user.id })) {
   *   return newCheckout(req, res);
   * }
   * ```
   */
  isEnabled(key: string, ctx: FlagContext = {}): boolean {
    const flag = this._flags.get(key);
    if (!flag || !flag.enabled) return false;
    if (!matchesTargeting(flag, ctx)) return false;
    if (flag.rollout_percentage >= 100) return true;
    if (flag.rollout_percentage <= 0)   return false;
    const userId = String(ctx.userId ?? ctx.email ?? '');
    if (!userId) return flag.rollout_percentage >= 100;
    return flagBucket(key, userId) < flag.rollout_percentage;
  }

  /**
   * Get the variant key for a multivariate flag.
   * Returns `"control"` if the flag is disabled, the user is not in the
   * rollout, or the flag has no variants defined.
   *
   * @example
   * ```ts
   * const variant = watchup.getVariant('pricing-layout', { userId: req.user.id });
   * // → "control" | "variant-a" | "variant-b"
   * ```
   */
  getVariant(key: string, ctx: FlagContext = {}): string {
    if (!this.isEnabled(key, ctx)) return 'control';
    const flag = this._flags.get(key)!;
    if (!flag.variants?.length) return 'on';

    const userId = String(ctx.userId ?? ctx.email ?? '');
    const bucket = userId ? flagBucket(key, userId) : 0;

    let cumulative = 0;
    for (const variant of flag.variants) {
      cumulative += variant.weight;
      if (bucket < cumulative) return variant.key;
    }
    return flag.variants[flag.variants.length - 1]!.key;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Immediately flush all queued items.  Normally you don't need to call this;
   * the batcher flushes on interval and on process exit automatically.
   */
  flush(): void {
    this.batcher.flush();
  }

  /**
   * Stop the background flush timer and send any remaining items.
   * Call this if you're managing shutdown manually.
   */
  shutdown(): void {
    if (this._flagTimer) { clearInterval(this._flagTimer); this._flagTimer = null; }
    this.batcher.stop();
    this._consoleCleanup.forEach((cleanup) => cleanup());
    this._consoleCleanup = [];
    this.batcher.flush();
  }
}
