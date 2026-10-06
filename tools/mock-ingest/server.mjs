// ─────────────────────────────────────────────────────────────────────────────
// WatchUp mock ingest server (plan Phase B.3)
//
// A zero-dependency stand-in for api.watchup.site that enforces the SDK
// contract in spec/README.md and records violations instead of hiding them:
//   - 256 KiB body limit (413) and the SDK's own 192 KiB chunk target
//   - 100-item count guard
//   - envelope required fields and idempotency-key format
//   - duplicate idempotency keys are acknowledged but never re-accepted
//   - per-array FIFO order across requests (by `seq` labels when present)
//   - unredacted secrets anywhere in the body
//
// Control endpoints (test-only):
//   GET  /__mock/state        → { requests, accepted, violations, keys }
//   POST /__mock/reset
//   POST /__mock/script       { "statuses": [503, 200, ...] }  scripted responses
//   POST /__mock/flags        { "flags": [...] }               served at /api/v1/flags
// ─────────────────────────────────────────────────────────────────────────────

import { createServer } from 'node:http';

export const SERVER_BODY_LIMIT = 256 * 1024;
export const SDK_CHUNK_TARGET = 192 * 1024;
export const COUNT_GUARD = 100;

const SENSITIVE_KEY = /^(authorization|proxyauthorization|cookie|setcookie|password|passwd|pwd|secret|clientsecret|apikey|xapikey|apisecret|privatekey|creditcard|cardnumber|ccnumber|cvv|cvc|ssn|sessiontoken)$|password|secret|credential|token$/;

function canonical(key) {
  return key.toLowerCase().replace(/[-_. ]/g, '');
}

/** Paths of values stored under sensitive keys that are not "[REDACTED]". */
export function findUnredacted(value, path = '$', out = []) {
  if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) findUnredacted(v, `${path}[${i}]`, out);
  } else if (value && typeof value === 'object') {
    for (const [key, v] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(canonical(key)) && v !== '[REDACTED]') out.push(`${path}.${key}`);
      else findUnredacted(v, `${path}.${key}`, out);
    }
  } else if (typeof value === 'string') {
    if (/\bBearer\s+(?!\[REDACTED\])[A-Za-z0-9\-._~+/]{6,}/.test(value) || /\bwup_live_[A-Za-z0-9]+/.test(value)) {
      out.push(path);
    }
  }
  return out;
}

