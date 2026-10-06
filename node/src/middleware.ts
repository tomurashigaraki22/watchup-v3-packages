// ─────────────────────────────────────────────────────────────────────────────
// @watchupltd/node  ·  Express / Node HTTP helpers
// ─────────────────────────────────────────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Replace variable path segments with `:id` so `/users/42` and `/users/abc-…`
 * group under one span. Only used when the framework has no route template
 * (404s, middleware-only paths).
 */
export function normalisePath(path: string): string {
  const clean = (path.split('?')[0] ?? '/') || '/';
  return clean
    // UUIDs
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\/|$)/gi, '/:id')
    // Mongo ObjectIds and long hex hashes
    .replace(/\/[0-9a-f]{24,64}(?=\/|$)/gi, '/:id')
    // Numeric IDs
    .replace(/\/\d+(?=\/|$)/g, '/:id')
    // Strip trailing slashes except for root
    .replace(/(.+)\/$/, '$1');
}

function templateOf(route: any): string | undefined {
  const path = route?.path;
  if (typeof path === 'string') return path;
  if (Array.isArray(path)) return path.map(String).join('|');
  if (path instanceof RegExp) return path.toString();
  return undefined;
}

/** `METHOD /mount/route/:param` from Express, or a normalised raw path. */
export function routeName(req: any): string {
  const method = String(req.method ?? 'GET').toUpperCase();
  const template = templateOf(req.route);
  if (template !== undefined) {
    const base = typeof req.baseUrl === 'string' ? req.baseUrl : '';
    const full = `${base}${template === '/' && base ? '' : template}` || '/';
    return `${method} ${full}`;
  }
  return `${method} ${normalisePath(String(req.originalUrl ?? req.url ?? req.path ?? '/'))}`;
}

export function traceStatus(statusCode: number): 'ok' | 'warn' | 'err' {
  if (statusCode >= 500) return 'err';
  if (statusCode >= 400) return 'warn';
  return 'ok';
}

const SAFE_HEADERS = ['user-agent', 'content-type', 'accept', 'referer', 'origin', 'x-request-id', 'x-correlation-id'];

/** Request metadata without credentials, cookies or bodies. */
export function requestDetails(req: any): Record<string, unknown> {
  const headers: Record<string, unknown> = {};
  for (const name of SAFE_HEADERS) {
    const value = req.headers?.[name];
    if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  const url = String(req.originalUrl ?? req.url ?? '/');
  return {
    method: req.method,
    path: normalisePath(url),
    // Query strings are kept for debugging; the core scrubber removes secret params.
    url,
    headers,
  };
}

/** Status an error asks for (`err.status`/`err.statusCode`), defaulting to 500. */
export function errorStatus(err: any): number {
  const status = Number(err?.status ?? err?.statusCode);
  return Number.isInteger(status) && status >= 400 && status < 600 ? status : 500;
}
