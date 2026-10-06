// ─────────────────────────────────────────────────────────────────────────────
// @watchupltd/core  ·  delivery queue (spec §4, §7, §8)
//
// Single drain loop: items move from the pending queues into exactly one
// chunk, one chunk is in flight at a time, failed chunks wait for their retry
// time without blocking newer chunks, and retries reuse the idempotency key.
// ─────────────────────────────────────────────────────────────────────────────

import { LIMITS } from './constants';
import { buildChunks, envelopeOverhead } from './chunker';
import { isRetryableStatus } from './http';
import { normalize, type NormalizeOptions } from './normalize';
import { defaultSetInterval, defaultSetTimer, defaultSleep, uuid, type Cancel } from './runtime';
import { fitItem } from './truncate';
import { utf8ByteLength } from './utf8';
import {
  KIND_ORDER,
  type Chunk,
  type Diagnostic,
  type DiagnosticHandler,
  type EnvelopeBase,
  type FlushResult,
  type Kind,
  type PreparedItem,
  type QueueSnapshot,
  type SendResult,
  type Sender,
} from './types';

export interface DeliveryQueueOptions {
  send: Sender;
  /** Envelope fields; read on every flush so environment/release can change. */
  base: () => EnvelopeBase;
  maxBytes?: number;
  maxItems?: number;
  maxQueueItems?: number;
  maxAttempts?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  /** Flush once this many errors are waiting (errors are high priority). */
  errorFlushThreshold?: number;
  /** Flush automatically when size/count thresholds are reached. Default: true. */
  autoFlush?: boolean;
  normalize?: NormalizeOptions;
  onDiagnostic?: DiagnosticHandler;
  /** Called after the queue's persisted state changes (React Native storage). */
  onChange?: () => void;
  // Injection points for deterministic tests.
  now?: () => number;
  random?: () => number;
  setTimer?: (fn: () => void, ms: number) => Cancel;
  setInterval?: (fn: () => void, ms: number) => Cancel;
  /**
   * Wait used by shutdown(). Unlike the background timers it keeps the process
   * alive, so a short-lived script does not exit before its retries run.
   */
  sleep?: (ms: number) => Promise<void>;
  newBatchId?: () => string;
}

export interface FlushOptions {
  /** Send retry chunks even if their backoff has not elapsed. */
  force?: boolean;
  /** Override the chunk byte target (browser unload uses the beacon limit). */
  maxBytes?: number;
}

export interface ShutdownResult {
  deliveredItems: number;
  undeliveredItems: number;
}

const emptyGroups = (): Record<Kind, PreparedItem[]> => ({ errors: [], traces: [], events: [] });

function itemCount(chunk: Pick<Chunk, 'counts'>): number {
  return chunk.counts.errors + chunk.counts.traces + chunk.counts.events;
}

export class DeliveryQueue {
  private readonly opts: Required<
    Pick<
      DeliveryQueueOptions,
      | 'maxBytes'
      | 'maxItems'
      | 'maxQueueItems'
      | 'maxAttempts'
      | 'baseBackoffMs'
      | 'maxBackoffMs'
      | 'errorFlushThreshold'
      | 'now'
      | 'random'
      | 'setTimer'
      | 'setInterval'
      | 'sleep'
      | 'newBatchId'
    >
  > &
    DeliveryQueueOptions;

  private pending = emptyGroups();
  private pendingBytes = 0;
  private retry: Chunk[] = [];
  private running: Promise<FlushResult> | null = null;
  /** True while the drain loop itself executes (not just until its promise settles). */
  private draining = false;
  private rerun = false;
  private overflow: Record<Kind, number> = { errors: 0, traces: 0, events: 0 };
  private cancelRetryTimer: Cancel | null = null;
  private retryTimerAt = 0;
  private cancelInterval: Cancel | null = null;
  private stopped = false;
  private paused = false;
  private delivered = 0;

