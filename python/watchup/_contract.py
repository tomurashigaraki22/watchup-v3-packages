"""
watchup · transport contract (spec/README.md)

Constants, normalization/redaction, truncation and the byte-aware chunker.
Mirrors @watchupltd/core; ``tests/test_vectors.py`` runs the shared vectors in
``spec/fixtures/vectors.json`` against this module.
"""

from __future__ import annotations

import dataclasses
import datetime as _dt
import decimal
import enum
import inspect
import json
import re
import traceback
import uuid
from typing import Any, Dict, FrozenSet, Iterable, List, Mapping, Optional, Sequence, Tuple

CONTRACT_VERSION = 1

MAX_CHUNK_BYTES = 196_608
MAX_CHUNK_ITEMS = 100
BEACON_MAX_BYTES = 61_440
MAX_QUEUE_ITEMS = 1_000
MAX_ATTEMPTS = 5
BASE_BACKOFF_MS = 1_000
MAX_BACKOFF_MS = 30_000
MAX_RETRY_AFTER_MS = 60_000
MAX_RETRY_CHUNKS = 50

TRUNCATE_MESSAGE_BYTES = 8_192
TRUNCATE_STACK_BYTES = 32_768
TRUNCATE_FIELD_BYTES = 8_192
TRUNCATE_MESSAGE_FINAL_BYTES = 1_024
TRUNCATE_STACK_FINAL_BYTES = 4_096

MAX_DEPTH = 10
MAX_KEYS = 200
MAX_ARRAY = 200

REDACTED = "[REDACTED]"
INGEST_PATH = "/api/v1/ingest/batch"
DEFAULT_BASE_URL = "https://api.watchup.site"

KINDS: Tuple[str, str, str] = ("errors", "traces", "events")

# ── JSON / UTF-8 ──────────────────────────────────────────────────────────────


def dumps(value: Any) -> str:
    """Compact JSON without ASCII escaping, so byte counts match what is sent."""
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def utf8_len(value: str) -> int:
    return len(value.encode("utf-8", "replace"))


def truncate_utf8(value: str, max_bytes: int) -> Tuple[str, int]:
    """Cut to at most ``max_bytes`` without splitting a code point; return (kept, removed_bytes)."""
    raw = value.encode("utf-8", "replace")
    if len(raw) <= max_bytes:
        return value, 0
    kept = raw[:max_bytes].decode("utf-8", "ignore")
    return kept, len(raw) - len(kept.encode("utf-8"))


def truncate_with_marker(value: str, max_bytes: int) -> Tuple[str, bool]:
    kept, removed = truncate_utf8(value, max_bytes)
    if not removed:
        return value, False
    return f"{kept}…[truncated {removed} bytes]", True


# ── Redaction ─────────────────────────────────────────────────────────────────

_SENSITIVE_KEYS: FrozenSet[str] = frozenset(
    {
        "authorization",
        "proxyauthorization",
        "cookie",
        "setcookie",
        "password",
        "passwd",
        "pwd",
        "secret",
        "clientsecret",
        "apikey",
        "xapikey",
        "apisecret",
        "privatekey",
        "creditcard",
        "cardnumber",
        "ccnumber",
        "cvv",
        "cvc",
        "ssn",
        "sessiontoken",
    }
)
_SENSITIVE_SUBSTRINGS = ("password", "secret", "credential")
_KEY_STRIP = re.compile(r"[-_. ]")


def canonical_key(key: str) -> str:
    return _KEY_STRIP.sub("", key.lower())


def is_sensitive_key(key: str, extra: FrozenSet[str] = frozenset()) -> bool:
    k = canonical_key(key)
    if k in _SENSITIVE_KEYS or k in extra or k.endswith("token"):
        return True
    return any(part in k for part in _SENSITIVE_SUBSTRINGS)


