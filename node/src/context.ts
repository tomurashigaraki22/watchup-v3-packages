// ─────────────────────────────────────────────────────────────────────────────
// @watchupltd/node  ·  request context
//
// AsyncLocalStorage keeps user identity and request IDs per request, so
// concurrent requests never see each other's user.
// ─────────────────────────────────────────────────────────────────────────────

import { AsyncLocalStorage } from 'node:async_hooks';
import type { RequestContext } from './types.js';

export const requestContext = new AsyncLocalStorage<RequestContext>();

/** Parse a W3C `traceparent` header into its trace ID. */
export function traceIdFrom(header: unknown): string | undefined {
  if (typeof header !== 'string') return undefined;
  const match = /^[\da-f]{2}-([\da-f]{32})-[\da-f]{16}-[\da-f]{2}$/i.exec(header.trim());
  return match?.[1]?.toLowerCase();
}

/** Accept a client-supplied request ID only if it is short and printable. */
export function safeRequestId(header: unknown): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== 'string') return undefined;
  return /^[\w\-.:]{1,128}$/.test(value) ? value : undefined;
}
