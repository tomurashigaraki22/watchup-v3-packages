// ─────────────────────────────────────────────────────────────────────────────
// @watchupltd/browser  ·  transport
//
// Delivery strategies (spec §1, §8):
//   1. fetch — regular flushes. `keepalive` is set only for bodies under the
//      browser's 64 KiB keepalive budget, so large chunks are never dropped.
//   2. navigator.sendBeacon — page hide/unload, only for chunks that were
//      already split below BEACON_MAX_BYTES. sendBeacon cannot set headers, so
//      browser envelopes carry the public key as `project_id`, and the body is
//      sent as text/plain to avoid a credentialed CORS preflight.
//
// The Idempotency-Key header is not sent from browsers because the production
// CORS policy does not allow it; the key travels in the body instead.
// ─────────────────────────────────────────────────────────────────────────────

import {
  INGEST_PATH,
  LIMITS,
  ingestHeaders,
  toSendResult,
  type Chunk,
  type SendResult,
} from '@watchupltd/core';
import type { WebAnalyticsBatch } from './types.js';
import { SDK_NAME, SDK_VERSION } from './version.js';

export class Transport {
  readonly url: string;
  readonly webUrl: string;
  private readonly headers: Record<string, string>;
  private readonly warn: (...args: unknown[]) => void;

  constructor(baseUrl: string, apiKey: string, warn: (...args: unknown[]) => void) {
    const base = baseUrl.replace(/\/+$/, '');
    this.url = `${base}${INGEST_PATH}`;
    this.webUrl = `${base}/api/v1/ingest/web-batch`;
    this.headers = ingestHeaders({
      apiKey,
      sdk: { name: SDK_NAME, version: SDK_VERSION },
      includeIdempotencyHeader: false,
      includeUserAgent: false,
    });
    this.warn = warn;
  }

  /** Send one chunk with fetch. Never rejects. */
  async send(chunk: Chunk): Promise<SendResult> {
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: this.headers,
        body: chunk.body,
        keepalive: chunk.bytes <= LIMITS.BEACON_MAX_BYTES,
      });
      return await toSendResult(res);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Hand a chunk to sendBeacon during unload. Only chunks within the beacon
   * budget are passed to the browser. Returns false when it refuses (for
   * example once its ~64 KiB in-flight budget is used up).
   */
  beaconChunk(chunk: Chunk): boolean {
    return chunk.bytes <= LIMITS.BEACON_MAX_BYTES && this.beacon(this.url, chunk.body);
  }

  /** Web analytics go to their own high-volume endpoint. Never rejects. */
  async sendWeb(batch: WebAnalyticsBatch): Promise<void> {
    const body = JSON.stringify(batch);
    try {
      const res = await fetch(this.webUrl, {
        method: 'POST',
        headers: this.headers,
        body,
        keepalive: body.length <= LIMITS.BEACON_MAX_BYTES,
      });
      if (!res.ok) this.warn(`[watchup] web-batch ${res.status}`);
    } catch (err) {
      this.warn('[watchup] web-batch failed:', err instanceof Error ? err.message : err);
    }
  }

  sendWebOnUnload(batch: WebAnalyticsBatch): void {
    const body = JSON.stringify(batch);
    if (body.length <= LIMITS.BEACON_MAX_BYTES && this.beacon(this.webUrl, body)) return;
    void this.sendWeb(batch);
  }

  private beacon(url: string, body: string): boolean {
    if (typeof navigator === 'undefined' || typeof navigator.sendBeacon !== 'function') return false;
    try {
      // text/plain is CORS-safelisted, so there is no preflight. sendBeacon
      // always sends credentials, so an application/json Blob would need the
      // API to answer with Access-Control-Allow-Credentials, which it does not.
      // The server parses the JSON body whatever the content type.
      return navigator.sendBeacon(url, new Blob([body], { type: 'text/plain;charset=UTF-8' }));
    } catch {
      return false;
    }
  }
}
