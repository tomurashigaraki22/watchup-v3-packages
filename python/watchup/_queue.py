"""
watchup · delivery queue (spec §4, §7, §8)

Thread-safe. Items are normalized, redacted and serialized when they are
captured; a daemon worker sends them in byte-aware chunks. ``flush()`` is
synchronous and deterministic: when it returns, every item queued before the
call has been attempted. One chunk is in flight at a time; failed chunks wait
for their backoff without blocking newer ones and are retried with the same
idempotency key.
"""

from __future__ import annotations

import dataclasses
import logging
import os
import random
import threading
import time
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional

from . import _contract as c

log = logging.getLogger("watchup")


@dataclasses.dataclass
class SendResult:
    ok: bool
    status: Optional[int] = None
    code: Optional[str] = None
    retry_after_ms: Optional[float] = None
    error: Optional[str] = None


@dataclasses.dataclass
class FlushResult:
    accepted: int = 0
    delivered_items: int = 0
    retrying: int = 0
    dropped: int = 0


@dataclasses.dataclass
class Diagnostic:
    type: str
    message: str
    details: Dict[str, Any] = dataclasses.field(default_factory=dict)


Sender = Callable[[c.Chunk], SendResult]


class DeliveryQueue:
    def __init__(
        self,
        send: Sender,
        base: Callable[[], Dict[str, Any]],
        *,
        max_bytes: int = c.MAX_CHUNK_BYTES,
        max_items: int = c.MAX_CHUNK_ITEMS,
        max_queue_items: int = c.MAX_QUEUE_ITEMS,
        max_attempts: int = c.MAX_ATTEMPTS,
        base_backoff_ms: float = c.BASE_BACKOFF_MS,
        max_backoff_ms: float = c.MAX_BACKOFF_MS,
        redact_keys: Optional[List[str]] = None,
        on_diagnostic: Optional[Callable[[Diagnostic], None]] = None,
        auto_flush: bool = True,
        now: Callable[[], float] = time.monotonic,
        rand: Callable[[], float] = random.random,
        new_batch_id: Callable[[], str] = c.new_batch_id,
    ) -> None:
        self._send = send
        self._base = base
        self._max_bytes = max_bytes
        self._max_items = max(1, min(max_items, c.MAX_CHUNK_ITEMS))
        self._max_queue_items = max_queue_items
        self._max_attempts = max_attempts
        self._base_backoff = base_backoff_ms
        self._max_backoff = max_backoff_ms
        self._redact_keys = list(redact_keys or [])
        self._on_diagnostic = on_diagnostic
        self._auto_flush = auto_flush
        self._now = now
        self._rand = rand
        self._new_batch_id = new_batch_id
        self._error_threshold = max(1, (self._max_items + 1) // 2)

        self._lock = threading.Lock()
        self._drain_lock = threading.Lock()
        self._pending: Dict[str, List[c.PreparedItem]] = {k: [] for k in c.KINDS}
        self._pending_bytes = 0
        self._retry: List[c.Chunk] = []
        self._overflow = {k: 0 for k in c.KINDS}
        self._delivered = 0

        self._wake = threading.Event()
        self._stop = threading.Event()
        self._worker: Optional[threading.Thread] = None
        self._interval = 0.0
        if hasattr(os, "register_at_fork"):
            os.register_at_fork(after_in_child=self._after_fork_in_child)

    # ── Worker ────────────────────────────────────────────────────────────────

    def start(self, interval_seconds: float) -> None:
        self._interval = interval_seconds
        self._stop.clear()
        if self._worker is None or not self._worker.is_alive():
            self._worker = threading.Thread(target=self._run, name="watchup-delivery", daemon=True)
            self._worker.start()

    def _run(self) -> None:
        while not self._stop.is_set():
            timeout = self._interval if self._interval > 0 else None
            with self._lock:
                if self._retry:
                    due_in = min(ch.next_attempt_at for ch in self._retry) - self._now()
                    timeout = max(0.0, due_in) if timeout is None else max(0.0, min(timeout, due_in))
            self._wake.wait(timeout)
            self._wake.clear()
            if self._stop.is_set():
                break
            try:
                self.flush()
            except Exception:  # pragma: no cover - defensive: the worker must survive
                log.debug("[watchup] delivery loop error", exc_info=True)

    def stop(self) -> None:
        self._stop.set()
        self._wake.set()

    def _after_fork_in_child(self) -> None:
        # The parent keeps (and sends) everything queued before the fork, so the
        # child starts empty with fresh locks and restarts its worker lazily.
        self._lock = threading.Lock()
        self._drain_lock = threading.Lock()
        self._pending = {k: [] for k in c.KINDS}
        self._pending_bytes = 0
        self._retry = []
        self._wake = threading.Event()
        worker_was_running = self._worker is not None and not self._stop.is_set()
        self._stop = threading.Event()
        self._worker = None
        if worker_was_running:
            self.start(self._interval)

    # ── Enqueue ───────────────────────────────────────────────────────────────

    def enqueue(self, kind: str, item: Dict[str, Any]) -> bool:
        normalized = c.normalize(item, self._redact_keys)
        if not isinstance(normalized, dict):
            return False
        budget = self._max_bytes - c.envelope_overhead(self._base())
        fit = c.fit_item(normalized, budget)
        noun = kind[:-1]
        if fit.truncated:
            self._diagnose("item_truncated", f"A {noun} was truncated to fit the request size limit.", kind=kind, bytes=fit.bytes)
        if fit.oversized:
            self._diagnose("item_oversized", f"A {noun} is still larger than the chunk limit; it will be sent alone.", kind=kind, bytes=fit.bytes)

        with self._lock:
            self._pending[kind].append(c.PreparedItem(kind, fit.json, fit.bytes))
            self._pending_bytes += fit.bytes
            self._enforce_bound()
            should_flush = self._auto_flush and (
                self._pending_count() >= self._max_items
                or self._pending_bytes >= self._max_bytes
                or len(self._pending["errors"]) >= self._error_threshold
            )
        if should_flush:
            # Never send on the caller's thread (it may be serving a request).
            self._wake.set()
        return True

    def _pending_count(self) -> int:
        return sum(len(v) for v in self._pending.values())

    def pending_count(self) -> int:
        with self._lock:
            return self._pending_count()

    def retrying_count(self) -> int:
        with self._lock:
            return sum(ch.items for ch in self._retry)

    @property
    def delivered_count(self) -> int:
        return self._delivered

    # ── Flush ─────────────────────────────────────────────────────────────────

    def flush(self, force: bool = False) -> FlushResult:
        """Send pending items and due retries. Blocks until the attempt finishes."""
        result = FlushResult()
        with self._drain_lock:
            with self._lock:
                self._report_overflow()
                now = self._now()
                due = [ch for ch in self._retry if force or ch.next_attempt_at <= now]
                self._retry = [ch for ch in self._retry if ch not in due]
                fresh = self._cut()
            for chunk in due + fresh:
                self._send_one(chunk, result)
        return result

    def _cut(self) -> List[c.Chunk]:
        if not self._pending_count():
            return []
        groups = self._pending
        self._pending = {k: [] for k in c.KINDS}
        self._pending_bytes = 0
        sent_at = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        return c.build_chunks(
            groups,
            self._base(),
            max_bytes=self._max_bytes,
            max_items=self._max_items,
            batch_id=self._new_batch_id(),
            sent_at=sent_at,
            now=self._now(),
        )

    def _send_one(self, chunk: c.Chunk, result: FlushResult) -> None:
        chunk.attempts += 1
        try:
            res = self._send(chunk)
        except Exception as exc:  # a broken sender is a network error
            res = SendResult(ok=False, error=str(exc))

        if res.ok:
            result.accepted += 1
            result.delivered_items += chunk.items
            self._delivered += chunk.items
            return

        details: Dict[str, Any] = {"idempotency_key": chunk.idempotency_key, "attempt": chunk.attempts, "items": chunk.items}
        if res.status is not None:
            details["status"] = res.status
        if res.code:
            details["code"] = res.code
        if res.error:
            details["error"] = res.error

        if res.status is not None and not c.is_retryable_status(res.status):
            result.dropped += 1
            suffix = f" {res.code}" if res.code else ""
            self._diagnose("chunk_rejected", f"The server rejected a batch (HTTP {res.status}{suffix}); it will not be retried.", **details)
            return
        if chunk.attempts >= self._max_attempts:
            result.dropped += 1
            self._diagnose("chunk_dropped", f"A batch failed {chunk.attempts} times and was dropped.", **details)
            return

        delay = self._backoff(chunk.attempts, res.retry_after_ms)
        # _now() is in seconds (time.monotonic); delay is in milliseconds.
        chunk.next_attempt_at = self._now() + delay / 1000.0
        with self._lock:
            self._retry.append(chunk)
            while len(self._retry) > c.MAX_RETRY_CHUNKS:
                old = self._retry.pop(0)
                result.dropped += 1
                self._diagnose("chunk_dropped", "Too many batches waiting for a retry; the oldest was dropped.", idempotency_key=old.idempotency_key, items=old.items)
        result.retrying += 1
        self._diagnose("chunk_retry", f"Batch delivery failed; retrying in {int(delay)} ms.", delay_ms=int(delay), **details)
        self._wake.set()

    def _backoff(self, attempt: int, retry_after_ms: Optional[float]) -> float:
        if retry_after_ms is not None:
            return min(retry_after_ms, c.MAX_RETRY_AFTER_MS)
        exp = min(self._max_backoff, self._base_backoff * (2 ** (attempt - 1)))
        return float(round(exp * (0.5 + self._rand() * 0.5)))

    # ── Shutdown ──────────────────────────────────────────────────────────────

    def shutdown(self, timeout: float = 5.0) -> int:
        """Stop the worker and deliver within ``timeout`` seconds. Returns undelivered count."""
        self.stop()
        deadline = time.monotonic() + timeout
        while True:
            self.flush()
            with self._lock:
                left = self._pending_count()
                retries = list(self._retry)
            if not left and not retries:
                break
            if not retries:
                break
            wait = max(0.0, min(ch.next_attempt_at for ch in retries) - self._now())
            if time.monotonic() + wait > deadline:
                break
            time.sleep(wait)

        undelivered = self.pending_count() + self.retrying_count()
        if undelivered:
            self._diagnose(
                "undelivered_on_shutdown",
                f"{undelivered} item(s) could not be delivered before shutdown.",
                pending=self.pending_count(),
                retrying=self.retrying_count(),
            )
        return undelivered

    # ── Internals ─────────────────────────────────────────────────────────────

    def _enforce_bound(self) -> None:
        excess = self._pending_count() - self._max_queue_items
        for kind in ("events", "traces", "errors"):
            while excess > 0 and self._pending[kind]:
                dropped = self._pending[kind].pop(0)
                self._pending_bytes -= dropped.bytes
                self._overflow[kind] += 1
                excess -= 1

    def _report_overflow(self) -> None:
        if not any(self._overflow.values()):
            return
        counts = dict(self._overflow)
        self._overflow = {k: 0 for k in c.KINDS}
        self._diagnose("queue_overflow", f"The queue was full; dropped {sum(counts.values())} oldest item(s).", **counts)

    def _diagnose(self, type_: str, message: str, **details: Any) -> None:
        if self._on_diagnostic is None:
            return
        try:
            self._on_diagnostic(Diagnostic(type_, message, details))
        except Exception:
            pass
