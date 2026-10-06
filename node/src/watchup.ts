// ─────────────────────────────────────────────────────────────────────────────
// @watchupltd/node  ·  Watchup client
// ─────────────────────────────────────────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */

import { performance } from 'node:perf_hooks';
import {
  DEFAULT_BASE_URL,
  DeliveryQueue,
  FlagStore,
  LIMITS,
  defaultSetInterval,
  parseFlagsResponse,
  sanitizeSql,
  uuid,
  type Diagnostic,
  type FlagContext,
  type FlushResult,
} from '@watchupltd/core';
import type {
  ErrorPayload,
  EventPayload,
  LogContext,
  LogLevel,
  LoggingOptions,
  RequestContext,
  TracePayload,
  WatchupOptions,
  WatchupUser,
} from './types.js';
import { Transport } from './transport.js';
import { requestContext, safeRequestId, traceIdFrom } from './context.js';
import { errorStatus, requestDetails, routeName, traceStatus } from './middleware.js';
import { SDK_NAME, SDK_VERSION } from './version.js';

const DEFAULTS = {
  baseUrl: DEFAULT_BASE_URL,
  flushInterval: 5_000,
  maxBatchSize: LIMITS.MAX_CHUNK_ITEMS,
  maxQueueSize: LIMITS.MAX_QUEUE_ITEMS,
  debug: false,
  sampleRate: 1,
  release: '',
  handleSignals: true,
  captureUnhandled: false,
  shutdownTimeout: 5_000,
  flagRefreshInterval: 30_000,
  logging: {
    enabled: false,
    captureConsole: false,
    minLevel: 'debug',
  },
} as const;

const LOG_LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10, info: 20, warning: 30, error: 40, critical: 50,
};

/** Errors already reported, so middleware + manual capture report once. */
const captured = new WeakSet<object>();

type ResolvedOptions = Required<Omit<WatchupOptions, 'onDiagnostic' | 'redactKeys' | 'service'>> & {
  logging: Required<LoggingOptions>;
  onDiagnostic?: (d: Diagnostic) => void;
  redactKeys?: string[];
  service?: string;
};

type EndTrace = (opts?: {
  status?: TracePayload['status'];
  /** Real status code (e.g. an HTTP response); defaults to 200/400/500 from `status`. */
  statusCode?: number;
  meta?: Record<string, unknown>;
}) => void;

