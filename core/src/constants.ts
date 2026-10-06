// ─────────────────────────────────────────────────────────────────────────────
// @watchupltd/core  ·  contract constants
//
// Mirrors spec/fixtures/vectors.json → constants. The vectors test fails if the
// two drift apart.
// ─────────────────────────────────────────────────────────────────────────────

export const CONTRACT_VERSION = 1;

export const LIMITS = {
  /** Target size of one request body (192 KiB, below the server's 256 KiB). */
  MAX_CHUNK_BYTES: 196_608,
  /** Server count guard: items past 100 in one request are dropped. */
  MAX_CHUNK_ITEMS: 100,
  /** sendBeacon / fetch keepalive budget (browsers allow 64 KiB in flight). */
  BEACON_MAX_BYTES: 61_440,
  /** Default bound on queued items before the oldest are dropped. */
  MAX_QUEUE_ITEMS: 1_000,
  /** Attempts per chunk, including the first send. */
  MAX_ATTEMPTS: 5,
  BASE_BACKOFF_MS: 1_000,
  MAX_BACKOFF_MS: 30_000,
  MAX_RETRY_AFTER_MS: 60_000,
  /** Bound on chunks waiting for a retry. */
  MAX_RETRY_CHUNKS: 50,

  TRUNCATE_MESSAGE_BYTES: 8_192,
  TRUNCATE_STACK_BYTES: 32_768,
  TRUNCATE_FIELD_BYTES: 8_192,
  TRUNCATE_MESSAGE_FINAL_BYTES: 1_024,
  TRUNCATE_STACK_FINAL_BYTES: 4_096,

  MAX_DEPTH: 10,
  MAX_KEYS: 200,
  MAX_ARRAY: 200,
} as const;

export const REDACTED = '[REDACTED]';

export const INGEST_PATH = '/api/v1/ingest/batch';
export const DEFAULT_BASE_URL = 'https://api.watchup.site';
