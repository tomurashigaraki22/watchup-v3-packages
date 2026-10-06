// ─────────────────────────────────────────────────────────────────────────────
// @watchupltd/node  ·  transport
//
// Thin HTTP layer around fetch (Node ≥ 18 built-in). Never throws — failures
// become SendResults so the queue can decide whether to retry.
// ─────────────────────────────────────────────────────────────────────────────

import { INGEST_PATH, ingestHeaders, toSendResult, type Chunk, type SendResult } from '@watchupltd/core';
import { SDK_NAME, SDK_VERSION } from './version.js';

export class Transport {
  private readonly url: string;

  constructor(
    baseUrl: string,
    private readonly apiKey: string,
    private readonly timeoutMs = 8_000,
  ) {
    this.url = `${baseUrl.replace(/\/+$/, '')}${INGEST_PATH}`;
  }

  async send(chunk: Chunk): Promise<SendResult> {
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: ingestHeaders({
          apiKey: this.apiKey,
          sdk: { name: SDK_NAME, version: SDK_VERSION },
          idempotencyKey: chunk.idempotencyKey,
          includeIdempotencyHeader: true,
          includeUserAgent: true,
        }),
        body: chunk.body,
        // A slow API must not hold the queue forever.
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      return await toSendResult(res);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
