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
  errors?: boolean;
}

export interface WatchupReactNativeOptions {
  apiKey: string;
  baseUrl?: string;
  flushInterval?: number;
  maxBatchSize?: number;
  debug?: boolean;
  environment?: string;
  release?: string;
  autoCapture?: AutoCaptureOptions;
  logging?: LoggingOptions;
}

export interface TracePayload {
  span: string;
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
