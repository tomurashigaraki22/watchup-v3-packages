// ─────────────────────────────────────────────────────────────────────────────
// @watchupltd/browser  ·  Web Vitals capture
//
// FCP, LCP, CLS, INP, TTFB and page-load time via PerformanceObserver and
// PerformanceNavigationTiming, forwarded as traces so they appear next to
// request spans. Thresholds follow Google's Core Web Vitals guidance.
// ─────────────────────────────────────────────────────────────────────────────

export interface VitalSample {
  span: string;
  /** Milliseconds, or the unitless CLS score ×1000 for `web-vital cls`. */
  value: number;
  status: 'ok' | 'warn' | 'err';
  meta?: Record<string, unknown>;
}

type VitalCallback = (sample: VitalSample) => void;

function rating(value: number, good: number, poor: number): VitalSample['status'] {
  if (value <= good) return 'ok';
  if (value <= poor) return 'warn';
  return 'err';
}

/** Run `report` once, when the page is first hidden or the user interacts. */
function onFinalize(report: () => void, cleanup: Array<() => void>): void {
  const once = () => report();
  const onHidden = () => {
    if (document.visibilityState === 'hidden') report();
  };
  document.addEventListener('visibilitychange', onHidden);
  window.addEventListener('pagehide', once, { once: true });
  cleanup.push(() => {
    document.removeEventListener('visibilitychange', onHidden);
    window.removeEventListener('pagehide', once);
  });
}

function observe(type: string, cb: (entries: PerformanceEntry[]) => void, cleanup: Array<() => void>, opts: Record<string, unknown> = {}): PerformanceObserver | null {
  if (typeof PerformanceObserver === 'undefined') return null;
  try {
    const po = new PerformanceObserver((list) => cb(list.getEntries()));
    po.observe({ type, buffered: true, ...opts } as PerformanceObserverInit);
    cleanup.push(() => po.disconnect());
    return po;
  } catch {
    return null; // Entry type not supported in this browser.
  }
}

/** Start all Web Vitals observers. Returns a cleanup function. */
export function captureWebVitals(onVital: VitalCallback): () => void {
  const cleanup: Array<() => void> = [];

  // FCP
  const fcp = observe('paint', (entries) => {
    for (const entry of entries) {
      if (entry.name !== 'first-contentful-paint') continue;
      const ms = Math.round(entry.startTime);
      onVital({ span: 'web-vital fcp', value: ms, status: rating(ms, 1800, 3000) });
      fcp?.disconnect();
    }
  }, cleanup);

  // LCP — final value is known when the user interacts or the page hides.
  let lcp: PerformanceEntry | null = null;
  let lcpReported = false;
  const lcpObserver = observe('largest-contentful-paint', (entries) => {
    if (entries.length) lcp = entries[entries.length - 1] ?? null;
  }, cleanup);
  const reportLcp = () => {
    if (lcpReported || !lcp) return;
    lcpReported = true;
    lcpObserver?.disconnect();
    const ms = Math.round(lcp.startTime);
    onVital({ span: 'web-vital lcp', value: ms, status: rating(ms, 2500, 4000) });
  };
  if (lcpObserver) {
    const opts = { once: true, capture: true } as const;
    document.addEventListener('keydown', reportLcp, opts);
    document.addEventListener('pointerdown', reportLcp, opts);
    cleanup.push(() => {
      document.removeEventListener('keydown', reportLcp, opts);
      document.removeEventListener('pointerdown', reportLcp, opts);
    });
    onFinalize(reportLcp, cleanup);
  }

  // CLS — session windows (max 5 s, gaps under 1 s); report the largest.
  let clsMax = 0;
  let clsWindow = 0;
  let windowStart = 0;
  let lastShift = 0;
  let clsReported = false;
  const clsObserver = observe('layout-shift', (entries) => {
    for (const e of entries as Array<PerformanceEntry & { value: number; hadRecentInput: boolean }>) {
      if (e.hadRecentInput) continue;
      if (clsWindow && (e.startTime - lastShift > 1000 || e.startTime - windowStart > 5000)) clsWindow = 0;
      if (!clsWindow) windowStart = e.startTime;
      clsWindow += e.value;
      lastShift = e.startTime;
      clsMax = Math.max(clsMax, clsWindow);
    }
  }, cleanup);
  if (clsObserver) {
    onFinalize(() => {
      if (clsReported) return;
      clsReported = true;
      const score = Math.round(clsMax * 1000) / 1000;
      onVital({ span: 'web-vital cls', value: Math.round(score * 1000), status: rating(score, 0.1, 0.25), meta: { score } });
    }, cleanup);
  }

  // INP — the slowest interaction (approximation: max event duration).
  let inp = 0;
  let inpReported = false;
  const inpObserver = observe('event', (entries) => {
    for (const e of entries as Array<PerformanceEntry & { interactionId?: number }>) {
      if (e.interactionId) inp = Math.max(inp, Math.round(e.duration));
    }
  }, cleanup, { durationThreshold: 40 });
  if (inpObserver) {
    onFinalize(() => {
      if (inpReported || !inp) return;
      inpReported = true;
      onVital({ span: 'web-vital inp', value: inp, status: rating(inp, 200, 500) });
    }, cleanup);
  }

  // TTFB and full page load.
  const reportLoad = () => {
    const nav = performance.getEntriesByType?.('navigation')[0] as PerformanceNavigationTiming | undefined;
    if (!nav || nav.loadEventEnd <= 0) return;
    const ttfb = Math.round(nav.responseStart - nav.startTime);
    const load = Math.round(nav.loadEventEnd - nav.startTime);
    onVital({ span: 'web-vital ttfb', value: ttfb, status: rating(ttfb, 800, 1800) });
    onVital({ span: 'pageload', value: load, status: rating(load, 2000, 4000), meta: { ttfb } });
  };
  if (document.readyState === 'complete') {
    setTimeout(reportLoad, 0);
  } else {
    const onLoad = () => setTimeout(reportLoad, 0);
    window.addEventListener('load', onLoad, { once: true });
    cleanup.push(() => window.removeEventListener('load', onLoad));
  }

  return () => {
    for (const fn of cleanup) fn();
  };
}
