import { Batcher } from './batcher.js';
import { getDeviceContext, getRouteFallback } from './device.js';
import { captureGlobalErrors } from './error-capture.js';
import { Transport } from './transport.js';
import type {
  ErrorPayload,
  LogContext,
  LogLevel,
  LoggingOptions,
  TracePayload,
  WatchupReactNativeOptions,
  WatchupUser,
} from './types.js';

const DEFAULTS = {
  baseUrl: 'https://api.watchup.site',
  flushInterval: 5_000,
  maxBatchSize: 100,
  debug: false,
  environment: 'production',
  release: '',
  autoCapture: {
    errors: true,
  },
  logging: {
    enabled: false,
    captureConsole: false,
    includeDeviceContext: true,
    minLevel: 'debug',
  },
} as const;

const LOG_LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warning: 30,
  error: 40,
  critical: 50,
};

export class WatchupReactNative {
  private readonly cfg: Required<WatchupReactNativeOptions> & { logging: Required<LoggingOptions> };
  private readonly batcher: Batcher;
  private readonly cleanup: Array<() => void> = [];
  private user: WatchupUser | null = null;

  constructor(options: WatchupReactNativeOptions) {
    if (!options.apiKey) throw new Error('[watchup] apiKey is required.');

    this.cfg = {
      ...DEFAULTS,
      ...options,
      autoCapture: { ...DEFAULTS.autoCapture, ...options.autoCapture },
      logging: { ...DEFAULTS.logging, ...options.logging },
    } as Required<WatchupReactNativeOptions> & { logging: Required<LoggingOptions> };

    const transport = new Transport(this.cfg.baseUrl, this.cfg.apiKey, this.cfg.debug);
    this.batcher = new Batcher(transport, this.cfg.flushInterval, this.cfg.maxBatchSize);
    this.batcher.start();

    if (this.cfg.autoCapture.errors) {
      this.cleanup.push(captureGlobalErrors(
        (error) => this.batcher.addError({ ...error, ...(this.user && { user: this.user }) }),
        this.cfg.environment,
        this.cfg.release,
      ));
    }

    this.setupConsoleCapture();
  }

  setUser(user: WatchupUser): void {
    this.user = { ...user };
  }

  clearUser(): void {
    this.user = null;
  }

  track(name: string, properties?: Record<string, unknown>): void {
    if (!name) return;
    this.batcher.addEvent({
      name,
      properties: {
        source: 'react-native',
        ...(this.user && { user: this.user }),
        ...properties,
      },
      occurred_at: new Date().toISOString(),
    });
  }

  captureLog(message: string, context: LogContext = {}): void {
    const { level = 'info', route, ...rest } = context;
    if (!this.cfg.logging.enabled) return;
    if (LOG_LEVEL_WEIGHT[level] < LOG_LEVEL_WEIGHT[this.cfg.logging.minLevel]) return;

    const properties: Record<string, unknown> = {
      message,
      level,
      source: 'react-native',
      route: route ?? getRouteFallback(),
      ...(this.user && { user: this.user }),
      ...rest,
    };

    if (this.cfg.logging.includeDeviceContext) {
      properties.device = getDeviceContext();
    }

    this.batcher.addEvent({
      name: `log.${level}`,
      properties,
      occurred_at: new Date().toISOString(),
    });
  }

  captureError(
    error: Error | string | unknown,
    context?: Record<string, unknown> & { route?: string; level?: ErrorPayload['level'] },
  ): void {
    const { route, level = 'error', ...rest } = context ?? {};
    const err = error instanceof Error ? error : new Error(String(error));

    this.batcher.addError({
      message: err.message,
      level,
      stack: err.stack,
      route: route ?? getRouteFallback(),
      context: {
        source: 'react-native',
        ...(this.cfg.logging.includeDeviceContext && { device: getDeviceContext() }),
        ...rest,
      },
      timestamp: new Date().toISOString(),
      environment: this.cfg.environment,
      ...(this.cfg.release && { release: this.cfg.release }),
      ...(this.user && { user: this.user }),
    });
  }

  startTrace(span: string): (opts?: { status?: TracePayload['status']; meta?: Record<string, unknown> }) => void {
    const start = Date.now();
    return (opts = {}) => {
      const status = opts.status ?? 'ok';
      this.batcher.addTrace({
        span,
        ms: Date.now() - start,
        status_code: status === 'err' ? 500 : status === 'warn' ? 400 : 200,
        status,
        timestamp: new Date().toISOString(),
        environment: this.cfg.environment,
        ...(this.cfg.release && { release: this.cfg.release }),
        ...(opts.meta && { meta: opts.meta }),
        ...(this.user && { user: this.user }),
      });
    };
  }

  flush(): void {
    this.batcher.flush();
  }

  shutdown(): void {
    this.batcher.stop();
    this.batcher.flush();
    this.cleanup.forEach((fn) => fn());
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
      const wrapped = (...args: unknown[]) => {
        original.apply(console, args);
        this.captureLog(this.consoleMessage(args), { level, console: true, method });
      };
      (console[method] as (...args: unknown[]) => void) = wrapped;
      this.cleanup.push(() => {
        (console[method] as (...args: unknown[]) => void) = original;
      });
    }
  }

  private consoleMessage(args: unknown[]): string {
    return args.map((value) => {
      if (value instanceof Error) return value.message;
      if (typeof value === 'string') return value;
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    }).join(' ');
  }
}

export { WatchupReactNative as Watchup };
