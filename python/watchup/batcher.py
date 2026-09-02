"""
watchup · batcher

Accumulates traces/errors/events and flushes them in batches via a
background daemon thread. The thread is daemonised so it never prevents
the interpreter from exiting.
"""

from __future__ import annotations

import atexit
import threading
from typing import List, Optional, Set

from .transport import Transport
from .types import ErrorPayload, EventPayload, IngestBatch, TracePayload


class Batcher:
    def __init__(
        self,
        transport: Transport,
        flush_interval: float,
        max_batch_size: int,
    ) -> None:
        self._transport = transport
        self._flush_interval = flush_interval
        self._max_batch_size = max_batch_size

        self._lock = threading.Lock()
        self._traces: List[TracePayload] = []
        self._errors: List[ErrorPayload] = []
        self._events: List[EventPayload] = []

        self._timer: Optional[threading.Timer] = None
        self._started = False
        self._send_threads: Set[threading.Thread] = set()

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    def start(self) -> None:
        if self._started:
            return
        self._started = True
        self._schedule()
        atexit.register(lambda: self.flush(wait=True))

    def stop(self) -> None:
        self._started = False
        if self._timer is not None:
            self._timer.cancel()
            self._timer = None

    def _schedule(self) -> None:
        if not self._started:
            return
        self._timer = threading.Timer(self._flush_interval, self._tick)
        self._timer.daemon = True
        self._timer.start()

    def _tick(self) -> None:
        self.flush()
        self._schedule()

    # ── Enqueue ───────────────────────────────────────────────────────────────

    def add_trace(self, trace: TracePayload) -> None:
        with self._lock:
            self._traces.append(trace)
            should_flush = len(self._traces) >= self._max_batch_size
        if should_flush:
            self.flush()

    def add_error(self, error: ErrorPayload) -> None:
        with self._lock:
            self._errors.append(error)
            # Errors are higher priority — flush at half capacity
            should_flush = len(self._errors) >= max(1, self._max_batch_size // 2)
        if should_flush:
            self.flush()

    def add_event(self, event: EventPayload) -> None:
        with self._lock:
            self._events.append(event)
            should_flush = len(self._events) >= self._max_batch_size
        if should_flush:
            self.flush()

    # ── Flush ─────────────────────────────────────────────────────────────────

    def flush(self, wait: bool = False) -> None:
        with self._lock:
            traces = self._traces[:]
            errors = self._errors[:]
            events = self._events[:]
            self._traces.clear()
            self._errors.clear()
            self._events.clear()

        if not traces and not errors and not events:
            return

        batch = IngestBatch(traces=traces, errors=errors, events=events)
        # Run in a daemon thread so request handling is never blocked. Failed
        # batches are put back into the queue instead of being silently lost.
        t = threading.Thread(target=self._send_batch, args=(batch,), daemon=True)
        with self._lock:
            self._send_threads.add(t)
        t.start()

        if wait:
            t.join(timeout=10)

    def _send_batch(self, batch: IngestBatch) -> None:
        current = threading.current_thread()
        try:
            try:
                sent = self._transport.send(batch)
            except Exception:
                sent = False
            if not sent:
                with self._lock:
                    self._traces[0:0] = batch.traces
                    self._errors[0:0] = batch.errors
                    self._events[0:0] = batch.events
        finally:
            with self._lock:
                self._send_threads.discard(current)