_AUTH_SCHEME = re.compile(r"\b(Bearer|Basic)\s+[A-Za-z0-9\-._~+/]+=*", re.IGNORECASE)
_LIVE_KEY = re.compile(r"\bwup_live_[A-Za-z0-9]+")
_SENSITIVE_QUERY = re.compile(r"([?&](?:token|access_token|password|api_key|apikey|secret|key)=)[^&#\s\"']*", re.IGNORECASE)
_CARD_CANDIDATE = re.compile(r"\b(?:\d[ -]?){12,18}\d\b")
_HAS_4_DIGITS = re.compile(r"\d{4}")


def _luhn(digits: str) -> bool:
    total = 0
    for i, ch in enumerate(reversed(digits)):
        d = ord(ch) - 48
        if i % 2 == 1:
            d *= 2
            if d > 9:
                d -= 9
        total += d
    return total % 10 == 0


def _card_sub(match: re.Match[str]) -> str:
    digits = re.sub(r"[ -]", "", match.group(0))
    return REDACTED if 13 <= len(digits) <= 19 and _luhn(digits) else match.group(0)


def scrub_string(value: str) -> str:
    """Remove credentials and card numbers embedded in free text."""
    if len(value) < 8:
        return value
    out = value
    lowered = out.lower()
    if "bearer" in lowered or "basic" in lowered:
        out = _AUTH_SCHEME.sub(lambda m: f"{m.group(1)} {REDACTED}", out)
    if "wup_live_" in out:
        out = _LIVE_KEY.sub(REDACTED, out)
    if "=" in out:
        out = _SENSITIVE_QUERY.sub(lambda m: f"{m.group(1)}{REDACTED}", out)
    if _HAS_4_DIGITS.search(out):
        out = _CARD_CANDIDATE.sub(_card_sub, out)
    return out


def _clean_str(value: str) -> str:
    try:
        value.encode("utf-8")
    except UnicodeEncodeError:
        # Lone surrogates cannot be sent as UTF-8.
        value = value.encode("utf-8", "replace").decode("utf-8")
    return scrub_string(value)


_MISSING = object()


def normalize(value: Any, redact_keys: Iterable[str] = ()) -> Any:
    """Convert ``value`` into JSON-safe, redacted data. Never raises."""
    extra = frozenset(canonical_key(k) for k in redact_keys)
    ancestors: List[int] = []

    def walk(obj: Any, depth: int) -> Any:
        if obj is None or isinstance(obj, bool):
            return obj
        if isinstance(obj, str):
            return _clean_str(obj)
        if isinstance(obj, int):
            return obj
        if isinstance(obj, float):
            return obj if obj == obj and obj not in (float("inf"), float("-inf")) else None
        if isinstance(obj, enum.Enum):
            return walk(obj.value, depth)
        if isinstance(obj, (decimal.Decimal, uuid.UUID)):
            return str(obj)
        if isinstance(obj, (_dt.datetime, _dt.date, _dt.time)):
            return obj.isoformat()
        if isinstance(obj, (bytes, bytearray, memoryview)):
            return f"[Binary {len(obj)} bytes]"
        if inspect.isroutine(obj) or inspect.isclass(obj):
            return _MISSING

        if id(obj) in ancestors:
            return "[Circular]"
        if depth >= MAX_DEPTH:
            return "[MaxDepth]"

        ancestors.append(id(obj))
        try:
            if isinstance(obj, BaseException):
                out: Dict[str, Any] = {"name": type(obj).__name__, "message": _clean_str(str(obj))}
                if obj.__traceback__ is not None:
                    out["stack"] = _clean_str("".join(traceback.format_exception(type(obj), obj, obj.__traceback__)))
                return out
            if isinstance(obj, dict):
                result: Dict[str, Any] = {}
                kept = 0
                items = list(obj.items())
                for key, raw in items:
                    if kept >= MAX_KEYS:
                        result["_watchup_dropped_keys"] = len(items) - kept
                        break
                    name = str(key)
                    if is_sensitive_key(name, extra):
                        result[name] = REDACTED
                        kept += 1
                        continue
                    v = walk(raw, depth + 1)
                    if v is _MISSING:
                        continue
                    result[name] = v
                    kept += 1
                return result
            if isinstance(obj, (list, tuple, set, frozenset)):
                seq = list(obj)
                out_list = []
                for raw in seq[:MAX_ARRAY]:
                    v = walk(raw, depth + 1)
                    out_list.append(None if v is _MISSING else v)
                if len(seq) > MAX_ARRAY:
                    out_list.append(f"[… {len(seq) - MAX_ARRAY} more]")
                return out_list
            if dataclasses.is_dataclass(obj) and not isinstance(obj, type):
                return walk({f.name: getattr(obj, f.name) for f in dataclasses.fields(obj)}, depth)
            to_dict = getattr(obj, "to_dict", None)
            if callable(to_dict):
                try:
                    return walk(to_dict(), depth)
                except Exception:
                    return "[Unserializable]"
            return _clean_str(str(obj))[:1024]
        finally:
            ancestors.pop()

    try:
        result = walk(value, 0)
        return None if result is _MISSING else result
    except Exception:
        return "[Unserializable]"


