// ─────────────────────────────────────────────────────────────────────────────
// @watchupltd/browser  ·  types
// ─────────────────────────────────────────────────────────────────────────────

export interface WatchupOptions {
  /**
   * Your project's **public** API key from the Watchup dashboard.
   * Format: `wup_pub_xxxxxxxxxxxx`
   * This key is safe to include in client-side code.
   */
  apiKey: string;

  /** Defaults to `https://api.watchup.site`. Override for self-hosted. */
  baseUrl?: string;

  /** Flush interval in ms. Default: `5000`. */
  flushInterval?: number;

  /** Max items before forcing a flush. Default: `100`. */
  maxBatchSize?: number;

  /** Log SDK warnings to `console.warn`. Default: `false`. */
  debug?: boolean;

  /** Environment label on every payload. Default: `'production'`. */
  environment?: string;

  /** Git SHA / release tag for deploy correlation. */
  release?: string;

  /**
   * Fraction of navigations/fetches captured as traces (0–1).
   * Default: `1` (100 %).
   */
  sampleRate?: number;

  /** Fine-grained control over what gets captured automatically. */
  autoCapture?: {
    /** Capture `window.onerror` and `unhandledrejection`. Default: `true`. */
    errors?: boolean;
    /** Capture FCP, LCP, and page-load timing. Default: `true`. */
    performance?: boolean;
    /**
     * Track the initial page view and SPA navigations (History API).
     * Default: `true`.
     * Set to `false` when a framework SDK (React, Next.js, Svelte) handles
     * page view tracking via the router.
     */
    pageViews?: boolean;
  };
}

// ── Ingest payload shapes ─────────────────────────────────────────────────────

export interface TracePayload {
  span:        string;
  ms:          number;
  status_code: number;
  status:      'ok' | 'warn' | 'err';
  timestamp:   string;
  environment?: string;
  release?:    string;
  meta?:       Record<string, unknown>;
}

export interface ErrorPayload {
  message:     string;
  level:       'debug' | 'info' | 'warning' | 'error' | 'fatal';
  route?:      string;
  stack?:      string;
  context?:    Record<string, unknown>;
  timestamp:   string;
  environment?: string;
  release?:    string;
}

export interface EventPayload {
  name:        string;
  properties?: Record<string, unknown>;
  occurred_at: string;
}

export interface IngestBatch {
  traces?: TracePayload[];
  errors?: ErrorPayload[];
  events?: EventPayload[];
}

// ── Web analytics payload shapes ──────────────────────────────────────────────

export interface WebAnalyticsPayload {
  /** URL path, e.g. "/pricing". */
  path:        string;
  /** Hostname of the tracked site, e.g. "example.com". */
  hostname:    string;
  /** Full referrer URL (document.referrer). */
  referrer?:   string;
  /** document.title at tracking time. */
  title?:      string;
  /** Screen width in CSS pixels. */
  screen_w?:   number;
  /** Screen height in CSS pixels. */
  screen_h?:   number;
  /** navigator.language, e.g. "en-GB". */
  lang?:       string;
  /** Intl.DateTimeFormat().resolvedOptions().timeZone */
  timezone?:   string;
  /** UTM parameters parsed from the current URL's query string. */
  utm_source?:   string;
  utm_medium?:   string;
  utm_campaign?: string;
  utm_term?:     string;
  utm_content?:  string;
  /**
   * Persistent visitor UUID (stored in localStorage).
   * The server hashes this before storing — the raw value is never persisted.
   */
  visitor_id:  string;
  /**
   * Per-session UUID (stored in sessionStorage).
   * The server hashes this before storing — the raw value is never persisted.
   */
  session_id:  string;
  /** Event type — defaults to "pageview". Use for custom web events. */
  event_name?: string;
  /** ISO-8601 timestamp when the event occurred. */
  occurred_at: string;
}

export interface WebAnalyticsBatch {
  web: WebAnalyticsPayload[];
}