  constructor(options: DeliveryQueueOptions) {
    const maxItems = options.maxItems ?? LIMITS.MAX_CHUNK_ITEMS;
    this.opts = {
      maxBytes: LIMITS.MAX_CHUNK_BYTES,
      maxQueueItems: LIMITS.MAX_QUEUE_ITEMS,
      maxAttempts: LIMITS.MAX_ATTEMPTS,
      baseBackoffMs: LIMITS.BASE_BACKOFF_MS,
      maxBackoffMs: LIMITS.MAX_BACKOFF_MS,
      errorFlushThreshold: Math.max(1, Math.ceil(maxItems / 2)),
      now: () => Date.now(),
      random: Math.random,
      setTimer: defaultSetTimer,
      setInterval: defaultSetInterval,
      sleep: defaultSleep,
      newBatchId: uuid,
      ...stripUndefined(options),
      send: options.send,
      base: options.base,
      maxItems: Math.min(maxItems, LIMITS.MAX_CHUNK_ITEMS),
    };
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  /** Start the periodic flush timer. Idempotent. */
  start(intervalMs: number): void {
    this.stopped = false;
    if (this.cancelInterval || intervalMs <= 0) return;
    this.cancelInterval = this.opts.setInterval(() => {
      void this.flush();
    }, intervalMs);
  }

  /** Stop all timers. Queued items stay queued. */
  stop(): void {
    this.stopped = true;
    this.cancelInterval?.();
    this.cancelInterval = null;
    this.cancelRetryTimer?.();
    this.cancelRetryTimer = null;
    this.retryTimerAt = 0;
  }

  /**
   * Hold delivery (e.g. while the device is offline). Items keep queueing and
   * no send attempts are made, so offline time never uses up retry attempts.
   */
  pause(): void {
    this.paused = true;
  }

  /** Resume delivery and immediately send everything that is waiting. */
  resume(): Promise<FlushResult> {
    this.paused = false;
    return this.flush({ force: true });
  }

  get isPaused(): boolean {
    return this.paused;
  }

  // ── Enqueue ─────────────────────────────────────────────────────────────────

  /**
   * Normalize, redact, fit and serialize `item`, then queue it.
   * Returns false if the item could not be serialized at all.
   */
  enqueue(kind: Kind, item: Record<string, unknown>): boolean {
    const normalized = normalize(item, this.opts.normalize);
    if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) return false;

    const budget = this.opts.maxBytes - envelopeOverhead(this.opts.base());
    const fit = fitItem(normalized as Record<string, unknown>, budget);
    if (fit.truncated) {
      this.diagnose('item_truncated', `A ${kind.slice(0, -1)} was truncated to fit the request size limit.`, {
        kind,
        bytes: fit.bytes,
      });
    }
    if (fit.oversized) {
      this.diagnose('item_oversized', `A ${kind.slice(0, -1)} is still larger than the chunk limit; it will be sent alone.`, {
        kind,
        bytes: fit.bytes,
      });
    }

    this.pending[kind].push({ kind, json: fit.json, bytes: fit.bytes });
    this.pendingBytes += fit.bytes;
    this.enforceBound();
    this.opts.onChange?.();

    const errors = this.pending.errors.length;
    if (
      this.opts.autoFlush !== false &&
      !this.stopped &&
      (this.pendingCount() >= this.opts.maxItems ||
        this.pendingBytes >= this.opts.maxBytes ||
        errors >= this.opts.errorFlushThreshold)
    ) {
      void this.flush();
    }
    return true;
  }

  pendingCount(): number {
    return this.pending.errors.length + this.pending.traces.length + this.pending.events.length;
  }

  retryingCount(): number {
    return this.retry.reduce((n, c) => n + itemCount(c), 0);
  }

  /** Total items delivered since construction. */
  deliveredCount(): number {
    return this.delivered;
  }

  // ── Flush ───────────────────────────────────────────────────────────────────

  /**
   * Send everything that is pending plus every retry that is due.
   * Concurrent calls share one drain loop; the returned promise settles after
   * items enqueued before the call have been attempted. Never rejects.
   */
  flush(options: FlushOptions = {}): Promise<FlushResult> {
    if (this.paused) return Promise.resolve({ accepted: 0, deliveredItems: 0, retrying: 0, dropped: 0 });
    if (this.draining && this.running) {
      this.rerun = true;
      if (options.force) this.forceNext = true;
      return this.running;
    }
    this.forceNext = Boolean(options.force);
    const run: Promise<FlushResult> = this.drain(options.maxBytes).finally(() => {
      if (this.running === run) this.running = null;
    });
    this.running = run;
    return run;
  }

