// ─────────────────────────────────────────────────────────────────────────────
// @watchupltd/core  ·  UTF-8 helpers
//
// Pure functions so they work on Hermes, old WebViews and Node alike, without
// relying on TextEncoder.
// ─────────────────────────────────────────────────────────────────────────────

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** Number of bytes `value` occupies when encoded as UTF-8. */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (isHighSurrogate(code) && i + 1 < value.length && isLowSurrogate(value.charCodeAt(i + 1))) {
      bytes += 4;
      i++;
    } else {
      // BMP character, or a lone surrogate (encoded as U+FFFD, also 3 bytes).
      bytes += 3;
    }
  }
  return bytes;
}

/**
 * Cut `value` to at most `maxBytes` UTF-8 bytes without splitting a code point.
 * Returns the kept prefix and how many bytes were removed.
 */
export function truncateUtf8(value: string, maxBytes: number): { value: string; removedBytes: number } {
  const total = utf8ByteLength(value);
  if (total <= maxBytes) return { value, removedBytes: 0 };

  let bytes = 0;
  let end = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    let width: number;
    let units = 1;
    if (code < 0x80) width = 1;
    else if (code < 0x800) width = 2;
    else if (isHighSurrogate(code) && i + 1 < value.length && isLowSurrogate(value.charCodeAt(i + 1))) {
      width = 4;
      units = 2;
    } else width = 3;

    if (bytes + width > maxBytes) break;
    bytes += width;
    i += units - 1;
    end = i + 1;
  }
  return { value: value.slice(0, end), removedBytes: total - bytes };
}

/** Truncate and append the contract's `…[truncated <n> bytes]` marker. */
export function truncateWithMarker(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const cut = truncateUtf8(value, maxBytes);
  if (!cut.removedBytes) return { value, truncated: false };
  return { value: `${cut.value}…[truncated ${cut.removedBytes} bytes]`, truncated: true };
}
