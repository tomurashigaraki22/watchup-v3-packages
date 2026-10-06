import { describe, expect, it, vi } from 'vitest';
import {
  DeliveryQueue,
  FlagStore,
  LIMITS,
  ingestHeaders,
  isSensitiveKey,
  normalize,
  parseRetryAfter,
  toSendResult,
  truncateUtf8,
  utf8ByteLength,
  type Chunk,
  type Diagnostic,
} from '../src/index.js';

const sdk = { name: '@watchupltd/test', version: '1.2.3' };

function queue(overrides: Partial<ConstructorParameters<typeof DeliveryQueue>[0]> = {}) {
  const sent: Chunk[] = [];
  const diagnostics: Diagnostic[] = [];
  const q = new DeliveryQueue({
    base: () => ({ sdk, environment: 'test' }),
    send: async (chunk) => {
      sent.push(chunk);
      return { ok: true, status: 200 };
    },
    onDiagnostic: (d) => diagnostics.push(d),
    setInterval: () => () => {},
    ...overrides,
  });
  return { q, sent, diagnostics };
}

describe('utf8', () => {
  it('counts bytes per code point', () => {
    expect(utf8ByteLength('a')).toBe(1);
    expect(utf8ByteLength('é')).toBe(2);
    expect(utf8ByteLength('€')).toBe(3);
    expect(utf8ByteLength('😀')).toBe(4);
    expect(utf8ByteLength('\uD800')).toBe(3); // lone surrogate → U+FFFD
    expect(utf8ByteLength('a€😀')).toBe(Buffer.byteLength('a€😀'));
  });

  it('never splits a surrogate pair', () => {
    const cut = truncateUtf8('😀😀', 5);
    expect(cut.value).toBe('😀');
    expect(cut.removedBytes).toBe(4);
  });
});

describe('redaction', () => {
  it('matches key variants', () => {
    for (const key of ['Authorization', 'x-api-key', 'X_API_KEY', 'refreshToken', 'db.password', 'aws_secret_access_key']) {
      expect(isSensitiveKey(key), key).toBe(true);
    }
    for (const key of ['tokens_used', 'token_count', 'route', 'email', 'session_id']) {
      expect(isSensitiveKey(key), key).toBe(false);
    }
  });

  it('honours extra keys and bounds structure', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    const out = normalize({ cyclic, tenant_ssn: 'x', big: 10n, fn: () => 1, when: new Date(0) }, { redactKeys: ['tenant_ssn'] });
    expect(out).toEqual({
      cyclic: { a: 1, self: '[Circular]' },
      tenant_ssn: '[REDACTED]',
      big: '10',
      when: '1970-01-01T00:00:00.000Z',
    });
  });

  it('caps arrays and keys', () => {
    const arr = normalize(Array.from({ length: 250 }, (_, i) => i)) as unknown[];
    expect(arr).toHaveLength(LIMITS.MAX_ARRAY + 1);
    const obj = Object.fromEntries(Array.from({ length: 250 }, (_, i) => [`k${i}`, i]));
    const out = normalize(obj) as Record<string, unknown>;
    expect(out._watchup_dropped_keys).toBe(50);
  });
});

describe('http helpers', () => {
  it('parses Retry-After seconds and dates, capped', () => {
    expect(parseRetryAfter('3')).toBe(3000);
    expect(parseRetryAfter('9999')).toBe(LIMITS.MAX_RETRY_AFTER_MS);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 0)).toBe(10_000);
    expect(parseRetryAfter('soon')).toBeUndefined();
  });

  it('maps responses to send results', async () => {
    const res = (status: number, body: string, headers: Record<string, string> = {}) => ({
      ok: status < 300,
      status,
      headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
      text: async () => body,
    });
    expect(await toSendResult(res(201, ''))).toEqual({ ok: true, status: 201 });
    expect(await toSendResult(res(413, ''))).toMatchObject({ ok: false, code: 'payload_too_large' });
    expect(await toSendResult(res(401, '{"code":"invalid_key"}'))).toMatchObject({ code: 'invalid_key' });
    expect(await toSendResult(res(429, '', { 'retry-after': '2' }))).toMatchObject({ retryAfterMs: 2000 });
  });

  it('builds headers without the idempotency header for browsers', () => {
    const browser = ingestHeaders({ apiKey: 'k', sdk, idempotencyKey: 'wu_x_0', includeIdempotencyHeader: false, includeUserAgent: false });
    expect(browser).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer k', 'X-Api-Key': 'k' });
    const server = ingestHeaders({ apiKey: 'k', sdk, idempotencyKey: 'wu_x_0', includeIdempotencyHeader: true, includeUserAgent: true });
    expect(server['Idempotency-Key']).toBe('wu_x_0');
    expect(server['User-Agent']).toBe('@watchupltd/test/1.2.3');
  });
});

