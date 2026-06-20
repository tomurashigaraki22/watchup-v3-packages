// ─────────────────────────────────────────────────────────────────────────────
// @watchupltd/node  ·  Watchup client
// ─────────────────────────────────────────────────────────────────────────────

import type { WatchupOptions, TracePayload, ErrorPayload, EventPayload } from './types.js';
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
} as const;

// ─────────────────────────────────────────────────────────────────────────────

export class Watchup {
  private readonly cfg: Required<WatchupOptions>;
  private readonly batcher: Batcher;

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
    };

    const transport  = new Transport(this.cfg.baseUrl, this.cfg.apiKey, this.cfg.debug);
    this.batcher     = new Batcher(transport, this.cfg.flushInterval, this.cfg.maxBatchSize);
    this.batcher.start();
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
      ...(route                            && { route }),
      ...(Object.keys(rest).length        && { context: rest }),
      timestamp:   new Date().toISOString(),
      environment: this.cfg.environment,
      ...(this.cfg.release && { release: this.cfg.release }),
    };

    this.batcher.addError(payload);
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
      };
      this.batcher.addTrace(payload);
    };
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
    this.batcher.stop();
    this.batcher.flush();
  }
}
