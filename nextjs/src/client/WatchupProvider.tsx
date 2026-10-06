// ─────────────────────────────────────────────────────────────────────────────
// @watchupltd/nextjs  ·  Client Provider
//
// Wraps @watchupltd/react's provider (one shared, StrictMode-safe client) and
// tracks App Router navigations with usePathname() instead of patching
// History, so page views are never double-counted.
// ─────────────────────────────────────────────────────────────────────────────

'use client';

import { Suspense, type ReactNode } from 'react';
import { usePathname, useSearchParams } from 'next/navigation.js';
import type { WatchupOptions } from '@watchupltd/browser';
import { WatchupProvider as ReactProvider, usePageView } from '@watchupltd/react';

export interface WatchupNextProviderProps {
  /**
   * Your **public** project key, usually `process.env.NEXT_PUBLIC_WATCHUP_API_KEY`.
   * Never pass the server key (`wup_live_…`) — it would ship in the client bundle.
   */
  apiKey: string | undefined;
  /** SDK options. Page views are handled by the Next.js router integration. */
  options?: Omit<WatchupOptions, 'apiKey'>;
  children: ReactNode;
}

function RouteTracker() {
  const pathname = usePathname();
  const search = useSearchParams()?.toString();
  usePageView(search ? `${pathname}?${search}` : (pathname ?? '/'));
  return null;
}

/**
 * App Router client provider. Mount it in your root `layout.tsx`.
 *
 * @example
 * // app/layout.tsx
 * import { WatchupProvider } from '@watchupltd/nextjs/client';
 *
 * export default function RootLayout({ children }) {
 *   return (
 *     <html><body>
 *       <WatchupProvider apiKey={process.env.NEXT_PUBLIC_WATCHUP_API_KEY}>{children}</WatchupProvider>
 *     </body></html>
 *   );
 * }
 */
export function WatchupProvider({ apiKey, options, children }: WatchupNextProviderProps) {
  const trackPages = options?.autoCapture?.pageViews !== false;
  return (
    <ReactProvider
      apiKey={apiKey}
      options={{
        ...options,
        autoCapture: {
          errors: true,
          performance: true,
          ...options?.autoCapture,
          // The router integration below replaces History patching.
          pageViews: false,
        },
      }}
    >
      {trackPages && (
        // useSearchParams needs a Suspense boundary for static rendering.
        <Suspense fallback={null}>
          <RouteTracker />
        </Suspense>
      )}
      {children}
    </ReactProvider>
  );
}