# ── Truncation (spec §5) ──────────────────────────────────────────────────────

_CONTAINERS = ("context", "meta", "properties")


def _cap_strings(value: Any, max_bytes: int) -> Tuple[Any, bool]:
    if isinstance(value, str):
        return truncate_with_marker(value, max_bytes)
    if isinstance(value, list):
        changed = False
        out = []
        for v in value:
            nv, c = _cap_strings(v, max_bytes)
            changed = changed or c
            out.append(nv)
        return out, changed
    if isinstance(value, dict):
        changed = False
        out_d = {}
        for k, v in value.items():
            nv, c = _cap_strings(v, max_bytes)
            changed = changed or c
            out_d[k] = nv
        return out_d, changed
    return value, False


def _cap_field(item: Dict[str, Any], field: str, max_bytes: int) -> bool:
    value = item.get(field)
    if not isinstance(value, str):
        return False
    new, changed = truncate_with_marker(value, max_bytes)
    if changed:
        item[field] = new
    return changed


@dataclasses.dataclass
class FitResult:
    item: Dict[str, Any]
    json: str
    bytes: int
    truncated: bool
    oversized: bool


def fit_item(item: Dict[str, Any], budget: int) -> FitResult:
    """Apply the three-step truncation policy until ``item`` fits ``budget`` bytes."""
    encoded = dumps(item)
    size = utf8_len(encoded)
    if size <= budget:
        return FitResult(item, encoded, size, False, False)

    out = dict(item)
    truncated = False
    truncated = _cap_field(out, "message", TRUNCATE_MESSAGE_BYTES) or truncated
    truncated = _cap_field(out, "stack", TRUNCATE_STACK_BYTES) or truncated
    for key in _CONTAINERS:
        if key in out:
            new, changed = _cap_strings(out[key], TRUNCATE_FIELD_BYTES)
            if changed:
                out[key] = new
                truncated = True
    out["_watchup_truncated"] = True
    encoded = dumps(out)
    size = utf8_len(encoded)

    if size > budget:
        for key in _CONTAINERS:
            if key in out:
                out[key] = {"_watchup_truncated": True, "original_bytes": utf8_len(dumps(item[key]))}
                truncated = True
        encoded = dumps(out)
        size = utf8_len(encoded)

    if size > budget:
        truncated = _cap_field(out, "message", TRUNCATE_MESSAGE_FINAL_BYTES) or truncated
        truncated = _cap_field(out, "stack", TRUNCATE_STACK_FINAL_BYTES) or truncated
        encoded = dumps(out)
        size = utf8_len(encoded)

    if not truncated:
        out.pop("_watchup_truncated", None)
        encoded = dumps(out)
        size = utf8_len(encoded)
    return FitResult(out, encoded, size, truncated, size > budget)


