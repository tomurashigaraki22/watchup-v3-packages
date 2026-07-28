import type { ErrorPayload } from './types.js';

type ErrorHandler = (error: Error, isFatal?: boolean) => void;
type ErrorUtilsLike = {
  getGlobalHandler?: () => ErrorHandler;
  setGlobalHandler?: (handler: ErrorHandler) => void;
};

declare const global: typeof globalThis & {
  ErrorUtils?: ErrorUtilsLike;
};

export function captureGlobalErrors(
  capture: (error: ErrorPayload) => void,
  environment: string,
  release?: string,
): () => void {
  const errorUtils = global.ErrorUtils;
  if (!errorUtils?.getGlobalHandler || !errorUtils?.setGlobalHandler) return () => {};

  const previous = errorUtils.getGlobalHandler();

  errorUtils.setGlobalHandler((error, isFatal) => {
    capture({
      message: error?.message || String(error),
      level: isFatal ? 'fatal' : 'error',
      stack: error?.stack,
      route: 'react-native',
      timestamp: new Date().toISOString(),
      environment,
      ...(release && { release }),
      context: { isFatal: Boolean(isFatal), source: 'global-handler' },
    });

    previous?.(error, isFatal);
  });

  return () => {
    errorUtils.setGlobalHandler?.(previous);
  };
}