describe('DeliveryQueue', () => {
  it('auto-flushes when errors reach half capacity', async () => {
    const { q, sent } = queue({ maxItems: 4 });
    q.enqueue('errors', { message: 'a', level: 'error', timestamp: 't' });
    expect(sent).toHaveLength(0);
    q.enqueue('errors', { message: 'b', level: 'error', timestamp: 't' });
    await q.flush();
    expect(sent).toHaveLength(1);
  });

  it('drops oldest events first on overflow and reports it', async () => {
    const { q, diagnostics, sent } = queue({ maxQueueItems: 3, autoFlush: false });
    q.enqueue('errors', { message: 'keep', level: 'error', timestamp: 't' });
    for (let i = 0; i < 4; i++) q.enqueue('events', { name: `e${i}`, occurred_at: 't' });
    await q.flush();
    const body = JSON.parse(sent[0]!.body);
    expect(body.errors).toHaveLength(1);
    expect(body.events.map((e: { name: string }) => e.name)).toEqual(['e2', 'e3']);
    expect(diagnostics.find((d) => d.type === 'queue_overflow')?.details).toEqual({ errors: 0, traces: 0, events: 2 });
  });

  it('redacts at capture time', async () => {
    const { q, sent } = queue();
    q.enqueue('events', { name: 'login', occurred_at: 't', properties: { password: 'p', headers: { cookie: 'c' } } });
    await q.flush();
    expect(sent[0]!.body).not.toContain('"p"');
    expect(sent[0]!.body).toContain('[REDACTED]');
  });

  it('takeAll re-chunks pending items to the beacon limit', () => {
    const { q } = queue({ autoFlush: false });
    for (let i = 0; i < 10; i++) q.enqueue('events', { name: `e${i}`, occurred_at: 't', properties: { text: 'x'.repeat(20_000) } });
    const chunks = q.takeAll(LIMITS.BEACON_MAX_BYTES);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.bytes).toBeLessThanOrEqual(LIMITS.BEACON_MAX_BYTES);
    expect(q.pendingCount()).toBe(0);
  });

  it('snapshot/restore keeps pending items and retry keys', async () => {
    let fail = true;
    const sent: Chunk[] = [];
    const first = queue({
      autoFlush: false,
      send: async (c) => {
        if (fail) return { ok: false, status: 503 };
        sent.push(c);
        return { ok: true, status: 200 };
      },
    });
    first.q.enqueue('events', { name: 'retry-me', occurred_at: 't' });
    await first.q.flush();
    first.q.enqueue('events', { name: 'pending', occurred_at: 't' });
    const snap = JSON.parse(JSON.stringify(first.q.snapshot()));
    const retryKey = snap.retry[0].idempotencyKey;

    fail = false;
    const second = queue({ autoFlush: false, send: async (c) => { sent.push(c); return { ok: true, status: 200 }; } });
    second.q.restore(snap);
    await second.q.flush();
    expect(sent.map((c) => c.idempotencyKey)).toContain(retryKey);
    expect(sent.map((c) => c.body).join('')).toContain('pending');
  });

  it('a throwing sender is treated as a retryable network error', async () => {
    const { q, diagnostics } = queue({ send: async () => { throw new Error('offline'); } });
    q.enqueue('events', { name: 'x', occurred_at: 't' });
    const result = await q.flush();
    expect(result.retrying).toBe(1);
    expect(diagnostics[0]?.type).toBe('chunk_retry');
    q.stop();
  });

  it('honours Retry-After for the next attempt time', async () => {
    let now = 1000;
    const { q } = queue({ now: () => now, send: async () => ({ ok: false, status: 429, retryAfterMs: 7000 }) });
    q.enqueue('events', { name: 'x', occurred_at: 't' });
    await q.flush();
    const snap = q.snapshot();
    expect(snap.retry).toHaveLength(1);
    // Not due yet: a normal flush does not resend.
    now = 5000;
    const r = await q.flush();
    expect(r.accepted + r.retrying + r.dropped).toBe(0);
    q.stop();
  });

  it('never calls the diagnostics handler with item contents', async () => {
    const { q, diagnostics } = queue({ send: async () => ({ ok: false, status: 400, code: 'validation_error' }) });
    q.enqueue('events', { name: 'secret-name', occurred_at: 't' });
    await q.flush();
    expect(JSON.stringify(diagnostics)).not.toContain('secret-name');
    expect(diagnostics[0]).toMatchObject({ type: 'chunk_rejected', details: { status: 400, code: 'validation_error' } });
  });
});

