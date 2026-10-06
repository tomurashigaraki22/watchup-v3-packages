// ─────────────────────────────────────────────────────────────────────────────
// @watchupltd/react-native  ·  transport
//
// fetch with an AbortController timeout (Hermes has no AbortSignal.timeout).
// React Native has no CORS, so the Idempotency-Key header is sent.
// ─────────────────────────────────────────────────────────────────────────────

import { INGEST_PATH, ingestHeaders, toSendResult, type Chunk, type SendResult } from '@watchupltd/core';
import { SDK_NAME, SDK_VERSION } from './version.js';

export class Transport {
  private readonly url: string;

  constructor(
    baseUrl: string,
    private readonly apiKey: string,
    private readonly timeoutMs = 10_000,
  ) {
    this.url = `${baseUrl.replace(/\/+$/, '')}${INGEST_PATH}`;
  }

  async send(chunk: Chunk): Promise<SendResult> {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : null;
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
        ...(controller && { signal: controller.signal }),
      });
      return await toSendResult(res);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