  private forceNext = false;

  private async drain(maxBytes?: number): Promise<FlushResult> {
    const result: FlushResult = { accepted: 0, deliveredItems: 0, retrying: 0, dropped: 0 };
    this.draining = true;
    do {
      this.rerun = false;
      const force = this.forceNext;
      this.forceNext = false;
      this.reportOverflow();

      const now = this.opts.now();
      const due = this.retry.filter((c) => force || c.nextAttemptAt <= now);
      this.retry = this.retry.filter((c) => due.indexOf(c) === -1);
      const fresh = this.cut(maxBytes ?? this.opts.maxBytes);

      for (const chunk of [...due, ...fresh]) {
        await this.sendOne(chunk, result);
      }
      if (due.length || fresh.length) this.opts.onChange?.();
    } while (this.rerun);
    this.draining = false;

    this.scheduleRetry();
    return result;
  }

  /** Move every pending item into chunks. */
  private cut(maxBytes: number): Chunk[] {
    if (!this.pendingCount()) return [];
    const groups = this.pending;
    this.pending = emptyGroups();
    this.pendingBytes = 0;
    return buildChunks(
      groups,
      this.opts.base(),
      { maxBytes, maxItems: this.opts.maxItems },
      this.opts.newBatchId(),
      new Date(this.opts.now()).toISOString(),
      this.opts.now(),
    );
  }