# ── Chunker (spec §4) ─────────────────────────────────────────────────────────


@dataclasses.dataclass
class PreparedItem:
    kind: str
    json: str
    bytes: int


@dataclasses.dataclass
class Chunk:
    idempotency_key: str
    body: str
    bytes: int
    counts: Dict[str, int]
    attempts: int = 0
    next_attempt_at: float = 0.0

    @property
    def items(self) -> int:
        return sum(self.counts.values())


_PREFIX = ('{"errors":[', '],"traces":[', '],"events":[', "],")
_FIXED_BYTES = len("".join(_PREFIX))


def _tail(base: Dict[str, Any], key: str, sent_at: str) -> str:
    return dumps({**base, "idempotency_key": key, "sent_at": sent_at})[1:]


def envelope_overhead(base: Dict[str, Any], sent_at: str = "2026-01-01T00:00:00.000Z") -> int:
    worst_key = f"wu_{'0' * 36}_999999"
    return _FIXED_BYTES + utf8_len(_tail(base, worst_key, sent_at))


def assemble_body(groups: Dict[str, List[str]], base: Dict[str, Any], key: str, sent_at: str) -> str:
    return (
        _PREFIX[0] + ",".join(groups["errors"])
        + _PREFIX[1] + ",".join(groups["traces"])
        + _PREFIX[2] + ",".join(groups["events"])
        + _PREFIX[3] + _tail(base, key, sent_at)
    )


def build_chunks(
    pending: Mapping[str, Sequence[PreparedItem]],
    base: Dict[str, Any],
    *,
    max_bytes: int,
    max_items: int,
    batch_id: str,
    sent_at: str,
    now: float = 0.0,
) -> List[Chunk]:
    """Split items into chunks: errors, traces, events in order; FIFO per kind."""
    overhead = envelope_overhead(base, sent_at)
    chunks: List[Chunk] = []
    groups: Dict[str, List[str]] = {k: [] for k in KINDS}
    size = overhead
    count = 0

    def close() -> None:
        nonlocal groups, size, count
        if not count:
            return
        key = f"wu_{batch_id}_{len(chunks)}"
        body = assemble_body(groups, base, key, sent_at)
        chunks.append(Chunk(key, body, utf8_len(body), {k: len(groups[k]) for k in KINDS}, 0, now))
        groups = {k: [] for k in KINDS}
        size = overhead
        count = 0

    for kind in KINDS:
        for item in pending.get(kind, ()):
            added = item.bytes + (1 if groups[kind] else 0)
            if count and (size + added > max_bytes or count + 1 > max_items):
                close()
            groups[kind].append(item.json)
            size += item.bytes + (1 if len(groups[kind]) > 1 else 0)
            count += 1
            if size > max_bytes:
                close()
    close()
    return chunks


def is_retryable_status(status: int) -> bool:
    return status in (408, 425, 429) or status >= 500


def parse_retry_after(value: Optional[str]) -> Optional[float]:
    """``Retry-After`` (seconds or HTTP date) → capped milliseconds."""
    if not value:
        return None
    try:
        ms = float(value) * 1000
    except ValueError:
        from email.utils import parsedate_to_datetime

        try:
            at = parsedate_to_datetime(value)
        except (TypeError, ValueError):
            return None
        ms = (at.timestamp() - _dt.datetime.now(_dt.timezone.utc).timestamp()) * 1000
    return max(0.0, min(ms, MAX_RETRY_AFTER_MS))


def new_batch_id() -> str:
    return str(uuid.uuid4())


__all__ = [
    "Chunk",
    "FitResult",
    "PreparedItem",
    "build_chunks",
    "dumps",
    "fit_item",
    "is_retryable_status",
    "is_sensitive_key",
    "normalize",
    "parse_retry_after",
    "scrub_string",
    "truncate_utf8",
    "utf8_len",
]
