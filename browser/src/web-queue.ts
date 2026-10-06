// ─────────────────────────────────────────────────────────────────────────────
// @watchupltd/browser  ·  web analytics queue
//
// Page views go to /ingest/web-batch, separate from telemetry. Each view is a
// few hundred bytes, so this queue only needs count and byte guards: batches
// stay under the beacon budget so they can always be sent on unload.
// ─────────────────────────────────────────────────────────────────────────────

import { LIMITS, utf8ByteLength } from '@watchupltd/core';
import type { WebAnalyticsBatch, WebAnalyticsPayload } from './types.js';

const MAX_QUEUED_VIEWS = 500;

export class WebQueue {
  private views: Array<{ payload: WebAnalyticsPayload; bytes: number }> = [];

  constructor(
    private readonly projectId: string | undefined,
    private readonly maxItems: number,
  ) {}

  add(payload: WebAnalyticsPayload): boolean {
    this.views.push({ payload, bytes: utf8ByteLength(JSON.stringify(payload)) });
    if (this.views.length > MAX_QUEUED_VIEWS) this.views.shift();
    return this.views.length >= this.maxItems;
  }

  get size(): number {
    return this.views.length;
  }

  /** Remove everything as batches below the beacon byte budget. */
  drain(): WebAnalyticsBatch[] {
    const batches: WebAnalyticsBatch[] = [];
    let current: WebAnalyticsPayload[] = [];
    let bytes = 64; // envelope overhead
    for (const view of this.views) {
      if (current.length && (bytes + view.bytes + 1 > LIMITS.BEACON_MAX_BYTES || current.length >= this.maxItems)) {
        batches.push(this.batch(current));
        current = [];
        bytes = 64;
      }
      current.push(view.payload);
      bytes += view.bytes + 1;
    }
    if (current.length) batches.push(this.batch(current));
    this.views = [];
    return batches;
  }

  private batch(web: WebAnalyticsPayload[]): WebAnalyticsBatch {
    return this.projectId ? { web, project_id: this.projectId } : { web };
  }
}
