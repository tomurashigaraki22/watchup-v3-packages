// ─────────────────────────────────────────────────────────────────────────────
// @watchupltd/node  ·  Express middleware
// ─────────────────────────────────────────────────────────────────────────────

import type { WatchupOptions, TracePayload, ErrorPayload } from './types.js';
import type { Batcher } from './batcher.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Replace common variable path segments with a `:param` placeholder so that
 * `/users/42` and `/users/abc-123` are grouped under the same span name.
 *
 * Express automatically provides `req.route.path` for matched routes; this
 * fallback is only used for unmatched paths (404s, middleware-only routes).
 */
function normalisePath(path: string): string {
  return path
    // UUIDs  /items/3f2504e0-4f89-11d3-9a0c-0305e82c3301
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:id')
    // Numeric IDs  /users/42
    .replace(/\/\d+/g, '/:id')
    // Strip trailing slashes except for root
    .replace(/(.+)\/$/, '$1');
}

function traceStatus(statusCode: number): TracePayload['status'] {
  if (statusCode >= 500) return 'err';
  if (statusCode >= 400) return 'warn';
  return 'ok';
}

// ── Request middleware ────────────────────────────────────────────────────────

type RequestMiddlewareOpts = Pick<WatchupOptions, 'environment' | 'release' | 'sampleRate'>;

/**
 * Factory — returned by `watchup.requestMiddleware()`.
 *
 * Hooks into `res.on('finish')` so it adds zero latency to the request path.
 * Works with Express, Fastify-compat, and any framework that exposes a
 * Node `http.IncomingMessage`-style `req` and `http.ServerResponse`-style `res`.
 */
export function createRequestMiddleware(batcher: Batcher, opts: RequestMiddlewareOpts) {
  const { environment, release, sampleRate = 1 } = opts;

  return function watchupRequest(req: any, res: any, next: () => void): void {
    // ── Sampling ──────────────────────────────────────────────────────────────
    if (sampleRate < 1 && Math.random() > sampleRate) {
      return next();
    }

    const start = Date.now();

    res.on('finish', () => {
      const ms = Date.now() - start;

      // Prefer the matched route pattern from Express (`req.route.path` is
      // e.g. `/users/:id`) over the raw URL, which contains real IDs.
      const routePath: string =
        req.route?.path
          ? `${req.method} ${req.baseUrl ?? ''}${req.route.path}`
          : `${req.method} ${normalisePath(req.path ?? req.url ?? '/')}`;

      const trace: TracePayload = {
        span:        routePath,
        ms,
        status_code: res.statusCode,
        status:      traceStatus(res.statusCode),
        timestamp:   new Date().toISOString(),
        ...(environment && { environment }),
        ...(release    && { release }),
      };

      batcher.addTrace(trace);
    });

    next();
  };
}

// ── Error middleware ──────────────────────────────────────────────────────────

type ErrorMiddlewareOpts = Pick<WatchupOptions, 'environment' | 'release'>;

/**
 * Factory — returned by `watchup.errorMiddleware()`.
 *
 * Captures errors thrown/passed in Express routes and forwards them to
 * Watchup before delegating to the next error handler.
 *
 * IMPORTANT: must be registered AFTER all routes, and must have exactly 4
 * parameters so Express recognises it as an error-handling middleware.
 */
export function createErrorMiddleware(batcher: Batcher, opts: ErrorMiddlewareOpts) {
  const { environment, release } = opts;

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return function watchupError(err: any, req: any, res: any, next: (e?: any) => void): void {
    if (err) {
      const route: string =
        req.route?.path
          ? `${req.method} ${req.baseUrl ?? ''}${req.route.path}`
          : `${req.method} ${normalisePath(req.path ?? req.url ?? '/')}`;

      const payload: ErrorPayload = {
        message: err.message ?? String(err),
        level:   'error',
        route,
        ...(err.stack !== undefined && { stack: err.stack }),
        context: {
          method:     req.method,
          url:        req.originalUrl ?? req.url,
          statusCode: err.status ?? err.statusCode ?? 500,
        },
        timestamp: new Date().toISOString(),
        ...(environment && { environment }),
        ...(release    && { release }),
      };

      batcher.addError(payload);
    }

    next(err); // Always pass to the next error handler
  };
}
