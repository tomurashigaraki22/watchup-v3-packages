// ─────────────────────────────────────────────────────────────────────────────
// @watchupltd/core  ·  public surface (internal to the WatchUp JS SDKs)
// ─────────────────────────────────────────────────────────────────────────────

export { CONTRACT_VERSION, LIMITS, REDACTED, INGEST_PATH, DEFAULT_BASE_URL } from './constants';
export { utf8ByteLength, truncateUtf8, truncateWithMarker } from './utf8';
export { normalize, isSensitiveKey, scrubString, type NormalizeOptions } from './normalize';
export { fitItem, type FitResult } from './truncate';
export { buildChunks, envelopeOverhead, idempotencyKey, assembleBody, type ChunkLimits } from './chunker';
export { DeliveryQueue, type DeliveryQueueOptions, type FlushOptions, type ShutdownResult } from './queue';
export {
  isRetryableStatus,
  parseRetryAfter,
  parseErrorCode,
  ingestHeaders,
  toSendResult,
  type HeaderOptions,
} from './http';
export { sanitizeSql, MAX_STATEMENT_BYTES } from './sql';
export { uuid, defaultSetTimer, defaultSetInterval, defaultSleep, nowIso, type Cancel } from './runtime';
export {
  FlagStore,
  flagBucket,
  matchesTargeting,
  parseFlagsResponse,
  type FeatureFlag,
  type FlagContext,
  type FlagVariant,
  type FlagTargetingRule,
  type FlagStoreOptions,
} from './flags';
export {
  KIND_ORDER,
  type Kind,
  type SdkInfo,
  type EnvelopeBase,
  type PreparedItem,
  type Chunk,
  type SendResult,
  type Sender,
  type Diagnostic,
  type DiagnosticType,
  type DiagnosticHandler,
  type FlushResult,
  type QueueSnapshot,
} from './types';
