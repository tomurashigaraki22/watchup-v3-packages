// ─────────────────────────────────────────────────────────────────────────────
// @watchupltd/browser  ·  batcher
//
// Browser-specific flush strategy:
//  - Periodic interval flush via fetch(keepalive)
//  - visibilitychange 'hidden' + pagehide → sendBeacon for reliable exit delivery
//
// Two independent queues:
//  - telemetry queue  (traces, errors, events) → /ingest/batch
//  - web queue        (web page views)          → /ingest/web-batch
// ─────────────────────────────────────────────────────────────────────────────

import type {
  TracePayload,
  ErrorPayload,
  EventPayload,
  IngestBatch,
  WebAnalyticsPayload,
  WebAnalyticsBatch,
} from './types.js';
import { Transport } from './transport.js';

export class Batcher {
  private traces:    TracePayload[]          = [];
  private errors:    ErrorPayload[]          = [];
  private events:    EventPayload[]          = [];
  private webViews:  WebAnalyticsPayload[]   = [];

  private readonly transport:     Transport;
  private readonly flushInterval: number;
  private readonly maxBatchSize:  number;

  private timer:    ReturnType<typeof setInterval> | null = null;
  private flushing = false;

  constructor(transport: Transport, flushInterval: number, maxBatchSize: number) {
    this.transport     = transport;
    this.flushInterval = flushInterval;
    this.maxBatchSize  = maxBatchSize;
  }

  start(): void {
    if (this.timer) return;

    // Periodic flush
    this.timer = setInterval(() => this.flush(), this.flushInterval);

    // Reliable delivery on tab hide — visibilitychange fires before the page
    // is destroyed, giving sendBeacon the best chance of succeeding.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.beaconFlush();
    });

    // Belt-and-suspenders for browsers/environments that skip visibilitychange
    window.addEventListener('pagehide', () => this.beaconFlush(), { once: true });
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  // ── Telemetry queue ───────────────────────────────────────────────────────

  addTrace(t: TracePayload): void {
    this.traces.push(t);
    if (this.traces.length >= this.maxBatchSize) this.flush();
  }

  addError(e: ErrorPayload): void {
    this.errors.push(e);
    // Errors are high-priority — flush at half capacity
    if (this.errors.length >= Math.ceil(this.maxBatchSize / 2)) this.flush();
  }

  addEvent(e: EventPayload): void {
    this.events.push(e);
    if (this.events.length >= this.maxBatchSize) this.flush();
  }

  // ── Web analytics queue ───────────────────────────────────────────────────

  addWebView(payload: WebAnalyticsPayload): void {
    this.webViews.push(payload);
    if (this.webViews.length >= this.maxBatchSize) this.flushWeb();
  }

  // ── Drain helpers ─────────────────────────────────────────────────────────

  private drainTelemetry(): IngestBatch | null {
    const traces = this.traces.splice(0);
    const errors = this.errors.splice(0);
    const events = this.events.splice(0);
    if (!traces.length && !errors.length && !events.length) return null;
    return { traces, errors, events };
  }

  private drainWeb(): WebAnalyticsBatch | null {
    const web = this.webViews.splice(0);
    if (!web.length) return null;
    return { web };
  }

  // ── Flush ─────────────────────────────────────────────────────────────────

  flush(): void {
    if (!this.flushing) {
      const batch = this.drainTelemetry();
      if (batch) {
        this.flushing = true;
        this.transport.send(batch).finally(() => { this.flushing = false; });
      }
    }
    this.flushWeb();
  }

  flushWeb(): void {
    const batch = this.drainWeb();
    if (batch) this.transport.sendWeb(batch);
  }

  beaconFlush(): void {
    // Telemetry
    const batch = this.drainTelemetry();
    if (batch) {
      if (!this.transport.beacon(batch)) this.transport.send(batch);
    }
    // Web analytics
    const webBatch = this.drainWeb();
    if (webBatch) {
      if (!this.transport.beaconWeb(webBatch)) this.transport.sendWeb(webBatch);
    }
  }
}
