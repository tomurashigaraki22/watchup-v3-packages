// ─────────────────────────────────────────────────────────────────────────────
// @watchupltd/node  ·  transport
//
// Thin HTTP layer around fetch (Node ≥ 18 built-in).
// All failures are swallowed — the SDK must never crash the host application.
// ─────────────────────────────────────────────────────────────────────────────

import type { IngestBatch } from './types.js';

export class Transport {
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly debug: boolean;

  constructor(baseUrl: string, apiKey: string, debug = false) {
    this.url   = `${baseUrl.replace(/\/$/, '')}/api/v1/ingest/batch`;
    this.headers = {
      'Content-Type': 'application/json',
      'X-Api-Key':    apiKey,
      'User-Agent':   `@watchupltd/node`,
    };
    this.debug = debug;
  }

  /**
   * POST `batch` to the Watchup ingest endpoint.
   * Never rejects — any error is logged (if debug) and silently dropped.
   */
  async send(batch: IngestBatch): Promise<void> {
    try {
      const res = await fetch(this.url, {
        method:  'POST',
        headers: this.headers,
        body:    JSON.stringify(batch),
        // 8-second hard timeout; slow API shouldn't hold up the queue.
        signal:  AbortSignal.timeout(8_000),
      });

      if (this.debug && !res.ok) {
        const body = await res.text().catch(() => '(no body)');
        console.warn(`[watchup] ingest ${res.status}: ${body}`);
      }
    } catch (err) {
      if (this.debug) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[watchup] send failed: ${msg}`);
      }
      // Intentionally no re-throw.
    }
  }
}