  private async sendOne(chunk: Chunk, result: FlushResult): Promise<void> {
    chunk.attempts++;
    let res: SendResult;
    try {
      res = await this.opts.send(chunk);
    } catch (err) {
      res = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    if (res.ok) {
      result.accepted++;
      result.deliveredItems += itemCount(chunk);
      this.delivered += itemCount(chunk);
      return;
    }

    const details = {
      idempotency_key: chunk.idempotencyKey,
      attempt: chunk.attempts,
      items: itemCount(chunk),
      ...(res.status !== undefined && { status: res.status }),
      ...(res.code && { code: res.code }),
      ...(res.error && { error: res.error }),
    };

    if (res.status !== undefined && !isRetryableStatus(res.status)) {
      result.dropped++;
      this.diagnose('chunk_rejected', `The server rejected a batch (HTTP ${res.status}${res.code ? ` ${res.code}` : ''}); it will not be retried.`, details);
      return;
    }

    if (chunk.attempts >= this.opts.maxAttempts) {
      result.dropped++;
      this.diagnose('chunk_dropped', `A batch failed ${chunk.attempts} times and was dropped.`, details);
      return;
    }

    const delay = this.backoff(chunk.attempts, res.retryAfterMs);
    chunk.nextAttemptAt = this.opts.now() + delay;
    this.retry.push(chunk);
    result.retrying++;
    this.diagnose('chunk_retry', `Batch delivery failed; retrying in ${delay} ms.`, { ...details, delay_ms: delay });

    while (this.retry.length > LIMITS.MAX_RETRY_CHUNKS) {
      const dropped = this.retry.shift()!;
      result.dropped++;
      this.diagnose('chunk_dropped', 'Too many batches waiting for a retry; the oldest was dropped.', {
        idempotency_key: dropped.idempotencyKey,
        items: itemCount(dropped),
      });
    }
  }

  private backoff(attempt: number, retryAfterMs?: number): number {
    if (retryAfterMs !== undefined) return Math.min(retryAfterMs, LIMITS.MAX_RETRY_AFTER_MS);
    const exp = Math.min(this.opts.maxBackoffMs, this.opts.baseBackoffMs * 2 ** (attempt - 1));
    return Math.round(exp * (0.5 + this.opts.random() * 0.5));
  }

  private scheduleRetry(): void {
    if (this.stopped || !this.retry.length) return;
    const next = Math.min(...this.retry.map((c) => c.nextAttemptAt));
    if (this.cancelRetryTimer && this.retryTimerAt <= next) return;
    this.cancelRetryTimer?.();
    this.retryTimerAt = next;
    this.cancelRetryTimer = this.opts.setTimer(() => {
      this.cancelRetryTimer = null;
      this.retryTimerAt = 0;
      void this.flush();
    }, Math.max(0, next - this.opts.now()));
  }

  // ── Unload / shutdown ───────────────────────────────────────────────────────

  /**
   * Synchronously remove everything (pending and retries) as chunks no larger
   * than `maxBytes` where possible. Used for page unload, where the caller
   * hands each chunk to sendBeacon. Retry chunks keep their original size and
   * idempotency key.
   */
  takeAll(maxBytes: number): Chunk[] {
    const retries = this.retry;
    this.retry = [];
    this.cancelRetryTimer?.();
    this.cancelRetryTimer = null;
    const chunks = [...retries, ...this.cut(maxBytes)];
    this.opts.onChange?.();
    return chunks;
  }

  /**
   * Stop timers and deliver what can be delivered before `timeoutMs`,
   * honouring retry backoff. Reports anything left over.
   */
  async shutdown(timeoutMs = 5_000): Promise<ShutdownResult> {
    this.stop();
    const deadline = this.opts.now() + timeoutMs;
    const before = this.delivered;

    for (;;) {
      await this.flush();
      if (!this.pendingCount() && !this.retry.length) break;
      const next = Math.min(...this.retry.map((c) => c.nextAttemptAt));
      if (!this.retry.length || next > deadline) break;
      await this.opts.sleep(Math.max(0, next - this.opts.now()));
    }

    const undelivered = this.pendingCount() + this.retryingCount();
    if (undelivered) {
      this.diagnose('undelivered_on_shutdown', `${undelivered} item(s) could not be delivered before shutdown.`, {
        pending: this.pendingCount(),
        retrying: this.retryingCount(),
      });
    }
    return { deliveredItems: this.delivered - before, undeliveredItems: undelivered };
  }

  // ── Persistence (React Native offline queue) ────────────────────────────────

  snapshot(): QueueSnapshot {
    return {
      version: 1,
      pending: {
        errors: this.pending.errors.map((i) => i.json),
        traces: this.pending.traces.map((i) => i.json),
        events: this.pending.events.map((i) => i.json),
      },
      retry: this.retry.map(({ idempotencyKey, body, bytes, counts, attempts }) => ({
        idempotencyKey,
        body,
        bytes,
        counts,
        attempts,
      })),
    };
  }

  /** Merge a snapshot taken by a previous process ahead of anything queued now. */
  restore(snapshot: QueueSnapshot | null | undefined): void {
    if (snapshot?.version !== 1) return;
    for (const kind of KIND_ORDER) {
      const restored = (snapshot.pending?.[kind] ?? [])
        .filter((json): json is string => typeof json === 'string')
        .map((json) => ({ kind, json, bytes: utf8ByteLength(json) }));
      this.pending[kind] = [...restored, ...this.pending[kind]];
      this.pendingBytes += restored.reduce((n, i) => n + i.bytes, 0);
    }
    const now = this.opts.now();
    for (const c of snapshot.retry ?? []) {
      if (typeof c?.body !== 'string' || typeof c.idempotencyKey !== 'string') continue;
      this.retry.push({ ...c, nextAttemptAt: now });
    }
    this.enforceBound();
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  /** Drop oldest events, then traces, then errors, until within bounds. */
  private enforceBound(): void {
    let excess = this.pendingCount() - this.opts.maxQueueItems;
    if (excess <= 0) return;
    for (const kind of ['events', 'traces', 'errors'] as const) {
      while (excess > 0 && this.pending[kind].length) {
        const dropped = this.pending[kind].shift()!;
        this.pendingBytes -= dropped.bytes;
        this.overflow[kind]++;
        excess--;
      }
    }
  }

  private reportOverflow(): void {
    const { errors, traces, events } = this.overflow;
    if (!errors && !traces && !events) return;
    this.overflow = { errors: 0, traces: 0, events: 0 };
    this.diagnose('queue_overflow', `The queue was full; dropped ${errors + traces + events} oldest item(s).`, {
      errors,
      traces,
      events,
    });
  }

  private diagnose(type: Diagnostic['type'], message: string, details?: Record<string, unknown>): void {
    try {
      this.opts.onDiagnostic?.({ type, message, ...(details && { details }) });
    } catch {
      // A throwing diagnostic handler must never break delivery.
    }
  }
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  const out: Partial<T> = {};
  for (const key of Object.keys(value) as Array<keyof T>) {
    if (value[key] !== undefined) out[key] = value[key];
  }
  return out;
}
