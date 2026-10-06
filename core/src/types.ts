// ─────────────────────────────────────────────────────────────────────────────
// @watchupltd/core  ·  shared types
// ─────────────────────────────────────────────────────────────────────────────

export type Kind = 'errors' | 'traces' | 'events';

/** Send priority: all errors, then traces, then events (FIFO within each). */
export const KIND_ORDER: readonly Kind[] = ['errors', 'traces', 'events'];

export interface SdkInfo {
  name: string;
  version: string;
}

/** Envelope fields other than the three item arrays. */
export interface EnvelopeBase {
  sdk: SdkInfo;
  environment?: string;
  release?: string;
  /** Browser only: public key so sendBeacon requests authenticate. */
  project_id?: string;
}

/** An item that has been normalized, redacted, fitted and serialized once. */
export interface PreparedItem {
  kind: Kind;
  json: string;
  bytes: number;
}

export interface Chunk {
  idempotencyKey: string;
  body: string;
  bytes: number;
  counts: Record<Kind, number>;
  /** Number of send attempts made so far. */
  attempts: number;
  /** Epoch ms before which the chunk must not be retried. */
  nextAttemptAt: number;
}

export interface SendResult {
  ok: boolean;
  /** HTTP status; absent for network errors and timeouts. */
  status?: number;
  /** Server `code` from the JSON error body, when present. */
  code?: string;
  /** Parsed `Retry-After` in ms. */
  retryAfterMs?: number;
  error?: string;
}

export type Sender = (chunk: Chunk) => Promise<SendResult>;

export type DiagnosticType =
  | 'item_truncated'
  | 'item_oversized'
  | 'chunk_retry'
  | 'chunk_rejected'
  | 'chunk_dropped'
  | 'queue_overflow'
  | 'undelivered_on_shutdown';

export interface Diagnostic {
  type: DiagnosticType;
  message: string;
  details?: Record<string, unknown>;
}

export type DiagnosticHandler = (diagnostic: Diagnostic) => void;

export interface FlushResult {
  /** Chunks accepted by the server during this flush. */
  accepted: number;
  /** Items in accepted chunks. */
  deliveredItems: number;
  /** Chunks scheduled for a later retry. */
  retrying: number;
  /** Chunks permanently dropped (rejected or out of attempts). */
  dropped: number;
}

export interface QueueSnapshot {
  version: 1;
  pending: Record<Kind, string[]>;
  retry: Array<Pick<Chunk, 'idempotencyKey' | 'body' | 'bytes' | 'counts' | 'attempts'>>;
}
