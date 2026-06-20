// ─────────────────────────────────────────────────────────────────────────────
// @watchupltd/node  ·  batcher
//
// Accumulates traces/errors/events and flushes them in batches.
// The flush timer is unref()'d so it never prevents the process from exiting.
// ─────────────────────────────────────────────────────────────────────────────

import type { TracePayload, ErrorPayload, EventPayload } from './types.js';
import { Transport } from './transport.js';

export class Batcher {
  private traces: TracePayload[] = [];
  private errors: ErrorPayload[] = [];
  private events: EventPayload[] = [];

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

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  start(): void {
    if (this.timer) return;

    // Periodic flush
    this.timer = setInterval(() => { this.flush(); }, this.flushInterval);
    // Don't keep the process alive just for us
    if (typeof this.timer.unref === 'function') this.timer.unref();

    // On normal process wind-down, flush whatever is left.
    // `beforeExit` fires after the event loop drains — async ops CAN complete here.
    process.once('beforeExit', () => this.flush());

    // For SIGTERM / SIGINT: flush, then re-signal so the app's own handlers run.
    const handleSignal = (sig: NodeJS.Signals) => {
      process.removeAllListeners(sig);       // clear our own listener first
      this.flush();                           // best-effort, fire-and-forget
      // Give the flush up to 1 s before giving up and re-raising
      setTimeout(() => process.kill(process.pid, sig), 1_000).unref?.();
    };

    process.once('SIGTERM', () => handleSignal('SIGTERM'));
    process.once('SIGINT',  () => handleSignal('SIGINT'));
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // ── Enqueue ─────────────────────────────────────────────────────────────────

  addTrace(trace: TracePayload): void {
    this.traces.push(trace);
    if (this.traces.length >= this.maxBatchSize) this.flush();
  }

  addError(error: ErrorPayload): void {
    this.errors.push(error);
    // Errors are higher priority — flush at half capacity
    if (this.errors.length >= Math.ceil(this.maxBatchSize / 2)) this.flush();
  }

  addEvent(event: EventPayload): void {
    this.events.push(event);
    if (this.events.length >= this.maxBatchSize) this.flush();
  }

  // ── Flush ───────────────────────────────────────────────────────────────────

  /**
   * Drain queues and send a batch.  Non-blocking; safe to call at any time.
   */
  flush(): void {
    // Prevent a second flush racing with an in-flight one
    if (this.flushing) return;

    const traces = this.traces.splice(0);
    const errors = this.errors.splice(0);
    const events = this.events.splice(0);

    if (!traces.length && !errors.length && !events.length) return;

    this.flushing = true;
    this.transport
      .send({ traces, errors, events })
      .finally(() => { this.flushing = false; });
  }
}
