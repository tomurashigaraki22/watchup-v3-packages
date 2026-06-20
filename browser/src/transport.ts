// ─────────────────────────────────────────────────────────────────────────────
// @watchupltd/browser  ·  transport
//
// Two delivery strategies:
//   1. fetch(keepalive: true) — for regular periodic flushes.
//   2. navigator.sendBeacon  — for page-hide/unload; survives tab close.
//
// Web analytics events are sent to a separate endpoint (/web-batch) that is
// optimised for high-volume, low-latency browser hits.
// ─────────────────────────────────────────────────────────────────────────────

import type { IngestBatch, WebAnalyticsBatch } from './types.js';

export class Transport {
  private readonly url:      string;
  private readonly webUrl:   string;
  private readonly headers:  Record<string, string>;
  private readonly debug:    boolean;

  constructor(baseUrl: string, apiKey: string, debug = false) {
    const base     = baseUrl.replace(/\/$/, '');
    this.url       = `${base}/api/v1/ingest/batch`;
    this.webUrl    = `${base}/api/v1/ingest/web-batch`;
    this.headers   = {
      'Content-Type': 'application/json',
      'X-Api-Key':    apiKey,
    };
    this.debug = debug;
  }

  /**
   * Send via `fetch` with `keepalive: true`.
   * `keepalive` lets the request outlive the current page — it's the
   * browser equivalent of a "fire and forget" POST.
   * Never rejects.
   */
  async send(batch: IngestBatch): Promise<void> {
    try {
      const body = JSON.stringify(batch);

      // keepalive has a 64 KiB payload limit; fall back to beacon for large batches
      if (body.length > 60_000) {
        this.beacon(batch);
        return;
      }

      const res = await fetch(this.url, {
        method:    'POST',
        headers:   this.headers,
        body,
        keepalive: true,
      });

      if (this.debug && !res.ok) {
        const text = await res.text().catch(() => '');
        console.warn(`[watchup] ingest ${res.status}: ${text}`);
      }
    } catch (err) {
      if (this.debug) console.warn('[watchup] send failed:', err);
    }
  }

  /**
   * Send web analytics batch to the dedicated /web-batch endpoint.
   * Never rejects.
   */
  async sendWeb(batch: WebAnalyticsBatch): Promise<void> {
    try {
      const body = JSON.stringify(batch);

      if (body.length > 60_000) {
        this.beaconWeb(batch);
        return;
      }

      const res = await fetch(this.webUrl, {
        method:    'POST',
        headers:   this.headers,
        body,
        keepalive: true,
      });

      if (this.debug && !res.ok) {
        const text = await res.text().catch(() => '');
        console.warn(`[watchup] web-batch ${res.status}: ${text}`);
      }
    } catch (err) {
      if (this.debug) console.warn('[watchup] sendWeb failed:', err);
    }
  }

  /**
   * Send via `navigator.sendBeacon`.
   * Returns `true` if the browser accepted the request (doesn't guarantee delivery).
   * The server must accept `application/json` from sendBeacon via a Blob.
   */
  beacon(batch: IngestBatch): boolean {
    if (typeof navigator === 'undefined' || !navigator.sendBeacon) return false;
    try {
      const blob = new Blob([JSON.stringify(batch)], { type: 'application/json' });
      return navigator.sendBeacon(this.url, blob);
    } catch {
      return false;
    }
  }

  /**
   * sendBeacon variant for web analytics events.
   */
  beaconWeb(batch: WebAnalyticsBatch): boolean {
    if (typeof navigator === 'undefined' || !navigator.sendBeacon) return false;
    try {
      const blob = new Blob([JSON.stringify(batch)], { type: 'application/json' });
      return navigator.sendBeacon(this.webUrl, blob);
    } catch {
      return false;
    }
  }
}