export class Watchup {
  private readonly cfg: ResolvedOptions;
  private readonly queue: DeliveryQueue;
  private readonly flags = new FlagStore();
  private readonly cleanup: Array<() => void> = [];
  private readonly warn: (...args: unknown[]) => void;
  private globalUser: WatchupUser | null = null;
  private closed = false;
  private inConsoleCapture = false;

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
      ...stripUndefined(options),
      logging: { ...DEFAULTS.logging, ...stripUndefined(options.logging ?? {}) },
    } as ResolvedOptions;

    // Bound before console capture so SDK diagnostics are never re-captured.
    const realWarn = console.warn.bind(console);
    this.warn = (...args) => {
      if (this.cfg.debug) realWarn(...args);
    };

    const transport = new Transport(this.cfg.baseUrl, this.cfg.apiKey);
    this.queue = new DeliveryQueue({
      send: (chunk) => transport.send(chunk),
      base: () => ({
        sdk: { name: SDK_NAME, version: SDK_VERSION },
        environment: this.cfg.environment,
        ...(this.cfg.release && { release: this.cfg.release }),
      }),
      maxItems: this.cfg.maxBatchSize,
      maxQueueItems: this.cfg.maxQueueSize,
      ...(this.cfg.redactKeys && { normalize: { redactKeys: this.cfg.redactKeys } }),
      onDiagnostic: (d) => this.diagnostic(d),
    });
    this.queue.start(this.cfg.flushInterval);

    this.setupConsoleCapture();
    if (this.cfg.handleSignals) this.setupSignals();
    if (this.cfg.captureUnhandled) this.setupUnhandled();
    this.setupFlags();
  }

  // ── Identity & context ────────────────────────────────────────────────────

  /**
   * Attach a user. Inside a request handled by `requestMiddleware()` (or
   * `runWithContext`) the user applies to that request only; outside one it
   * becomes the default for everything this instance captures.
   *
   * @example
   * app.use((req, _res, next) => { watchup.setUser({ id: req.user.id }); next(); });
   */
  setUser(user: WatchupUser): void {
    const scope = requestContext.getStore();
    if (scope) scope.user = { ...user };
    else this.globalUser = { ...user };
  }

  /** Remove the user from the current request (or the default user). */
  clearUser(): void {
    const scope = requestContext.getStore();
    if (scope) scope.user = null;
    else this.globalUser = null;
  }

  /** The context of the request currently executing, if any. */
  getContext(): Readonly<RequestContext> | undefined {
    return requestContext.getStore();
  }

  /**
   * Run `fn` with its own request context — for queue consumers, cron jobs and
   * other work that does not go through the Express middleware.
   */
  runWithContext<T>(context: Partial<RequestContext>, fn: () => T): T {
    return requestContext.run({ requestId: uuid(), user: null, ...context }, fn);
  }

  // ── Express middleware ────────────────────────────────────────────────────

  /**
   * Records a trace for every request and opens a per-request context.
   * Mount **before** your routes. Adds no latency: the trace is recorded when
   * the response finishes (or the client disconnects).
   *
   * @example
   * app.use(watchup.requestMiddleware());
   */
  requestMiddleware() {
    return (req: any, res: any, next: (err?: unknown) => void): void => {
      const scope: RequestContext = {
        requestId: safeRequestId(req.headers?.['x-request-id']) ?? uuid(),
        method: String(req.method ?? 'GET').toUpperCase(),
        user: this.globalUser,
      };
      const traceId = traceIdFrom(req.headers?.traceparent);
      if (traceId) scope.traceId = traceId;
      req.watchupContext = scope;

      const sampled = this.shouldSample();
      const start = performance.now();
      const startedAt = new Date().toISOString();
      let recorded = false;

      const record = (aborted: boolean) => {
        if (recorded || this.closed) return;
        recorded = true;
        const span = routeName(req);
        scope.route = span;
        if (!sampled) return;
        const statusCode = aborted ? 499 : Number(res.statusCode) || 200;
        const trace: TracePayload = {
          span,
          type: 'http',
          ms: round(performance.now() - start),
          status_code: statusCode,
          status: aborted ? 'warn' : traceStatus(statusCode),
          timestamp: startedAt,
          environment: this.cfg.environment,
          ...(this.cfg.release && { release: this.cfg.release }),
          meta: {
            ...this.baseContext(scope),
            method: scope.method,
            path: requestDetails(req).path,
            ...(aborted && { aborted: true }),
          },
          ...(scope.user && { user: scope.user }),
        };
        this.queue.enqueue('traces', trace as unknown as Record<string, unknown>);
      };

      res.once?.('finish', () => record(false));
      res.once?.('close', () => {
        if (!res.writableFinished) record(true);
      });

      requestContext.run(scope, () => next());
    };
  }

  /**
   * Captures errors passed to `next(err)` (and, on Express 5, rejected async
   * handlers), then forwards them unchanged. Mount **after** your routes.
   * An error is reported once even if it passes through several handlers.
   *
   * @example
   * app.use(watchup.errorMiddleware());
   * app.use(myOwnErrorHandler); // still runs
   */
  errorMiddleware() {
    // Four parameters so Express recognises an error handler.
    return (err: any, req: any, _res: any, next: (err?: unknown) => void): void => {
      if (err) {
        const scope: RequestContext | undefined = req.watchupContext ?? requestContext.getStore();
        const status = errorStatus(err);
        this.captureError(err, {
          route: routeName(req),
          // 4xx errors are client mistakes, not incidents.
          level: status >= 500 ? 'error' : 'warning',
          request: { ...requestDetails(req), status_code: status },
          ...(scope && { [SCOPE]: scope }),
        });
      }
      next(err);
    };
  }

  /**
   * Wrap an async Express 4 handler so a rejected promise reaches `next(err)`
   * (Express 5 does this natively).
   *
   * @example
   * app.get('/users', watchup.wrapAsync(async (req, res) => res.json(await db.users())));
   */
  wrapAsync<Req = any, Res = any>(handler: (req: Req, res: Res, next: (err?: unknown) => void) => unknown) {
    return (req: Req, res: Res, next: (err?: unknown) => void): void => {
      try {
        const result = handler(req, res, next);
        if (result && typeof (result as Promise<unknown>).then === 'function') {
          (result as Promise<unknown>).then(undefined, next);
        }
      } catch (err) {
        next(err);
      }
    };
  }

  // ── Manual capture ────────────────────────────────────────────────────────

  /**
   * Track a custom analytics event.
   *
   * @example
   * watchup.track('user.signed_up', { plan: 'pro', source: 'invite' });
   */
  track(name: string, properties?: Record<string, unknown>): void {
    if (!name || this.closed) return;
    const scope = requestContext.getStore();
    const user = this.currentUser();
    const event: EventPayload = {
      name,
      properties: {
        ...this.baseContext(scope),
        ...(user && { user }),
        ...properties,
      },
      occurred_at: new Date().toISOString(),
    };
    this.queue.enqueue('events', event as unknown as Record<string, unknown>);
  }

  /**
   * Capture an error outside the Express error middleware (background jobs,
   * queue consumers, scheduled tasks). Each Error object is reported once.
   *
   * @example
   * try { await processOrder(id); }
   * catch (err) { watchup.captureError(err, { route: 'job.process_order', orderId: id }); }
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
    const { route, level = 'error', [SCOPE]: explicitScope, ...rest } = (context ?? {}) as Record<string | symbol, unknown> & {
      route?: string;
      level?: ErrorPayload['level'];
    };
    const scope = (explicitScope as RequestContext | undefined) ?? requestContext.getStore();
    const err = error instanceof Error ? error : new Error(typeof error === 'string' ? error : safeString(error));
    const user = scope?.user ?? this.globalUser;
    const extra = Object.fromEntries(Object.entries(rest));
    const resolvedRoute = route ?? scope?.route;

    const payload: ErrorPayload = {
      message: err.message || String(error),
      type: err.name || 'Error',
      level,
      ...(err.stack !== undefined && { stack: err.stack }),
      ...(resolvedRoute && { route: resolvedRoute }),
      context: {
        ...extra,
        ...this.baseContext(scope),
        ...((err as { cause?: unknown }).cause !== undefined && { cause: (err as { cause?: unknown }).cause }),
      },
      timestamp: new Date().toISOString(),
      environment: this.cfg.environment,
      ...(this.cfg.release && { release: this.cfg.release }),
      ...(user && { user }),
    };
    this.queue.enqueue('errors', payload as unknown as Record<string, unknown>);
  }

  /**
   * Send a structured operational log without affecting error-rate alerts.
   * Logging is opt-in through `logging.enabled`.
   */
  captureLog(message: string, context: LogContext = {}): void {
    const { level = 'info', route, ...rest } = context;
    if (this.closed || !this.cfg.logging.enabled) return;
    if (LOG_LEVEL_WEIGHT[level] < LOG_LEVEL_WEIGHT[this.cfg.logging.minLevel]) return;
    const scope = requestContext.getStore();
    const user = this.currentUser();

    this.queue.enqueue('events', {
      name: `log.${level}`,
      properties: {
        ...rest,
        message,
        level,
        ...this.baseContext(scope),
        runtime: { node: process.version, platform: process.platform, architecture: process.arch },
        ...((route ?? scope?.route) && { route: route ?? scope?.route }),
        ...(user && { user }),
      },
      occurred_at: new Date().toISOString(),
    });
  }

  /**
   * Time a non-HTTP operation and record it as a trace. Returns `end()`.
   *
   * @example
   * const end = watchup.startTrace('job.generate_report');
   * try { await generateReport(); end(); } catch (err) { end({ status: 'err' }); throw err; }
   */
  startTrace(span: string, options: { type?: TracePayload['type'] } = {}): EndTrace {
    const start = performance.now();
    const startedAt = new Date().toISOString();
    const scope = requestContext.getStore();
    const user = this.currentUser();
    let ended = false;
    return (opts = {}) => {
      if (ended || this.closed) return;
      ended = true;
      const status = opts.status ?? 'ok';
      const trace: TracePayload = {
        span,
        type: options.type ?? 'custom',
        ms: round(performance.now() - start),
        status_code: opts.statusCode ?? (status === 'err' ? 500 : status === 'warn' ? 400 : 200),
        status,
        timestamp: startedAt,
        environment: this.cfg.environment,
        ...(this.cfg.release && { release: this.cfg.release }),
        meta: { ...opts.meta, ...this.baseContext(scope), ...(scope?.route && { parent_route: scope.route }) },
        ...(user && { user }),
      };
      this.queue.enqueue('traces', trace as unknown as Record<string, unknown>);
    };
  }

  /**
   * Run `fn` and record it as a trace; rejects/throws are marked `err` and
   * re-thrown unchanged.
   *
   * @example
   * const report = await watchup.trace('job.generate_report', () => generateReport());
   */
  async trace<T>(span: string, fn: () => T | Promise<T>, options: { type?: TracePayload['type'] } = {}): Promise<T> {
    const end = this.startTrace(span, options);
    try {
      const result = await fn();
      end();
      return result;
    } catch (err) {
      end({ status: 'err' });
      throw err;
    }
  }

  /**
   * Record a database query span. The statement is sanitized (literals become
   * `?`, max 1 KiB) and query parameters are never recorded. Queries slower
   * than `slowMs` are marked `warn`.
   *
   * @example
   * const rows = await watchup.traceQuery('SELECT * FROM orders WHERE id = $1', () => pool.query(sql, [id]), { system: 'postgresql' });
   */
  async traceQuery<T>(
    statement: string,
    fn: () => T | Promise<T>,
    options: { system?: string; slowMs?: number } = {},
  ): Promise<T> {
    const sql = sanitizeSql(statement);
    const start = performance.now();
    const end = this.startTrace(sql, { type: 'db' });
    const meta = { ...(options.system && { db_system: options.system }) };
    try {
      const result = await fn();
      const slow = performance.now() - start > (options.slowMs ?? 500);
      end({ status: slow ? 'warn' : 'ok', meta: { ...meta, ...(slow && { slow: true }) } });
      return result;
    } catch (err) {
      end({ status: 'err', meta });
      throw err;
    }
  }

  // ── Feature flags ─────────────────────────────────────────────────────────

  /**
   * Whether a flag is enabled for a user. Evaluated locally from a cache that
   * refreshes every 30 s. Uses the request's user when `ctx` has no user ID.
   *
   * @example
   * if (watchup.isEnabled('new-checkout', { userId: req.user.id })) { ... }
   */
  isEnabled(key: string, ctx: FlagContext = {}): boolean {
    return this.flags.isEnabled(key, this.flagContext(ctx));
  }

  /**
   * Variant key for a multivariate flag; `"control"` when off or not in rollout.
   */
  getVariant(key: string, ctx: FlagContext = {}): string {
    return this.flags.getVariant(key, this.flagContext(ctx));
  }

  /** Fetch flags now instead of waiting for the next poll. */
  async refreshFlags(): Promise<void> {
    try {
      const res = await fetch(`${this.cfg.baseUrl.replace(/\/+$/, '')}/api/v1/flags`, {
        headers: { Authorization: `Bearer ${this.cfg.apiKey}`, 'X-Api-Key': this.cfg.apiKey },
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) return;
      const flags = parseFlagsResponse(await res.json());
      if (flags) this.flags.replace(flags);
    } catch {
      // Keep serving the cached flags.
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /** Send everything queued now. Never rejects. */
  flush(): Promise<FlushResult> {
    return this.queue.flush();
  }

  /**
   * Stop timers and handlers, then deliver what is queued (up to
   * `shutdownTimeout`). Safe to call more than once.
   */
  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const fn of this.cleanup.splice(0)) fn();
    await this.queue.shutdown(this.cfg.shutdownTimeout);
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private currentUser(): WatchupUser | null {
    return requestContext.getStore()?.user ?? this.globalUser;
  }

  private baseContext(scope: RequestContext | undefined): Record<string, unknown> {
    return {
      source: 'server',
      ...(this.cfg.service && { service: this.cfg.service }),
      ...(scope && { request_id: scope.requestId }),
      ...(scope?.traceId && { trace_id: scope.traceId }),
    };
  }

  private flagContext(ctx: FlagContext): FlagContext {
    const user = this.currentUser();
    return {
      ...(user?.id !== undefined && { userId: user.id }),
      ...(user?.email !== undefined && { email: user.email }),
      ...ctx,
    };
  }

  private shouldSample(): boolean {
    const rate = this.cfg.sampleRate;
    return rate >= 1 || (rate > 0 && Math.random() < rate);
  }

  private diagnostic(d: Diagnostic): void {
    this.warn(`[watchup] ${d.type}: ${d.message}`);
    try {
      this.cfg.onDiagnostic?.(d);
    } catch {
      // User handler errors are ignored.
    }
  }

  private setupFlags(): void {
    if (this.cfg.flagRefreshInterval <= 0) return;
    void this.refreshFlags();
    this.cleanup.push(defaultSetInterval(() => void this.refreshFlags(), this.cfg.flagRefreshInterval));
  }

  private setupSignals(): void {
    const onBeforeExit = () => void this.queue.flush();
    process.on('beforeExit', onBeforeExit);
    this.cleanup.push(() => process.off('beforeExit', onBeforeExit));

    for (const sig of ['SIGTERM', 'SIGINT'] as const) {
      const handler = () => {
        // If the app has its own handler, it owns the exit; we only flush.
        const appHandles = process.listenerCount(sig) > 1;
        void this.shutdown().finally(() => {
          if (!appHandles) {
            process.off(sig, handler);
            process.kill(process.pid, sig);
          }
        });
      };
      process.once(sig, handler);
      this.cleanup.push(() => process.off(sig, handler));
    }
  }

  private setupUnhandled(): void {
    const fatal = (error: unknown, origin: string) => {
      this.captureError(error, { level: 'fatal', mechanism: origin });
      const timer = setTimeout(() => process.exit(1), this.cfg.shutdownTimeout + 500);
      timer.unref?.();
      void this.shutdown().finally(() => {
        // Match Node's default output and exit code.
        console.error(error);
        process.exit(1);
      });
    };
    const onException = (error: unknown) => fatal(error, 'uncaughtException');
    const onRejection = (reason: unknown) => fatal(reason, 'unhandledRejection');
    process.on('uncaughtException', onException);
    process.on('unhandledRejection', onRejection);
    this.cleanup.push(() => {
      process.off('uncaughtException', onException);
      process.off('unhandledRejection', onRejection);
    });
  }

  /**
   * Forward Node console output into structured logs when explicitly enabled.
   * The original console methods still run, so application output is unchanged.
   */
  private setupConsoleCapture(): void {
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
      let active = true;
      const wrapped = (...args: unknown[]) => {
        original.apply(console, args);
        if (!active || this.inConsoleCapture) return;
        this.inConsoleCapture = true;
        try {
          this.captureLog(consoleMessage(args), { level, console: true, method });
        } finally {
          this.inConsoleCapture = false;
        }
      };
      (console[method] as (...args: unknown[]) => void) = wrapped;
      this.cleanup.push(() => {
        active = false;
        if (console[method] === wrapped) (console[method] as (...args: unknown[]) => void) = original;
      });
    }
  }
}

/** Internal: lets the error middleware pass the request scope explicitly. */
const SCOPE = Symbol('watchup.scope');

// ── Helpers ─────────────────────────────────────────────────────────────────

function round(ms: number): number {
  return Math.round(ms * 100) / 100;
}

function safeString(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
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
