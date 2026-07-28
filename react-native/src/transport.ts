import type { IngestBatch } from './types.js';

export class Transport {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly debug = false,
  ) {}

  async sendBatch(batch: IngestBatch): Promise<void> {
    const hasItems = Boolean(batch.errors?.length || batch.events?.length || batch.traces?.length);
    if (!hasItems) return;

    try {
      const res = await fetch(`${this.baseUrl}/api/v1/ingest/batch`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Key': this.apiKey,
        },
        body: JSON.stringify(batch),
      });

      if (!res.ok && this.debug) {
        console.warn('[watchup] batch send failed', res.status, await res.text().catch(() => ''));
      }
    } catch (error) {
      if (this.debug) console.warn('[watchup] batch send failed', error);
    }
  }
}
