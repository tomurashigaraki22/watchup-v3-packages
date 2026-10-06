// ─────────────────────────────────────────────────────────────────────────────
// @watchupltd/svelte/server  ·  SvelteKit server hooks (hooks.server.ts)
//
// Pair with @watchupltd/node. This entry never imports browser code, and
// the browser entry never imports this one, so neither leaks across the
// SvelteKit server/client boundary.
// ─────────────────────────────────────────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */

/** The subset of @watchupltd/node's client these hooks use. */
export interface ServerWatchup {
  runWithContext<T>(context: { method?: string; route?: string; requestId?: string }, fn: () => T): T;
  startTrace(
    span: string,
    options?: { type?: 'http' },
  ): (opts?: { status?: 'ok' | 'warn' | 'err'; statusCode?: number; meta?: Record<string, unknown> }) => void;
  captureError(error: unknown, context?: Record<string, unknown>): void;
}

/** Structural subset of SvelteKit's RequestEvent (no @sveltejs/kit dependency). */
interface RequestEventLike {
  request: Request;
  url: URL;
  route: { id: string | null };
}

function routeOf(event: RequestEventLike): string {
  const path = event.route.id ?? event.url.pathname.replace(/\/\d+(?=\/|$)/g, '/:id');
  return `${event.request.method.toUpperCase()} ${path}`;
}

function requestIdOf(request: Request): string | undefined {
  const value = request.headers.get('x-request-id');
  return value && /^[\w\-.:]{1,128}$/.test(value) ? value : undefined;
}

/**
 * `handle` hook: one trace per request with the route ID and real status, and
 * a per-request context so `setUser` is request-scoped.
 *
 * @example
 * // src/hooks.server.ts
 * import { Watchup } from '@watchupltd/node';
 * import { watchupHandle, watchupHandleError } from '@watchupltd/svelte/server';
 * const watchup = new Watchup({ apiKey: env.WATCHUP_API_KEY });
 * export const handle = watchupHandle(watchup);
 * export const handleError = watchupHandleError(watchup);
 */
export function watchupHandle(watchup: ServerWatchup) {
  return async ({
    event,
    resolve,
  }: {
    event: RequestEventLike;
    resolve: (event: any) => Response | Promise<Response>;
  }): Promise<Response> => {
    const route = routeOf(event);
    const method = event.request.method.toUpperCase();
    const requestId = requestIdOf(event.request);
    return watchup.runWithContext({ method, route, ...(requestId && { requestId }) }, async () => {
      const end = watchup.startTrace(route, { type: 'http' });
      try {
        const response = await resolve(event);
        const code = response.status;
        end({ status: code >= 500 ? 'err' : code >= 400 ? 'warn' : 'ok', statusCode: code, meta: { method } });
        return response;
      } catch (err) {
        end({ status: 'err', statusCode: 500, meta: { method } });
        throw err;
      }
    });
  };
}

/**
 * `handleError` hook: reports unexpected server errors (not 4xx such as 404).
 * Returns nothing, so SvelteKit's default error message is kept.
 */
export function watchupHandleError(watchup: ServerWatchup) {
  return ({ error, event, status }: { error: unknown; event: RequestEventLike; status?: number; message?: string }): void => {
    if (status !== undefined && status < 500) return;
    watchup.captureError(error, {
      route: routeOf(event),
      level: 'error',
      request: { method: event.request.method, path: event.route.id ?? event.url.pathname },
    });
  };
}
