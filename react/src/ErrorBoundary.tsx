// ─────────────────────────────────────────────────────────────────────────────
// @watchupltd/react  ·  ErrorBoundary
//
// Captures render errors with their component stack. Without a `fallback`
// the error is re-thrown from componentDidCatch after capture, which React
// forwards to the next boundary up — so the original React error flow (your
// own boundaries, or the root error) is unchanged.
// ─────────────────────────────────────────────────────────────────────────────

'use client';

import { Component, type ErrorInfo, type ReactNode } from 'react';
import type { Watchup } from '@watchupltd/browser';
import { WatchupContext } from './context.js';

export interface WatchupErrorBoundaryProps {
  children: ReactNode;
  /**
   * UI to render instead of the failed tree. A function receives the error and
   * a `reset` callback. Omit it to re-throw to the next boundary.
   */
  fallback?: ReactNode | ((error: Error, reset: () => void) => ReactNode);
  /** Called after the error is captured, for local handling. */
  onError?: (error: Error, info: ErrorInfo) => void;
  /** Extra context attached to the captured error. */
  context?: Record<string, unknown>;
}

interface State {
  caught: Error | null;
}

export class WatchupErrorBoundary extends Component<WatchupErrorBoundaryProps, State> {
  static override contextType = WatchupContext;
  declare context: Watchup | null;

  override state: State = { caught: null };

  static getDerivedStateFromError(error: Error): State {
    return { caught: error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    this.context?.captureError(error, {
      level: 'fatal',
      ...this.props.context,
      mechanism: 'react.error_boundary',
      componentStack: info.componentStack ?? undefined,
    });
    this.props.onError?.(error, info);
    if (this.props.fallback === undefined) throw error;
  }

  reset = (): void => {
    this.setState({ caught: null });
  };

  override render(): ReactNode {
    const { caught } = this.state;
    if (!caught) return this.props.children;
    const { fallback } = this.props;
    // Re-thrown from componentDidCatch; render nothing in between.
    if (fallback === undefined) return null;
    return typeof fallback === 'function' ? fallback(caught, this.reset) : fallback;
  }
}
