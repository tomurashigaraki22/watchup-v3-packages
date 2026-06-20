// ─────────────────────────────────────────────────────────────────────────────
// @watchupltd/nextjs  ·  Client Provider
//
// Drop-in provider for Next.js App Router.  Uses usePathname() to track
// route changes instead of patching History — this lets @watchupltd/browser's
// own History patching stay disabled (autoCapture.pageViews: false) so we
// never double-count.
// ─────────────────────────────────────────────────────────────────────────────

'use client';

import React, {
  useEffect,
  useRef,
  type ReactNode,
} from 'react';
import { usePathname, useSearchParams } from 'next/navigation.js';
import { Watchup, type WatchupOptions } from '@watchupltd/browser';
import { WatchupContext } from '@watchupltd/react';

export interface WatchupNextProviderProps {
  /** Watchup project API key. */
  apiKey: string;
  /** Full SDK options — pageViews is handled internally, no need to set it. */
  options?: Omit<WatchupOptions, 'apiKey'>;
  children: ReactNode;
}

/**
 * App Router client provider.  Mount it in your root `layout.tsx`.
 *
 * @example
 * // app/layout.tsx
 * import { WatchupProvider } from '@watchupltd/nextjs/client';
 *
 * export default function RootLayout({ children }) {
 *   return (
 *     <html>
 *       <body>
 *         <WatchupProvider apiKey="wup_live_xxx">
 *           {children}
 *         </WatchupProvider>
 *       </body>
 *     </html>
 *   );
 * }
 */
export function WatchupProvider({
  apiKey,
  options,
  children,
}: WatchupNextProviderProps) {
  const instanceRef = useRef<Watchup | null>(null);

  if (!instanceRef.current) {
    instanceRef.current = new Watchup({
      ...options,
      apiKey,
      // Disable browser SDK's own History patching — we handle it below
      autoCapture: {
        errors:      true,
        performance: true,
        pageViews:   false, // Next.js router integration takes over
        ...options?.autoCapture,
      },
    });
  }

  // Track route changes via Next.js router
  const pathname     = usePathname();
  const searchParams = useSearchParams();

  const trackedRef = useRef<string | null>(null);

  useEffect(() => {
    const instance = instanceRef.current;
    if (!instance) return;

    const fullPath = searchParams.size
      ? `${pathname}?${searchParams.toString()}`
      : pathname;

    // Skip duplicate fires (strict-mode double-invoke, etc.)
    if (trackedRef.current === fullPath) return;
    trackedRef.current = fullPath;

    instance.trackWebView();
  }, [pathname, searchParams]);

  useEffect(() => {
    return () => {
      instanceRef.current?.shutdown();
      instanceRef.current = null;
    };
  }, []);

  return (
    <WatchupContext.Provider value={instanceRef.current}>
      {children}
    </WatchupContext.Provider>
  );
}
