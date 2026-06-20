// ─────────────────────────────────────────────────────────────────────────────
// @watchupltd/browser  ·  Web Vitals capture
//
// Captures FCP, LCP, and overall page-load time via PerformanceObserver and
// PerformanceNavigationTiming.  Forwarded as traces so they appear in the
// Watchup dashboard alongside request spans.
//
// Thresholds come from Google's Core Web Vitals 2024 targets:
//   FCP: good ≤ 1800 ms, needs improvement ≤ 3000 ms, poor > 3000 ms
//   LCP: good ≤ 2500 ms, needs improvement ≤ 4000 ms, poor > 4000 ms
// ─────────────────────────────────────────────────────────────────────────────

import type { TracePayload } from './types.js';

type TraceCallback = (trace: TracePayload) => void;

function rating(
  ms: number,
  good: number,
  needsImprovement: number,
): TracePayload['status'] {
  if (ms <= good)             return 'ok';
  if (ms <= needsImprovement) return 'warn';
  return 'err';
}

function statusCode(status: TracePayload['status']): number {
  return status === 'err' ? 500 : status === 'warn' ? 400 : 200;
}

// ── FCP — First Contentful Paint ─────────────────────────────────────────────

export function captureFCP(onTrace: TraceCallback, env?: string): void {
  if (typeof PerformanceObserver === 'undefined') return;
  try {
    const po = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.name !== 'first-contentful-paint') continue;
        const ms     = Math.round(entry.startTime);
        const status = rating(ms, 1800, 3000);
        onTrace({
          span:        'web-vital fcp',
          ms,
          status_code: statusCode(status),
          status,
          timestamp:   new Date().toISOString(),
          ...(env && { environment: env }),
        });
        po.disconnect();
      }
    });
    po.observe({ type: 'paint', buffered: true });
  } catch { /* PerformanceObserver 'paint' not supported */ }
}

// ── LCP — Largest Contentful Paint ───────────────────────────────────────────

export function captureLCP(onTrace: TraceCallback, env?: string): void {
  if (typeof PerformanceObserver === 'undefined') return;

  let last: PerformanceEntry | null = null;
  let reported = false;

  const report = () => {
    if (reported || !last) return;
    reported = true;
    try { po.disconnect(); } catch {}
    const ms     = Math.round(last.startTime);
    const status = rating(ms, 2500, 4000);
    onTrace({
      span:        'web-vital lcp',
      ms,
      status_code: statusCode(status),
      status,
      timestamp:   new Date().toISOString(),
      ...(env && { environment: env }),
    });
  };

  let po: PerformanceObserver;
  try {
    po = new PerformanceObserver((list) => {
      const entries = list.getEntries();
      if (entries.length) last = entries[entries.length - 1] ?? null;
    });
    po.observe({ type: 'largest-contentful-paint', buffered: true });
  } catch {
    return; // 'largest-contentful-paint' not supported
  }

  // LCP is only finalised once the user interacts or the tab hides.
  document.addEventListener('visibilitychange', report, { once: true });
  document.addEventListener('keydown',          report, { once: true, capture: true });
  document.addEventListener('pointerdown',      report, { once: true, capture: true });
}

// ── Page load (overall) ───────────────────────────────────────────────────────

export function capturePageLoad(onTrace: TraceCallback, env?: string): void {
  const report = () => {
    const nav = performance.getEntriesByType('navigation')[0] as
      PerformanceNavigationTiming | undefined;
    if (!nav || nav.loadEventEnd <= 0) return;

    const ms     = Math.round(nav.loadEventEnd - nav.startTime);
    const ttfb   = Math.round(nav.responseStart - nav.requestStart);
    const status = rating(ms, 2000, 4000);

    onTrace({
      span:        'pageload',
      ms,
      status_code: statusCode(status),
      status,
      timestamp:   new Date().toISOString(),
      meta:        { ttfb },
      ...(env && { environment: env }),
    });
  };

  if (document.readyState === 'complete') {
    // PerformanceNavigationTiming might not be fully populated yet
    setTimeout(report, 0);
  } else {
    window.addEventListener('load', () => setTimeout(report, 100), { once: true });
  }
}
