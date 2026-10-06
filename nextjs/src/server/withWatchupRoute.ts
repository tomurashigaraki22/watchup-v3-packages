// ─────────────────────────────────────────────────────────────────────────────
// @watchupltd/nextjs  ·  Route Handler, API route and request-error wrappers
//
// Each wrapper opens a per-request context (so setUser is request-scoped),
// records one trace with the real status code, captures an error once, and
// returns or re-throws exactly what the handler produced.
// ─────────────────────────────────────────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */

import { normalisePath } from '@watchupltd/node';
import { getWatchup } from './watchup.js';

export interface RouteOptions {
  /**
   * Route template for grouping, e.g. `/api/orders/[id]`. Defaults to the
   * request path with IDs replaced by `:id`.
   */
  route?: string;
}

function requestIdOf(headers: { get(name: string): string | null } | undefined): string | undefined {
  const value = headers?.get('x-request-id');
  return value && /^[\w\-.:]{1,128}$/.test(value) ? value : undefined;
}

function statusOf(code: number): 'ok' | 'warn' | 'err' {
  return code >= 500 ? 'err' : code >= 400 ? 'warn' : 'ok';
}

/**
 * Wrap an App Router Route Handler with tracing and error capture.
 *
 * @example
 * // app/api/orders/[id]/route.ts
 * export const GET = withWatchupRoute(async (req, { params }) => Response.json(await getOrder(params.id)),
 *   { route: '/api/orders/[id]' });
 */
export function withWatchupRoute<Req extends Request, Args extends unknown[]>(
  handler: (req: Req, ...args: Args) => Response | Promise<Response>,
  options: RouteOptions = {},
): (req: Req, ...args: Args) => Promise<Response> {
  return async (req, ...args) => {
    const watchup = getWatchup();
    const method = req.method.toUpperCase();
    const route = `${method} ${options.route ?? normalisePath(new URL(req.url).pathname)}`;
    const requestId = requestIdOf(req.headers);

    return watchup.runWithContext({ method, route, ...(requestId && { requestId }) }, async (): Promise<Response> => {
      const end = watchup.startTrace(route, { type: 'http' });
      try {
        const response = await handler(req, ...args);
        const code = typeof response?.status === 'number' ? response.status : 200;
        end({ status: statusOf(code), statusCode: code, meta: { method } });
        return response;
      } catch (err) {
        // Next's notFound()/redirect() throw control-flow errors; not incidents.
        const digest = (err as { digest?: unknown })?.digest;
        if (typeof digest === 'string' && /^(NEXT_NOT_FOUND|NEXT_REDIRECT|NEXT_HTTP_ERROR_FALLBACK)/.test(digest)) {
          end({ status: 'ok', statusCode: digest.startsWith('NEXT_REDIRECT') ? 307 : 404, meta: { method } });
          throw err;
        }
        end({ status: 'err', statusCode: 500, meta: { method } });
        watchup.captureError(err, { route, level: 'error', request: { method, path: normalisePath(new URL(req.url).pathname) } });
        throw err;
      }
    });
  };
}

/**
 * Wrap a Pages Router API route (`pages/api/*`).
 *
 * @example
 * export default withWatchupApi(async (req, res) => res.json({ ok: true }), { route: '/api/users/[id]' });
 */
export function withWatchupApi<Req extends { method?: string; url?: string; headers?: any }, Res extends { statusCode: number; once?: any }>(
  handler: (req: Req, res: Res) => unknown,
  options: RouteOptions = {},
): (req: Req, res: Res) => Promise<void> {
  return async (req, res) => {
    const watchup = getWatchup();
    const method = String(req.method ?? 'GET').toUpperCase();
    const route = `${method} ${options.route ?? normalisePath(req.url ?? '/')}`;
    const header = req.headers?.['x-request-id'];
    const requestId = typeof header === 'string' && /^[\w\-.:]{1,128}$/.test(header) ? header : undefined;

    await watchup.runWithContext({ method, route, ...(requestId && { requestId }) }, async () => {
      const end = watchup.startTrace(route, { type: 'http' });
      let failed = false;
      res.once?.('finish', () => {
        if (!failed) end({ status: statusOf(res.statusCode), statusCode: res.statusCode, meta: { method } });
      });
      try {
        await handler(req, res);
      } catch (err) {
        failed = true;
        end({ status: 'err', statusCode: 500, meta: { method } });
        watchup.captureError(err, { route, level: 'error', request: { method, path: normalisePath(req.url ?? '/') } });
        throw err;
      }
    });
  };
}

/**
 * Next.js 15 `onRequestError` instrumentation hook: reports errors from
 * Server Components, Route Handlers, Server Actions and middleware.
 *
 * @example
 * // instrumentation.ts
 * export { captureRequestError as onRequestError } from '@watchupltd/nextjs/server';
 */
export function captureRequestError(
  error: unknown,
  request: { path?: string; method?: string; headers?: Record<string, string | string[] | undefined> },
  context: { routerKind?: string; routePath?: string; routeType?: string; renderSource?: string },
): void {
  if (process.env.NEXT_RUNTIME === 'edge') return;
  const method = String(request.method ?? 'GET').toUpperCase();
  const routePath = context.routePath ?? normalisePath(request.path ?? '/');
  getWatchup().captureError(error, {
    route: `${method} ${routePath}`,
    level: 'error',
    next: {
      router_kind: context.routerKind,
      route_type: context.routeType,
      ...(context.renderSource && { render_source: context.renderSource }),
    },
    request: { method, path: normalisePath(request.path ?? '/') },
  });
}