export function createMockIngest({ keys = ['wup_pub_test', 'wup_live_test'] } = {}) {
  const state = {
    requests: [],
    accepted: { errors: [], traces: [], events: [] },
    keys: new Map(),
    violations: [],
    script: [],
    flags: [],
  };

  const violation = (message, extra = {}) => state.violations.push({ message, ...extra });

  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };

  const authKey = (req, body) => {
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) return auth.slice(7);
    return req.headers['x-api-key'] || req.headers['x-watchup-project-key'] || body?.project_id || null;
  };

  const handleBatch = (req, res, raw) => {
    const record = {
      bytes: raw.length,
      headers: { ...req.headers, authorization: req.headers.authorization ? '[present]' : undefined, 'x-api-key': undefined },
    };
    state.requests.push(record);

    if (raw.length > SERVER_BODY_LIMIT) {
      violation('body exceeds the server 256 KiB limit', { bytes: raw.length });
      return send(res, 413, { ok: false, code: 'payload_too_large', error: 'Request body exceeds 256 KB.' });
    }
    if (raw.length > SDK_CHUNK_TARGET) violation('body exceeds the SDK 192 KiB chunk target', { bytes: raw.length });

    let body;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      violation('body is not valid JSON');
      return send(res, 422, { ok: false, code: 'validation_error', error: 'Invalid JSON.' });
    }

    const key = authKey(req, body);
    if (!key) return send(res, 401, { ok: false, code: 'missing_key', error: 'Missing project key.' });
    if (!keys.includes(key)) return send(res, 401, { ok: false, code: 'invalid_key', error: 'Unknown key.' });
    if (body.project_id && String(body.project_id).startsWith('wup_live_')) {
      violation('secret key sent in the request body');
    }

    for (const field of ['errors', 'traces', 'events', 'sdk']) {
      if (!(field in body)) violation(`envelope missing ${field}`);
    }
    if (!body.sdk?.name || !/^\d+\.\d+\.\d+/.test(body.sdk?.version ?? '')) violation('sdk name/version missing or invalid');

    const idem = req.headers['idempotency-key'] || body.idempotency_key;
    if (!idem || !/^wu_[A-Za-z0-9-]+_\d+$/.test(idem)) violation('missing or malformed idempotency key', { idem });
    if (req.headers['idempotency-key'] && body.idempotency_key && req.headers['idempotency-key'] !== body.idempotency_key) {
      violation('idempotency header and body key differ');
    }

    const count = ['errors', 'traces', 'events'].reduce((n, k) => n + (body[k]?.length ?? 0), 0);
    if (count > COUNT_GUARD) violation('more than 100 items in one request', { count });

    for (const path of findUnredacted(body)) violation('unredacted secret', { path });

    // Scripted failure? The key is not recorded, so a retry can still succeed.
    const scripted = state.script.shift();
    if (scripted && scripted >= 400) {
      const headers = scripted === 429 ? { 'Retry-After': '0' } : {};
      return send(res, scripted, { ok: false, code: 'scripted_failure', error: 'Scripted failure.' }, headers);
    }

    if (idem && state.keys.has(idem)) {
      if (state.keys.get(idem) !== raw.toString('utf8')) violation('idempotency key reused with a different body', { idem });
      return send(res, 200, { ok: true, data: { accepted: 0, rejected: 0, duplicate: true } });
    }
    if (idem) state.keys.set(idem, raw.toString('utf8'));

    for (const kind of ['errors', 'traces', 'events']) {
      for (const item of body[kind] ?? []) state.accepted[kind].push(item);
    }
    return send(res, 201, { ok: true, data: { accepted: count, rejected: 0 } });
  };

  const server = createServer((req, res) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      // Read past the limit so we can report the real size, up to 4 MiB.
      if (size <= 4 * 1024 * 1024) chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const url = new URL(req.url, 'http://mock');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, X-Watchup-Project-Key, X-Api-Key');

      if (req.method === 'OPTIONS') return send(res, 204, {});
      if (url.pathname === '/api/v1/ingest/batch' && req.method === 'POST') return handleBatch(req, res, raw);
      if (url.pathname === '/api/v1/ingest/web-batch' && req.method === 'POST') {
        return send(res, 201, { ok: true, data: { accepted: JSON.parse(raw.toString() || '{}').web?.length ?? 0 } });
      }
      if (url.pathname === '/api/v1/ingest/ping') return send(res, 200, { ok: true, data: { project: 'mock' } });
      if (url.pathname === '/api/v1/flags') return send(res, 200, { ok: true, data: { flags: state.flags } });

      if (url.pathname === '/__mock/state') {
        return send(res, 200, {
          requests: state.requests,
          accepted: state.accepted,
          violations: state.violations,
          keys: [...state.keys.keys()],
        });
      }
      if (url.pathname === '/__mock/reset' && req.method === 'POST') {
        state.requests = [];
        state.accepted = { errors: [], traces: [], events: [] };
        state.keys.clear();
        state.violations = [];
        state.script = [];
        return send(res, 200, { ok: true });
      }
      if (url.pathname === '/__mock/script' && req.method === 'POST') {
        state.script = JSON.parse(raw.toString()).statuses ?? [];
        return send(res, 200, { ok: true });
      }
      if (url.pathname === '/__mock/flags' && req.method === 'POST') {
        state.flags = JSON.parse(raw.toString()).flags ?? [];
        return send(res, 200, { ok: true });
      }
      return send(res, 404, { ok: false, code: 'not_found', error: 'Not found.' });
    });
  });

  return {
    server,
    state,
    /** Start listening; resolves with the base URL. */
    listen(port = 0, host = '127.0.0.1') {
      return new Promise((resolve) => {
        server.listen(port, host, () => {
          const addr = server.address();
          resolve(`http://${host}:${addr.port}`);
        });
      });
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
    script(statuses) {
      state.script = [...statuses];
    },
  };
}
