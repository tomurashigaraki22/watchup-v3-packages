import type { Diagnostic } from '@watchupltd/core';

export type { Diagnostic, DiagnosticType, FlushResult } from '@watchupltd/core';

export interface WatchupUser {
  id: string | number;
  email?: string;
  name?: string;
  [key: string]: unknown;
}

export type LogLevel = 'debug' | 'info' | 'warning' | 'error' | 'critical';

export interface LoggingOptions {
  enabled?: boolean;
  captureConsole?: boolean;
  includeDeviceContext?: boolean;
  minLevel?: LogLevel;
}

export interface AutoCaptureOptions {
  /** Capture uncaught JS exceptions via ErrorUtils. Default: `true`. */
  errors?: boolean;
  /** Capture unhandled promise rejections (Hermes and JSC). Default: `true`. */
  unhandledRejections?: boolean;
}

/** AsyncStorage-compatible key/value storage used for the offline queue. */
export interface QueueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface WatchupReactNativeOptions {
  apiKey: string;
  baseUrl?: string;
  flushInterval?: number;
  /** Max items per request (capped at 100). Default: `100`. */
  maxBatchSize?: number;
  /** Max items held while offline; oldest events are dropped first. Default: `1000`. */
  maxQueueSize?: number;
  debug?: boolean;
  environment?: string;
  release?: string;
  /** Service/app name attached to every item. */
  service?: string;
  autoCapture?: AutoCaptureOptions;
  logging?: LoggingOptions;
  /**
   * Where the offline queue is persisted. Defaults to
   * `@react-native-async-storage/async-storage` when installed; pass `null` to
   * keep the queue in memory only.
   */
  storage?: QueueStorage | null;
  /** Extra keys to redact, on top of the built-in list. */
  redactKeys?: string[];
  /** SDK delivery diagnostics (never contains captured data). */
  onDiagnostic?: (diagnostic: Diagnostic) => void;
}

export interface TracePayload {
  span: string;
  type?: 'http' | 'function' | 'db' | 'custom';
  ms: number;
  status_code: number;
  status: 'ok' | 'warn' | 'err';
  timestamp: string;
  environment?: string;
  release?: string;
  meta?: Record<string, unknown>;
  user?: WatchupUser;
}

export interface ErrorPayload {
  message: string;
  type?: string;
  level: 'debug' | 'info' | 'warning' | 'error' | 'fatal';
  route?: string;
  stack?: string;
  context?: Record<string, unknown>;
  timestamp: string;
  environment?: string;
  release?: string;
  user?: WatchupUser;
}

export interface EventPayload {
  name: string;
  properties?: Record<string, unknown>;
  occurred_at: string;
}

export type LogContext = Record<string, unknown> & {
  level?: LogLevel;
  route?: string;
};

export interface IngestBatch {
  traces?: TracePayload[];
  errors?: ErrorPayload[];
  events?: EventPayload[];
}
