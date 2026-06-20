// ─────────────────────────────────────────────────────────────────────────────
// @watchupltd/nextjs  ·  Route handler wrapper (App Router)
//
// Wraps a Next.js App Router Route Handler, automatically tracing duration
// and forwarding unhandled errors to Watchup.
// ─────────────────────────────────────────────────────────────────────────────

import { type NextRequest, NextResponse } from 'next/server.js';
import { getWatchup } from './watchup.js';

type RouteHandler = (
  req:     NextRequest,
  context: { params: Record<string, string | string[]> },
) => Response | NextResponse | Promise<Response | NextResponse>;

/**
 * Wraps a Next.js App Router Route Handler with automatic tracing and error
 * capture.
 *
 * @example
 * // app/api/orders/route.ts
 * import { withWatchupRoute } from '@watchupltd/nextjs/server';
 *
 * export const GET = withWatchupRoute(async (req) => {
 *   const orders = await db.order.findMany();
 *   return Response.json(orders);
 * });
 */
export function withWatchupRoute(handler: RouteHandler): RouteHandler {
  return async (req, context) => {
    const watchup = getWatchup();
    const span    = `${req.method} ${new URL(req.url).pathname}`;
    const end     = watchup.startTrace(span);

    try {
      const response = await handler(req, context);
      const status   = response instanceof Response ? response.status : 200;
      end({
        status: status >= 500 ? 'err' : status >= 400 ? 'warn' : 'ok',
        meta:   { status_code: status },
      });
      return response;
    } catch (err) {
      end({ status: 'err' });
      watchup.captureError(err, {
        route: new URL(req.url).pathname,
        level: 'error',
      });
      throw err; // let Next.js handle the 500
    }
  };
}
