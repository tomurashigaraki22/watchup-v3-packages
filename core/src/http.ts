// ─────────────────────────────────────────────────────────────────────────────
// @watchupltd/core  ·  HTTP helpers shared by fetch-based transports
// ─────────────────────────────────────────────────────────────────────────────

import { LIMITS } from './constants';
import type { SendResult, SdkInfo } from './types';

/** Statuses worth retrying (spec §7). */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/** Parse a `Retry-After` header (seconds or HTTP date) into capped ms. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  let ms: number;
  if (Number.isFinite(seconds)) ms = seconds * 1000;
  else {
    const at = Date.parse(value);
    if (Number.isNaN(at)) return undefined;
    ms = at - now;
  }
  return Math.max(0, Math.min(ms, LIMITS.MAX_RETRY_AFTER_MS));
}

/** Pull the snake_case `code` out of a WatchUp JSON error body. */
export function parseErrorCode(body: string): string | undefined {
  try {
    const json = JSON.parse(body) as { code?: unknown };
    return typeof json.code === 'string' ? json.code : undefined;
  } catch {
    return undefined;
  }
}

export interface HeaderOptions {
  apiKey: string;
  sdk: SdkInfo;
  idempotencyKey?: string;
  /** Browsers must not set custom headers the server's CORS policy rejects. */
  includeIdempotencyHeader: boolean;
  includeUserAgent: boolean;
}

export function ingestHeaders(opts: HeaderOptions): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${opts.apiKey}`,
    'X-Api-Key': opts.apiKey,
  };
  if (opts.includeIdempotencyHeader && opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  if (opts.includeUserAgent) headers['User-Agent'] = `${opts.sdk.name}/${opts.sdk.version}`;
  return headers;
}

interface ResponseLike {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

/** Turn a fetch Response into the queue's SendResult. Never throws. */
export async function toSendResult(res: ResponseLike): Promise<SendResult> {
  if (res.ok) return { ok: true, status: res.status };
  const body = await res.text().catch(() => '');
  const result: SendResult = { ok: false, status: res.status };
  const code = parseErrorCode(body);
  if (code) result.code = code;
  else if (res.status === 413) result.code = 'payload_too_large';
  const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
  if (retryAfter !== undefined) result.retryAfterMs = retryAfter;
  return result;
}
