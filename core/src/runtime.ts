// ─────────────────────────────────────────────────────────────────────────────
// @watchupltd/core  ·  runtime helpers (no DOM or Node types required)
// ─────────────────────────────────────────────────────────────────────────────

interface CryptoLike {
  randomUUID?: () => string;
  getRandomValues?: <T extends ArrayBufferView>(array: T) => T;
}

type TimerHandle = { unref?: () => void } | number;

const g = globalThis as unknown as {
  crypto?: CryptoLike;
  setTimeout: (fn: () => void, ms: number) => TimerHandle;
  clearTimeout: (handle: TimerHandle) => void;
  setInterval: (fn: () => void, ms: number) => TimerHandle;
  clearInterval: (handle: TimerHandle) => void;
};

/** RFC 4122 v4 UUID; uses the platform CSPRNG when available. */
export function uuid(): string {
  const c = g.crypto;
  if (c?.randomUUID) {
    try {
      return c.randomUUID();
    } catch {
      // Non-secure browser context — fall through.
    }
  }
  const bytes = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex: string[] = [];
  for (let i = 0; i < 16; i++) hex.push((bytes[i]! + 0x100).toString(16).slice(1));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`;
}

export type Cancel = () => void;

/** setTimeout that never keeps a Node process alive. */
export function defaultSetTimer(fn: () => void, ms: number): Cancel {
  const handle = g.setTimeout(fn, ms);
  if (typeof handle === 'object' && typeof handle.unref === 'function') handle.unref();
  return () => g.clearTimeout(handle);
}

/** A wait that *does* keep the process alive (used while shutting down). */
export function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    g.setTimeout(resolve, ms);
  });
}

/** setInterval that never keeps a Node process alive. */
export function defaultSetInterval(fn: () => void, ms: number): Cancel {
  const handle = g.setInterval(fn, ms);
  if (typeof handle === 'object' && typeof handle.unref === 'function') handle.unref();
  return () => g.clearInterval(handle);
}

export function nowIso(): string {
  return new Date().toISOString();
}
