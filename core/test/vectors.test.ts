import { describe, expect, it } from 'vitest';
import {
  DeliveryQueue,
  LIMITS,
  REDACTED,
  normalize,
  utf8ByteLength,
  type Chunk,
  type Diagnostic,
  type SendResult,
} from '../src/index.js';
import { label, validateEnvelope, vectorInput, vectors, type Kind } from './fixtures.js';

const KINDS: Kind[] = ['errors', 'traces', 'events'];

interface Harness {
  queue: DeliveryQueue;
  sent: Chunk[];
  attempts: Array<{ key: string; body: string }>;
  diagnostics: Diagnostic[];
  clock: { now: number };
}

function harness(responses: number[] | 'always_200' | 'always_503', maxItems?: number): Harness {
  const clock = { now: 1_700_000_000_000 };
  const sent: Chunk[] = [];
  const attempts: Array<{ key: string; body: string }> = [];
  const diagnostics: Diagnostic[] = [];
  const script = Array.isArray(responses) ? [...responses] : null;

  const queue = new DeliveryQueue({
    base: () => ({ sdk: vectors.sdk, environment: 'test' }),
    ...(maxItems !== undefined && { maxItems }),
    maxQueueItems: 10_000,
    autoFlush: false,
    now: () => clock.now,
    random: () => 0,
    setTimer: (fn, ms) => {
      // Simulated time: jump the clock and run immediately on the next tick.
      const handle = setTimeout(() => {
        clock.now += ms;
        fn();
      }, 0);
      return () => clearTimeout(handle);
    },
    setInterval: () => () => {},
    onDiagnostic: (d) => diagnostics.push(d),
    send: async (chunk): Promise<SendResult> => {
      attempts.push({ key: chunk.idempotencyKey, body: chunk.body });
      const status = script ? (script.shift() ?? 200) : responses === 'always_200' ? 200 : 503;
      if (status >= 200 && status < 300) {
        sent.push(chunk);
        return { ok: true, status };
      }
      return { ok: false, status };
    },
  });
  return { queue, sent, attempts, diagnostics, clock };
}

function parse(chunk: Chunk) {
  return JSON.parse(chunk.body);
}

describe('contract constants', () => {
  it('match spec/fixtures/vectors.json', () => {
    for (const [key, value] of Object.entries(vectors.constants)) {
      if (key === 'REDACTED') expect(REDACTED).toBe(value);
      else expect((LIMITS as Record<string, unknown>)[key], key).toBe(value);
    }
  });
});

describe('chunking vectors', () => {
  for (const vector of vectors.chunking) {
    it(vector.name, async () => {
      const h = harness('always_200', vector.options?.max_items);
      const input = vectorInput(vector);
      for (const kind of KINDS) for (const item of input[kind]) h.queue.enqueue(kind, item);
      // Disable auto-flush races: everything above was enqueued synchronously.
      await h.queue.flush();

      const chunks = h.sent;
      expect(chunks).toHaveLength(vector.expect.chunks);

      const sendOrder: Array<{ kind: Kind; item: Record<string, unknown> }> = [];
      for (const chunk of chunks) {
        expect(chunk.bytes).toBe(utf8ByteLength(chunk.body));
        const body = parse(chunk);
        expect(validateEnvelope(body)).toEqual([]);
        const items = KINDS.reduce((n, k) => n + body[k].length, 0);
        expect(items).toBeLessThanOrEqual(LIMITS.MAX_CHUNK_ITEMS);
        expect(chunk.bytes).toBeLessThanOrEqual(LIMITS.MAX_CHUNK_BYTES);
        for (const kind of KINDS) for (const item of body[kind]) sendOrder.push({ kind, item });
      }

      if (vector.expect.items_per_chunk) {
        expect(chunks.map((c) => c.counts.errors + c.counts.traces + c.counts.events)).toEqual(
          vector.expect.items_per_chunk,
        );
      }
      if (vector.expect.sequence) {
        expect(
          chunks.map((c) => {
            const body = parse(c);
            return KINDS.flatMap((k) => body[k].map((item: Record<string, unknown>) => label(k, item)));
          }),
        ).toEqual(vector.expect.sequence);
      }
      if (vector.expect.truncated) {
        expect(sendOrder.map((s) => s.item._watchup_truncated === true)).toEqual(vector.expect.truncated);
      }
      if (vector.expect.max_message_bytes) {
        for (const { item } of sendOrder) {
          const message = String(item.message);
          const kept = message.replace(/…\[truncated \d+ bytes\]$/, '');
          expect(utf8ByteLength(kept)).toBeLessThanOrEqual(vector.expect.max_message_bytes);
          expect(message).toMatch(/…\[truncated \d+ bytes\]$/);
        }
      }
      if (vector.expect.valid_utf8) {
        for (const { item } of sendOrder) expect(String(item.message)).not.toContain('�');
      }
      if (vector.expect.context_marker) {
        const ctx = sendOrder[0]!.item.context as Record<string, unknown>;
        expect(ctx._watchup_truncated).toBe(true);
        expect(ctx.original_bytes).toBeGreaterThan(LIMITS.MAX_CHUNK_BYTES);
      }
      for (const type of vector.expect.diagnostics ?? []) {
        expect(h.diagnostics.map((d) => d.type)).toContain(type);
      }
    });
  }
});

