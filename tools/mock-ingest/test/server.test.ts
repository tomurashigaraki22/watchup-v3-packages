import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error — plain ESM module without types
import { createMockIngest, findUnredacted } from '../server.mjs';
import { DeliveryQueue, ingestHeaders, toSendResult } from '../../../core/src/index.js';

const sdk = { name: '@watchupltd/contract', version: '0.0.1' };
let mock: ReturnType<typeof createMockIngest>;
let url: string;

beforeAll(async () => {
  mock = createMockIngest();
  url = await mock.listen();
});
afterAll(() => mock.close());
beforeEach(() => fetch(`${url}/__mock/reset`, { method: 'POST' }));

const state = () => fetch(`${url}/__mock/state`).then((r) => r.json());

function realQueue() {
  return new DeliveryQueue({
    base: () => ({ sdk, environment: 'test' }),
    autoFlush: false,
    random: () => 0,
    setInterval: () => () => {},
    send: async (chunk) => {
      const res = await fetch(`${url}/api/v1/ingest/batch`, {
        method: 'POST',
        headers: ingestHeaders({ apiKey: 'wup_live_test', sdk, idempotencyKey: chunk.idempotencyKey, includeIdempotencyHeader: true, includeUserAgent: true }),
        body: chunk.body,
      });
      return toSendResult(res);
    },
  });
}

describe('mock ingest server', () => {
  it('rejects bodies over 256 KiB with payload_too_large', async () => {
    const res = await fetch(`${url}/api/v1/ingest/batch`, {
      method: 'POST',
      headers: { Authorization: 'Bearer wup_live_test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: [{ name: 'x'.repeat(300_000) }] }),
    });
    expect(res.status).toBe(413);
    expect((await res.json()).code).toBe('payload_too_large');
  });

  it('authenticates via body project_id (sendBeacon path)', async () => {
    const res = await fetch(`${url}/api/v1/ingest/batch`, {
      method: 'POST',
      body: JSON.stringify({ errors: [], traces: [], events: [], sdk, project_id: 'wup_pub_test', idempotency_key: 'wu_a_0' }),
    });
    expect(res.status).toBe(201);
  });

  it('detects unredacted secrets', () => {
    expect(findUnredacted({ ctx: { headers: { Authorization: 'Bearer abcdefgh' } } })).toEqual(['$.ctx.headers.Authorization']);
    expect(findUnredacted({ note: 'Bearer [REDACTED]', password: '[REDACTED]' })).toEqual([]);
  });

  it('end to end: oversized, unicode and secret items arrive within limits with no violations', async () => {
    const q = realQueue();
    q.enqueue('errors', { message: 'x'.repeat(256_000), level: 'error', timestamp: 't', context: { headers: { authorization: 'Bearer secret-token' } } });
    for (let i = 0; i < 3; i++) q.enqueue('events', { name: `u${i}`, occurred_at: 't', properties: { text: 'é'.repeat(60_000) } });
    for (let i = 0; i < 150; i++) q.enqueue('traces', { span: `t${i}`, ms: 1, status_code: 200, status: 'ok', timestamp: 't' });
    const result = await q.flush();
    expect(result.dropped).toBe(0);

    const s = await state();
    expect(s.violations).toEqual([]);
    expect(s.accepted.errors).toHaveLength(1);
    expect(s.accepted.traces.map((t: { span: string }) => t.span)).toEqual(Array.from({ length: 150 }, (_, i) => `t${i}`));
    expect(s.accepted.events).toHaveLength(3);
    for (const r of s.requests) expect(r.bytes).toBeLessThanOrEqual(192 * 1024);
  });

  it('end to end: a 503 is retried with the same key and accepted once', async () => {
    await fetch(`${url}/__mock/script`, { method: 'POST', body: JSON.stringify({ statuses: [503] }) });
    const q = realQueue();
    q.enqueue('events', { name: 'once', occurred_at: 't' });
    expect((await q.flush()).retrying).toBe(1);
    expect((await q.flush({ force: true })).accepted).toBe(1);

    const s = await state();
    expect(s.requests).toHaveLength(2);
    expect(s.requests[0].headers['idempotency-key']).toBe(s.requests[1].headers['idempotency-key']);
    expect(s.accepted.events).toHaveLength(1);
    expect(s.violations).toEqual([]);
  });

  it('acknowledges a duplicate key without accepting it twice', async () => {
    const body = JSON.stringify({ errors: [], traces: [], events: [{ name: 'dup', occurred_at: 't' }], sdk, idempotency_key: 'wu_dup_0' });
    const headers = { Authorization: 'Bearer wup_live_test', 'Idempotency-Key': 'wu_dup_0' };
    await fetch(`${url}/api/v1/ingest/batch`, { method: 'POST', headers, body });
    const second = await fetch(`${url}/api/v1/ingest/batch`, { method: 'POST', headers, body });
    expect((await second.json()).data.duplicate).toBe(true);
    expect((await state()).accepted.events).toHaveLength(1);
  });
});
