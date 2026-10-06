// ─────────────────────────────────────────────────────────────────────────────
// @watchupltd/react-native  ·  client
//
// Offline-first: items are persisted (AsyncStorage by default), restored on
// the next launch, flushed when connectivity returns and when the app goes to
// the background. Nothing here blocks rendering — all I/O is async.
// ─────────────────────────────────────────────────────────────────────────────

import {
  DEFAULT_BASE_URL,
  DeliveryQueue,
  LIMITS,
  defaultSetInterval,
  uuid,
  type Cancel,
  type Diagnostic,
  type FlushResult,
  type QueueSnapshot,
} from '@watchupltd/core';
import { captureGlobalErrors, captureUnhandledRejections } from './error-capture.js';
import { getAsyncStorage, getDeviceContext, getNetInfo, getReactNative } from './device.js';
import { Transport } from './transport.js';
import { SDK_NAME, SDK_VERSION } from './version.js';
import type {
  ErrorPayload,
  LogContext,
  LogLevel,
  LoggingOptions,
  QueueStorage,
  TracePayload,
  WatchupReactNativeOptions,
  WatchupUser,
} from './types.js';

const STORAGE_KEY = '@watchup/queue/v1';
const PERSIST_DEBOUNCE_MS = 1_000;

const DEFAULTS = {
  baseUrl: DEFAULT_BASE_URL,
  flushInterval: 5_000,
  maxBatchSize: LIMITS.MAX_CHUNK_ITEMS,
  maxQueueSize: LIMITS.MAX_QUEUE_ITEMS,
  debug: false,
  environment: 'production',
  release: '',
  autoCapture: { errors: true, unhandledRejections: true },
  logging: { enabled: false, captureConsole: false, includeDeviceContext: true, minLevel: 'debug' },
} as const;

const LOG_LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warning: 30, error: 40, critical: 50 };

/** Errors already reported (e.g. a boundary and the global handler). */
const captured = new WeakSet<object>();

type EndTrace = (opts?: { status?: TracePayload['status']; meta?: Record<string, unknown> }) => void;

export class WatchupReactNative {
  /** Random ID for this app launch. */
  readonly sessionId = uuid();

  private readonly cfg: Required<Omit<WatchupReactNativeOptions, 'storage' | 'onDiagnostic' | 'redactKeys' | 'service'>> & {
    logging: Required<LoggingOptions>;
    autoCapture: Required<NonNullable<WatchupReactNativeOptions['autoCapture']>>;
  } & Pick<WatchupReactNativeOptions, 'onDiagnostic' | 'redactKeys' | 'service'>;
  private readonly queue: DeliveryQueue;
  private readonly storage: QueueStorage | null;
  private readonly cleanup: Array<() => void> = [];
  private user: WatchupUser | null = null;
  private screen: string | undefined;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private stopInterval: Cancel | null = null;
  private online = true;
  private closed = false;
  private inConsoleCapture = false;
  /** Resolves once a persisted queue from a previous launch has been restored. */
  readonly ready: Promise<void>;

