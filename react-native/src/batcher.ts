import type { ErrorPayload, EventPayload, IngestBatch, TracePayload } from './types.js';
import { Transport } from './transport.js';

export class Batcher {
  private traces: TracePayload[] = [];
  private errors: ErrorPayload[] = [];
  private events: EventPayload[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly transport: Transport,
    private readonly flushInterval: number,
    private readonly maxBatchSize: number,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.flush(), this.flushInterval);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  addTrace(payload: TracePayload): void {
    this.traces.push(payload);
    this.flushIfNeeded();
  }

  addError(payload: ErrorPayload): void {
    this.errors.push(payload);
    this.flushIfNeeded();
  }

  addEvent(payload: EventPayload): void {
    this.events.push(payload);
    this.flushIfNeeded();
  }

  flush(): void {
    if (!this.traces.length && !this.errors.length && !this.events.length) return;

    const batch: IngestBatch = {
      traces: this.traces.splice(0),
      errors: this.errors.splice(0),
      events: this.events.splice(0),
    };

    void this.transport.sendBatch(batch);
  }

  private flushIfNeeded(): void {
    const size = this.traces.length + this.errors.length + this.events.length;
    if (size >= this.maxBatchSize) this.flush();
  }
}