describe('redaction vectors', () => {
  for (const vector of vectors.redaction) {
    it(vector.name, () => {
      expect(normalize(vector.input)).toEqual(vector.expected);
    });
  }
});

describe('delivery vectors', () => {
  for (const vector of vectors.delivery) {
    it(vector.name, async () => {
      const h = harness(vector.responses);
      let n = 0;
      for (const kind of KINDS) {
        for (let i = 0; i < (vector.items[kind] ?? 0); i++) {
          const id = `${kind}-${n++}`;
          if (kind === 'errors') h.queue.enqueue(kind, { message: id, level: 'error', timestamp: 't' });
          else if (kind === 'traces') h.queue.enqueue(kind, { span: id, ms: 1, status_code: 200, status: 'ok', timestamp: 't' });
          else h.queue.enqueue(kind, { name: id, occurred_at: 't' });
        }
      }

      if (vector.name.startsWith('shutdown')) {
        await h.queue.shutdown(vector.name === 'shutdown_reports_undelivered' ? 0 : 5_000);
      } else if (vector.concurrent_flushes) {
        await Promise.all(Array.from({ length: vector.concurrent_flushes }, () => h.queue.flush()));
      } else {
        // Keep forcing retries until nothing is left (simulated time).
        await h.queue.flush();
        for (let i = 0; i < 10 && h.queue.retryingCount(); i++) await h.queue.flush({ force: true });
      }

      const e = vector.expect;
      const delivered = h.sent.flatMap((c) => {
        const body = parse(c);
        return KINDS.flatMap((k) => body[k].map((item: Record<string, unknown>) => label(k, item)));
      });
      expect(delivered).toHaveLength(e.delivered_items);
      if (e.unique_items) expect(new Set(delivered).size).toBe(e.unique_items);
      if (e.attempts) expect(h.attempts).toHaveLength(e.attempts);
      if (e.same_idempotency_key) expect(new Set(h.attempts.map((a) => a.key)).size).toBe(1);
      if (e.retried_key_equals_first_key) expect(h.attempts[2]!.key).toBe(h.attempts[0]!.key);
      if (e.first_pass_keys_distinct) expect(h.attempts[0]!.key).not.toBe(h.attempts[1]!.key);
      if (e.pending_after_shutdown !== undefined) {
        expect(h.queue.pendingCount() + h.queue.retryingCount()).toBe(e.pending_after_shutdown);
      }
      for (const type of e.diagnostics ?? []) expect(h.diagnostics.map((d) => d.type)).toContain(type);
      // Retries resend byte-identical bodies.
      const byKey = new Map<string, string>();
      for (const a of h.attempts) {
        if (byKey.has(a.key)) expect(a.body).toBe(byKey.get(a.key));
        byKey.set(a.key, a.body);
      }
    });
  }
});

describe('flag bucket vectors', async () => {
  const { flagBucket } = await import('../src/index.js');
  for (const v of vectors.flag_buckets) {
    it(`${v.flag}:${v.id}`, () => expect(flagBucket(v.flag, v.id)).toBe(v.bucket));
  }
});
