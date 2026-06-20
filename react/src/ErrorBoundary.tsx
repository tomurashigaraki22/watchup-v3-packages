// ─────────────────────────────────────────────────────────────────────────────
// @watchupltd/react  ·  ErrorBoundary
//
// Class component required — React only supports error boundaries via
// componentDidCatch / getDerivedStateFromError.
// ─────────────────────────────────────────────────────────────────────────────

'use client';

import React, { Component, type ReactNode, type ErrorInfo } from 'react';
import type { Watchup } from '@watchupltd/browser';
import { WatchupContext } from './context.js';

interface Props {
  children:  ReactNode;
  /** Custom fallback UI. Receives the caught error. */
  fallback?: ReactNode | ((error: Error) => ReactNode);
  /** Called after the error is captured, for local handling. */
  onError?:  (error: Error, info: ErrorInfo) => void;
}

interface State {
  caught: Error | null;
}

export class WatchupErrorBoundary extends Component<Props, State> {
  static override contextType = WatchupContext;
  declare context: Watchup | null;

  override state: State = { caught: null };

  static getDerivedStateFromError(error: Error): State {
    return { caught: error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.onError?.(error, info);

    this.context?.captureError(error, {
      level:   'fatal',
      context: { componentStack: info.componentStack ?? undefined },
    });
  }

  override render(): ReactNode {
    const { caught } = this.state;
    if (caught) {
      const { fallback } = this.props;
      if (typeof fallback === 'function') return fallback(caught);
      return fallback ?? (
        <div style={{ padding: '2rem', fontFamily: 'monospace', color: '#c00' }}>
          <strong>Something went wrong.</strong>
          <pre style={{ marginTop: '1rem', whiteSpace: 'pre-wrap', fontSize: '0.85rem' }}>
            {caught.message}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}
