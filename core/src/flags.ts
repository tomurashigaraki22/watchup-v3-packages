// ─────────────────────────────────────────────────────────────────────────────
// @watchupltd/core  ·  feature-flag cache and local evaluation
//
// Shared by the Browser, Node and React Native SDKs so every runtime buckets a
// user identically.
// ─────────────────────────────────────────────────────────────────────────────

export interface FlagVariant {
  key: string;
  weight: number;
}

export interface FlagTargetingRule {
  attribute: string;
  operator: 'in' | 'not_in' | 'contains' | 'equals';
  values: string[];
}

export interface FeatureFlag {
  id: string;
  key: string;
  name: string;
  description?: string;
  enabled: boolean;
  rollout_percentage: number;
  variants: FlagVariant[];
  targeting_rules: FlagTargetingRule[];
}

export interface FlagContext {
  userId?: string | number;
  email?: string;
  plan?: string;
  [key: string]: unknown;
}

/** Deterministic 0–99 bucket (djb2-xor over UTF-16 code units). */
export function flagBucket(flagKey: string, userId: string): number {
  const str = `${flagKey}:${userId}`;
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash * 33) ^ str.charCodeAt(i)) | 0;
  }
  return (hash >>> 0) % 100;
}

export function matchesTargeting(flag: FeatureFlag, ctx: FlagContext): boolean {
  if (!flag.targeting_rules?.length) return true;
  return flag.targeting_rules.every((rule) => {
    const val = String(ctx[rule.attribute] ?? '');
    switch (rule.operator) {
      case 'in':
        return rule.values.includes(val);
      case 'not_in':
        return !rule.values.includes(val);
      case 'contains':
        return rule.values.some((v) => val.includes(v));
      case 'equals':
        return rule.values[0] === val;
      default:
        return true;
    }
  });
}

export interface FlagStoreOptions {
  /**
   * Drop cached flags when no refresh has succeeded for this long, so a
   * long-offline client stops serving stale rollouts. Default: 24 h.
   */
  maxAgeMs?: number;
  now?: () => number;
}

/** In-memory flag cache with an expiry for stale data. */
export class FlagStore {
  private flags = new Map<string, FeatureFlag>();
  private fetchedAt = 0;
  private loaded = false;
  private readonly maxAgeMs: number;
  private readonly now: () => number;
  private readonly listeners = new Set<() => void>();

  constructor(options: FlagStoreOptions = {}) {
    this.maxAgeMs = options.maxAgeMs ?? 24 * 60 * 60 * 1000;
    this.now = options.now ?? (() => Date.now());
  }

  /** Replace the cache with a fresh server response. */
  replace(flags: FeatureFlag[]): void {
    this.flags = new Map(flags.map((f) => [f.key, f]));
    this.fetchedAt = this.now();
    this.loaded = true;
    this.listeners.forEach((fn) => {
      try {
        fn();
      } catch {
        // Listener errors must not break the refresh loop.
      }
    });
  }

  /** Subscribe to cache refreshes. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get(key: string): FeatureFlag | undefined {
    if (this.isExpired()) return undefined;
    return this.flags.get(key);
  }

  isExpired(): boolean {
    return !this.loaded || this.now() - this.fetchedAt > this.maxAgeMs;
  }

  /**
   * Evaluate a flag. `fallbackId` is used for bucketing when the context has
   * no user ID or email (the browser passes its visitor ID).
   */
  isEnabled(key: string, ctx: FlagContext, fallbackId = ''): boolean {
    const flag = this.get(key);
    if (!flag?.enabled) return false;
    if (!matchesTargeting(flag, ctx)) return false;
    if (flag.rollout_percentage >= 100) return true;
    if (flag.rollout_percentage <= 0) return false;
    const id = String(ctx.userId ?? ctx.email ?? fallbackId);
    if (!id) return false;
    return flagBucket(key, id) < flag.rollout_percentage;
  }

  getVariant(key: string, ctx: FlagContext, fallbackId = ''): string {
    if (!this.isEnabled(key, ctx, fallbackId)) return 'control';
    const flag = this.get(key)!;
    if (!flag.variants?.length) return 'on';
    const id = String(ctx.userId ?? ctx.email ?? fallbackId);
    const bucket = id ? flagBucket(key, id) : 0;
    let cumulative = 0;
    for (const variant of flag.variants) {
      cumulative += variant.weight;
      if (bucket < cumulative) return variant.key;
    }
    return flag.variants[flag.variants.length - 1]!.key;
  }
}

/** Parse the `/api/v1/flags` response body. Returns null when malformed. */
export function parseFlagsResponse(json: unknown): FeatureFlag[] | null {
  const body = json as { ok?: boolean; data?: { flags?: unknown } } | null;
  if (!body?.ok || !Array.isArray(body.data?.flags)) return null;
  return body.data!.flags as FeatureFlag[];
}