describe('FlagStore', () => {
  const flag = { id: '1', key: 'f', name: 'F', enabled: true, rollout_percentage: 100, variants: [], targeting_rules: [] };

  it('expires stale caches', () => {
    let now = 0;
    const store = new FlagStore({ maxAgeMs: 1000, now: () => now });
    expect(store.isEnabled('f', {})).toBe(false);
    store.replace([flag]);
    expect(store.isEnabled('f', {})).toBe(true);
    now = 1001;
    expect(store.isEnabled('f', {})).toBe(false);
  });

  it('buckets deterministically and notifies subscribers', () => {
    const store = new FlagStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.replace([{ ...flag, rollout_percentage: 50, variants: [{ key: 'a', weight: 50 }, { key: 'b', weight: 50 }] }]);
    expect(listener).toHaveBeenCalledOnce();
    const a = store.getVariant('f', { userId: 'user-1' });
    expect(store.getVariant('f', { userId: 'user-1' })).toBe(a);
  });
});

describe('sanitizeSql', async () => {
  const { sanitizeSql } = await import('../src/index.js');
  it('replaces literals and keeps placeholders', () => {
    expect(sanitizeSql("SELECT * FROM users WHERE email = 'a@b.c' AND id = 42 -- note\n AND x IN (1, 2, 3)")).toBe(
      'SELECT * FROM users WHERE email = ? AND id = ? AND x IN (?)',
    );
    expect(sanitizeSql('UPDATE t SET a = $1 WHERE b = $2')).toBe('UPDATE t SET a = $1 WHERE b = $2');
    expect(sanitizeSql("INSERT INTO s VALUES ('it''s', 0x1F, 1.5e3)")).toBe('INSERT INTO s VALUES (?)');
  });
  it('caps length', () => {
    expect(new TextEncoder().encode(sanitizeSql(`SELECT ${'a,'.repeat(2000)}b`)).length).toBeLessThanOrEqual(1024);
  });
});

describe('pause/resume', () => {
  it('makes no attempts while paused and sends on resume', async () => {
    let attempts = 0;
    const q = new DeliveryQueue({
      base: () => ({ sdk }),
      setInterval: () => () => {},
      send: async () => {
        attempts++;
        return { ok: true, status: 200 };
      },
    });
    q.pause();
    for (let i = 0; i < 3; i++) q.enqueue('errors', { message: `e${i}`, level: 'error', timestamp: 't' });
    await q.flush();
    expect(attempts).toBe(0);
    expect(q.pendingCount()).toBe(3);
    const result = await q.resume();
    expect(result.deliveredItems).toBe(3);
  });
});

describe('flush after a finished drain', () => {
  it('does not hand back a stale promise to a caller with new items', async () => {
    const sent: Chunk[] = [];
    const q = new DeliveryQueue({
      base: () => ({ sdk }),
      autoFlush: false,
      setInterval: () => () => {},
      send: async (c) => {
        sent.push(c);
        return { ok: true, status: 200 };
      },
    });
    const first = q.flush(); // empty: the loop finishes synchronously
    q.enqueue('events', { name: 'late', occurred_at: 't' });
    const second = q.flush();
    await Promise.all([first, second]);
    expect(sent).toHaveLength(1);
  });
});

describe('shutdown retries', () => {
  it('waits for a failed chunk with a process-keeping sleep and delivers it', async () => {
    let calls = 0;
    let clock = 0;
    const sleeps: number[] = [];
    const q = new DeliveryQueue({
      base: () => ({ sdk }),
      autoFlush: false,
      random: () => 0,
      setInterval: () => () => {},
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
      now: () => clock,
      send: async () => (++calls === 1 ? { ok: false, status: 503 } : { ok: true, status: 200 }),
    });
    q.enqueue('errors', { message: 'retry-on-shutdown', level: 'error', timestamp: 't' });
    const result = await q.shutdown(5_000);
    expect(result).toEqual({ deliveredItems: 1, undeliveredItems: 0 });
    expect(sleeps).toEqual([500]);
  });
});
