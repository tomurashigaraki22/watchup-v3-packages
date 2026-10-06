// ─────────────────────────────────────────────────────────────────────────────
// @watchupltd/browser  ·  SPA navigation detection
//
// History is patched once per page no matter how many clients subscribe, and
// restored when the last one unsubscribes — so two instances (or a React
// StrictMode remount) never double-count or clobber each other's patches.
// replaceState is not tracked: it is mostly URL canonicalisation.
// ─────────────────────────────────────────────────────────────────────────────

type Listener = () => void;

const listeners = new Set<Listener>();
let restore: (() => void) | null = null;

function emit(): void {
  listeners.forEach((fn) => {
    try {
      fn();
    } catch {
      // A failing listener must not break navigation.
    }
  });
}

function install(): void {
  const original = history.pushState;
  const patched: typeof history.pushState = function (this: History, ...args) {
    original.apply(this, args);
    emit();
  };
  history.pushState = patched;
  window.addEventListener('popstate', emit);
  restore = () => {
    if (history.pushState === patched) history.pushState = original;
    window.removeEventListener('popstate', emit);
  };
}

/** Call `listener` after every pushState and popstate. Returns unsubscribe. */
export function onLocationChange(listener: Listener): () => void {
  if (!listeners.size) install();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size && restore) {
      restore();
      restore = null;
    }
  };
}