  constructor(options: WatchupReactNativeOptions) {
    if (!options.apiKey) throw new Error('[watchup] apiKey is required.');

    this.cfg = {
      ...DEFAULTS,
      ...stripUndefined(options),
      autoCapture: { ...DEFAULTS.autoCapture, ...stripUndefined(options.autoCapture ?? {}) },
      logging: { ...DEFAULTS.logging, ...stripUndefined(options.logging ?? {}) },
    } as WatchupReactNative['cfg'];

    this.storage = options.storage === undefined ? getAsyncStorage() : options.storage;
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
      onChange: () => this.schedulePersist(),
    });

    this.ready = this.restore();
    void this.ready.then(() => {
      if (!this.closed) void this.flush();
    });
    this.stopInterval = defaultSetInterval(() => void this.queue.flush(), this.cfg.flushInterval);

    if (this.cfg.autoCapture.errors) {
      this.cleanup.push(captureGlobalErrors((error, isFatal) => {
        this.captureError(error, { level: isFatal ? 'fatal' : 'error', mechanism: 'global-handler', is_fatal: isFatal });
        // A fatal error usually ends the process: persist synchronously-ish now.
        if (isFatal) void this.persistNow();
      }));
    }
    if (this.cfg.autoCapture.unhandledRejections) {
      captureUnhandledRejections((reason) => this.captureError(reason, { mechanism: 'unhandledrejection' }));
    }
    this.setupLifecycle();
    this.setupConsoleCapture();
  }

  // ── Identity & navigation ─────────────────────────────────────────────────

  setUser(user: WatchupUser): void {
    this.user = { ...user };
  }

  clearUser(): void {
    this.user = null;
  }

  /**
   * Record the current screen. Used as the route for errors, traces and logs,
   * and tracked as a `screen.view` event. `useNavigationTracking` calls this.
   */
  setScreen(name: string, params?: Record<string, unknown>): void {
    if (!name || name === this.screen) return;
    const previous = this.screen;
    this.screen = name;
    this.track('screen.view', { screen: name, ...(previous && { previous_screen: previous }), ...(params && { params }) });
  }

  get currentScreen(): string | undefined {
    return this.screen;
  }

  // ── Capture ───────────────────────────────────────────────────────────────

  track(name: string, properties?: Record<string, unknown>): void {
    if (!name || this.closed) return;
    this.queue.enqueue('events', {
      name,
      properties: {
        ...this.baseContext(),
        route: this.route(),
        ...(this.user && { user: this.user }),
        ...properties,
      },
      occurred_at: new Date().toISOString(),
    });
  }

  captureLog(message: string, context: LogContext = {}): void {
    const { level = 'info', route, ...rest } = context;
    if (this.closed || !this.cfg.logging.enabled) return;
    if (LOG_LEVEL_WEIGHT[level] < LOG_LEVEL_WEIGHT[this.cfg.logging.minLevel]) return;
    this.queue.enqueue('events', {
      name: `log.${level}`,
      properties: {
        ...rest,
        message,
        level,
        ...this.baseContext(),
        route: route ?? this.route(),
        ...(this.user && { user: this.user }),
        ...(this.cfg.logging.includeDeviceContext && { device: getDeviceContext() }),
      },
      occurred_at: new Date().toISOString(),
    });
  }

  captureError(
    error: Error | string | unknown,
    context?: Record<string, unknown> & { route?: string; level?: ErrorPayload['level'] },
  ): void {
    if (this.closed) return;
    if (error && typeof error === 'object') {
      if (captured.has(error)) return;
      captured.add(error);
    }
    const { route, level = 'error', ...rest } = context ?? {};
    const err = error instanceof Error ? error : new Error(typeof error === 'string' ? error : safeString(error));
    const payload: ErrorPayload = {
      message: err.message || String(error),
      type: err.name || 'Error',
      level,
      ...(err.stack !== undefined && { stack: err.stack }),
      route: route ?? this.route(),
      context: {
        ...rest,
        ...this.baseContext(),
        ...(this.cfg.logging.includeDeviceContext && { device: getDeviceContext() }),
      },
      timestamp: new Date().toISOString(),
      environment: this.cfg.environment,
      ...(this.cfg.release && { release: this.cfg.release }),
      ...(this.user && { user: this.user }),
    };
    this.queue.enqueue('errors', payload as unknown as Record<string, unknown>);
  }

  startTrace(span: string, options: { type?: TracePayload['type'] } = {}): EndTrace {
    const start = Date.now();
    const startedAt = new Date(start).toISOString();
    const route = this.route();
    const user = this.user;
    let ended = false;
    return (opts = {}) => {
      if (ended || this.closed) return;
      ended = true;
      const status = opts.status ?? 'ok';
      this.queue.enqueue('traces', {
        span,
        type: options.type ?? 'custom',
        ms: Date.now() - start,
        status_code: status === 'err' ? 500 : status === 'warn' ? 400 : 200,
        status,
        timestamp: startedAt,
        environment: this.cfg.environment,
        ...(this.cfg.release && { release: this.cfg.release }),
        meta: { ...opts.meta, ...this.baseContext(), route },
        ...(user && { user }),
      });
    };
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /** Send what is queued now (no-op while offline). Never rejects. */
  async flush(): Promise<FlushResult> {
    const result = await this.queue.flush();
    await this.persistNow();
    return result;
  }

  get isOnline(): boolean {
    return this.online;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Stop listeners, attempt delivery, and persist anything left for next launch. */
  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stopInterval?.();
    for (const fn of this.cleanup.splice(0)) fn();
    if (this.online) await this.queue.shutdown(2_000);
    else this.queue.stop();
    await this.persistNow();
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private route(): string {
    return this.screen ?? 'react-native';
  }

  private baseContext(): Record<string, unknown> {
    return { source: 'react-native', session_id: this.sessionId, ...(this.cfg.service && { service: this.cfg.service }) };
  }

  private setupLifecycle(): void {
    const appState = getReactNative()?.AppState;
    if (appState?.addEventListener) {
      const sub = appState.addEventListener('change', (state: string) => {
        if (state === 'background' || state === 'inactive') {
          // iOS gives a few seconds in the background: send, then persist.
          void this.flush();
        } else if (state === 'active') {
          void this.flush();
        }
      });
      this.cleanup.push(() => sub?.remove?.());
    }

    const netInfo = getNetInfo();
    if (netInfo) {
      const unsubscribe = netInfo.addEventListener((state) => {
        const online = state.isConnected !== false && state.isInternetReachable !== false;
        if (online === this.online) return;
        this.online = online;
        if (online) void this.queue.resume().then(() => this.persistNow());
        else this.queue.pause();
      });
      this.cleanup.push(unsubscribe);
    }
  }

  private async restore(): Promise<void> {
    if (!this.storage) return;
    try {
      const raw = await this.storage.getItem(STORAGE_KEY);
      if (raw) this.queue.restore(JSON.parse(raw) as QueueSnapshot);
    } catch {
      // Corrupt or unreadable storage: start fresh.
      void this.storage.removeItem(STORAGE_KEY).catch(() => undefined);
    }
  }

  private schedulePersist(): void {
    if (!this.storage || this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persistNow();
    }, PERSIST_DEBOUNCE_MS);
  }

  private async persistNow(): Promise<void> {
    if (!this.storage) return;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    try {
      const snapshot = this.queue.snapshot();
      const empty = !snapshot.retry.length && !snapshot.pending.errors.length && !snapshot.pending.traces.length && !snapshot.pending.events.length;
      if (empty) await this.storage.removeItem(STORAGE_KEY);
      else await this.storage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
    } catch {
      // Storage full or unavailable — keep the in-memory queue.
    }
  }

  private diagnostic(d: Diagnostic): void {
    if (this.cfg.debug) console.warn(`[watchup] ${d.type}: ${d.message}`);
    try {
      this.cfg.onDiagnostic?.(d);
    } catch {
      // User handler errors are ignored.
    }
  }

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
          this.captureLog(args.map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : safeString(a))).join(' '), {
            level,
            console: true,
            method,
          });
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

export { WatchupReactNative as Watchup };

function safeString(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  const out: Partial<T> = {};
  for (const key of Object.keys(value) as Array<keyof T>) {
    if (value[key] !== undefined) out[key] = value[key];
  }
  return out;
}
