"""
watchup · main client
"""

from __future__ import annotations

import contextlib
import functools
import json
import logging as _logging
import os
import platform
import random
import threading
import time
import traceback
import urllib.request
from datetime import datetime, timezone
from typing import Any, Callable, Dict, Iterator, List, Literal, Optional, TypeVar, Union, cast

from . import _contract as c
from ._queue import DeliveryQueue, Diagnostic, FlushResult
from ._version import SDK_NAME, SDK_VERSION
from .context import RequestContext, current, scope
from .flags import FlagStore
from .sql import sanitize_sql
from .transport import Transport
from .types import ErrorPayload, EventPayload, TracePayload, WatchupUser

log = _logging.getLogger("watchup")

_LOG_LEVELS = {"debug": 10, "info": 20, "warning": 30, "error": 40, "critical": 50}
_ERROR_LEVELS = ("debug", "info", "warning", "error", "fatal")

TraceStatus = Literal["ok", "warn", "err"]
F = TypeVar("F", bound=Callable[..., Any])

_CAPTURED_ATTR = "__watchup_captured__"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class Watchup:
    """
    Watchup monitoring client.

    Parameters
    ----------
    api_key : str
        Your project API key (``wup_live_…``).
    base_url : str
        Override for self-hosted deployments. Default: ``https://api.watchup.site``.
    environment : str
        Runtime label. Default: ``WATCHUP_ENV`` / ``WATCHUP_ENVIRONMENT`` env var, or ``"production"``.
    release : str, optional
        App version / git SHA for deploy correlation.
    service : str, optional
        Service name attached to every item (e.g. ``"api"``, ``"worker"``).
    flush_interval : float
        Seconds between background flushes. Default: ``5.0``.
    max_batch_size : int
        Max items per request (capped at the server's 100). Default: ``100``.
    max_queue_size : int
        Max items kept while the API is unreachable; oldest events drop first. Default: ``1000``.
    sample_rate : float
        Fraction of requests to trace (0–1). Default: ``1.0``.
    debug : bool
        Log SDK diagnostics through the ``watchup`` logger. Default: ``False``.
    logging : bool
        Enable opt-in structured log capture. Default: ``False``.
    log_level : str
        Lowest log level to capture. Default: ``"debug"``.
    redact_keys : list of str, optional
        Extra keys to redact on top of the built-in list.
    on_diagnostic : callable, optional
        Receives delivery diagnostics (never captured data).
    flag_refresh_interval : float
        Seconds between feature-flag refreshes; ``0`` disables flags. Default: ``30``.
    shutdown_timeout : float
        Max seconds ``shutdown()`` waits for delivery. Default: ``5``.
    """

    def __init__(
        self,
        api_key: str,
        *,
        base_url: str = c.DEFAULT_BASE_URL,
        environment: Optional[str] = None,
        release: Optional[str] = None,
        service: Optional[str] = None,
        flush_interval: float = 5.0,
        max_batch_size: int = c.MAX_CHUNK_ITEMS,
        max_queue_size: int = c.MAX_QUEUE_ITEMS,
        sample_rate: float = 1.0,
        debug: bool = False,
        logging: bool = False,
        log_level: Literal["debug", "info", "warning", "error", "critical"] = "debug",
        redact_keys: Optional[List[str]] = None,
        on_diagnostic: Optional[Callable[[Diagnostic], None]] = None,
        flag_refresh_interval: float = 30.0,
        shutdown_timeout: float = 5.0,
        timeout: float = 8.0,
    ) -> None:
        if not api_key:
            raise ValueError(
                "[watchup] api_key is required. Find it in your Watchup dashboard → Project Settings → API Keys."
            )
        try:
            self._sample_rate = float(sample_rate)
        except (TypeError, ValueError) as exc:
            raise ValueError("[watchup] sample_rate must be a number between 0 and 1") from exc
        if not 0 <= self._sample_rate <= 1:
            raise ValueError("[watchup] sample_rate must be between 0 and 1")
        if flush_interval <= 0:
            raise ValueError("[watchup] flush_interval must be greater than 0")
        if max_batch_size < 1:
            raise ValueError("[watchup] max_batch_size must be at least 1")

        self.environment: str = (
            environment or os.environ.get("WATCHUP_ENV") or os.environ.get("WATCHUP_ENVIRONMENT") or "production"
        )
        self.release: Optional[str] = release
        self.service: Optional[str] = service
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._debug = debug
        self._logging_enabled = logging
        self._log_level = log_level if log_level in _LOG_LEVELS else "debug"
        self._on_diagnostic = on_diagnostic
        self._shutdown_timeout = shutdown_timeout
        self._user: Optional[WatchupUser] = None
        self._closed = False

        self._transport = Transport(self._base_url, api_key, timeout=timeout)
        self._queue = DeliveryQueue(
            self._transport.send,
            self._envelope_base,
            max_items=max_batch_size,
            max_queue_items=max_queue_size,
            redact_keys=redact_keys,
            on_diagnostic=self._diagnostic,
        )
        self._queue.start(flush_interval)

        self._flags = FlagStore()
        self._flag_interval = flag_refresh_interval
        self._flag_timer: Optional[threading.Timer] = None
        if flag_refresh_interval > 0:
            threading.Thread(target=self._poll_flags, name="watchup-flags", daemon=True).start()

        # Weak reference: registering a bound method would keep every client alive.
        import atexit
        import weakref

        ref = weakref.ref(self)
        atexit.register(lambda: (lambda client: client._atexit() if client else None)(ref()))

    # ── Compatibility shims for the framework integrations ────────────────────

    @property
    def _batcher(self) -> Watchup:
        """Integrations from 2.0 call ``client._batcher.add_*``; keep that working."""
        return self

    def add_trace(self, trace: TracePayload) -> None:
        self._queue.enqueue("traces", trace.to_dict())

    def add_error(self, error: ErrorPayload) -> None:
        self._queue.enqueue("errors", error.to_dict())

    def add_event(self, event: EventPayload) -> None:
        self._queue.enqueue("events", event.to_dict())

    # ── Internal ──────────────────────────────────────────────────────────────

    def _envelope_base(self) -> Dict[str, Any]:
        base: Dict[str, Any] = {"sdk": {"name": SDK_NAME, "version": SDK_VERSION}, "environment": self.environment}
        if self.release:
            base["release"] = self.release
        return base

    def _diagnostic(self, d: Diagnostic) -> None:
        if self._debug:
            log.warning("[watchup] %s: %s", d.type, d.message)
        if self._on_diagnostic is not None:
            try:
                self._on_diagnostic(d)
            except Exception:
                pass

    def _user_dict(self) -> Optional[Dict[str, Any]]:
        ctx = current()
        if ctx is not None and ctx.user is not None:
            return dict(ctx.user)
        return self._user.to_dict() if self._user else None

    def _base_context(self) -> Dict[str, Any]:
        return self._base_context_for(current())

    def _base_context_for(self, ctx: Optional[RequestContext]) -> Dict[str, Any]:
        out: Dict[str, Any] = {"source": "server"}
        if self.service:
            out["service"] = self.service
        if ctx is not None:
            out["request_id"] = ctx.request_id
            if ctx.trace_id:
                out["trace_id"] = ctx.trace_id
        return out

    def _should_sample(self) -> bool:
        return self._sample_rate >= 1 or (self._sample_rate > 0 and random.random() < self._sample_rate)

    def _poll_flags(self) -> None:
        self.refresh_flags()
        if self._closed or self._flag_interval <= 0:
            return
        self._flag_timer = threading.Timer(self._flag_interval, self._poll_flags)
        self._flag_timer.daemon = True
        self._flag_timer.start()

    def refresh_flags(self) -> None:
        """Fetch feature flags now. Keeps the cached flags on any failure."""
        try:
            request = urllib.request.Request(
                f"{self._base_url}/api/v1/flags",
                headers={"Authorization": f"Bearer {self._api_key}", "X-Api-Key": self._api_key},
            )
            with urllib.request.urlopen(request, timeout=8) as resp:
                data = json.loads(resp.read())
            flags = data.get("data", {}).get("flags") if data.get("ok") else None
            if isinstance(flags, list):
                self._flags.replace(flags)
        except Exception:
            pass

    @staticmethod
    def _flag_bucket(flag_key: str, user_id: str) -> int:
        from .flags import flag_bucket

        return flag_bucket(flag_key, user_id)

    def _atexit(self) -> None:
        if not self._closed:
            self.shutdown()

    # ── User identification & context ─────────────────────────────────────────

    def set_user(
        self,
        id: Union[str, int],
        *,
        email: Optional[str] = None,
        name: Optional[str] = None,
        **extra: Any,
    ) -> None:
        """
        Attach a user. Inside a request handled by a WatchUp middleware (or
        ``request_context()``) it applies to that request only; otherwise it
        becomes the default for everything this client captures.

        Example::

            watchup.set_user("usr_42", email="alice@example.com", name="Alice", plan="pro")
        """
        user = WatchupUser(id=id, email=email, name=name, extra=extra or None)
        ctx = current()
        if ctx is not None:
            ctx.user = user.to_dict()
        else:
            self._user = user

    def clear_user(self) -> None:
        """Remove the user from the current request (or the default user)."""
        ctx = current()
        if ctx is not None:
            ctx.user = None
        else:
            self._user = None

    @contextlib.contextmanager
    def request_context(self, **fields: Any) -> Iterator[RequestContext]:
        """
        Run a block with its own context (request ID, user) — for jobs, queue
        consumers and anything outside the framework middleware.

        Example::

            with watchup.request_context(route="job.send_email"):
                watchup.set_user(job.user_id)
                send_email(job)
        """
        with scope(RequestContext(**fields)) as ctx:
            yield ctx

    # ── Flask integration ─────────────────────────────────────────────────────

    def init_app(self, app: Any) -> None:
        """Register Watchup on a Flask application (request traces, error capture, request context)."""
        from .middleware import _flask_init_app

        _flask_init_app(self, app)

    # ── Manual tracking ───────────────────────────────────────────────────────

    def track(self, name: str, properties: Optional[Dict[str, Any]] = None) -> None:
        """
        Send a custom analytics event.

        Example::

            watchup.track("user.signed_up", {"plan": "pro", "source": "invite"})
        """
        if not name or self._closed:
            return
        props: Dict[str, Any] = self._base_context()
        user = self._user_dict()
        if user:
            props["user"] = user
        props.update(properties or {})
        self._queue.enqueue("events", {"name": name, "properties": props, "occurred_at": _now()})

    def capture_log(
        self,
        message: str,
        *,
        level: Literal["debug", "info", "warning", "error", "critical"] = "info",
        route: Optional[str] = None,
        **context: Any,
    ) -> None:
        """Capture one structured log for the Live logs stream (opt-in via ``logging=True``)."""
        normalized_level = level if level in _LOG_LEVELS else "info"
        if self._closed or not self._logging_enabled or _LOG_LEVELS[normalized_level] < _LOG_LEVELS[self._log_level]:
            return
        properties: Dict[str, Any] = dict(context)
        properties.update(self._base_context())
        properties.update(
            {
                "message": str(message),
                "level": normalized_level,
                "runtime": {
                    "python": platform.python_version(),
                    "implementation": platform.python_implementation(),
                    "platform": platform.system(),
                    "architecture": platform.machine(),
                },
            }
        )
        ctx = current()
        resolved_route = route or (ctx.route if ctx else None)
        if resolved_route:
            properties["route"] = resolved_route
        user = self._user_dict()
        if user:
            properties["user"] = user
        self._queue.enqueue("events", {"name": f"log.{normalized_level}", "properties": properties, "occurred_at": _now()})

    def capture_error(
        self,
        error: Union[BaseException, str],
        *,
        route: Optional[str] = None,
        level: Literal["debug", "info", "warning", "error", "fatal"] = "error",
        **context: Any,
    ) -> None:
        """
        Capture an error. Each exception object is reported once, even if it
        passes through several handlers.

        Example::

            try:
                process_order(order_id)
            except Exception as exc:
                watchup.capture_error(exc, route="job.process_order", order_id=order_id)
        """
        if self._closed:
            return
        if isinstance(error, BaseException):
            if getattr(error, _CAPTURED_ATTR, False):
                return
            with contextlib.suppress(Exception):
                setattr(error, _CAPTURED_ATTR, True)
            message = str(error) or type(error).__name__
            stack: Optional[str] = "".join(traceback.format_exception(type(error), error, error.__traceback__))
            error_type: Optional[str] = type(error).__name__
        else:
            message, stack, error_type = str(error), None, None

        ctx = current()
        merged: Dict[str, Any] = dict(context)
        merged.update(self._base_context())
        payload = ErrorPayload(
            message=message,
            level=level if level in _ERROR_LEVELS else "error",
            route=route or (ctx.route if ctx else None),
            stack=stack,
            error_type=error_type,
            context=merged,
            timestamp=_now(),
            environment=self.environment,
            release=self.release,
            user=self._user_dict(),
        )
        self._queue.enqueue("errors", payload.to_dict())

    def start_trace(self, span: str, *, type: Literal["http", "function", "db", "custom"] = "custom") -> Callable[..., None]:
        """
        Time an operation and record it as a trace. Returns ``end()``, which
        accepts ``status`` (``"ok"``/``"warn"``/``"err"``), ``meta`` and
        ``status_code``.

        Example::

            end = watchup.start_trace("db.query_users")
            try:
                rows = db.query(sql)
                end()
            except Exception:
                end(status="err")
                raise
        """
        start = time.perf_counter()
        started_at = _now()
        base = self._base_context()
        user = self._user_dict()
        ctx = current()
        parent = ctx.route if ctx else None
        done = threading.Event()

        def end(
            *,
            status: TraceStatus = "ok",
            meta: Optional[Dict[str, Any]] = None,
            status_code: Optional[int] = None,
        ) -> None:
            if done.is_set() or self._closed:
                return
            done.set()
            if status not in ("ok", "warn", "err"):
                status = "ok"
            merged = dict(meta or {})
            merged.update(base)
            if parent and parent != span:
                merged["parent_route"] = parent
            trace = TracePayload(
                span=span,
                ms=(time.perf_counter() - start) * 1000,
                status_code=status_code if status_code is not None else 500 if status == "err" else 400 if status == "warn" else 200,
                status=status,
                timestamp=started_at,
                environment=self.environment,
                release=self.release,
                meta=merged,
                user=user,
                trace_type=type,
            )
            self._queue.enqueue("traces", trace.to_dict())

        return end

    @contextlib.contextmanager
    def trace(self, span: str, *, type: Literal["http", "function", "db", "custom"] = "custom") -> Iterator[None]:
        """
        Context manager form of ``start_trace``; exceptions mark the trace ``err``
        and propagate unchanged.

        Example::

            with watchup.trace("job.generate_report"):
                generate_report()
        """
        end = self.start_trace(span, type=type)
        try:
            yield
        except BaseException:
            end(status="err")
            raise
        end()

    @contextlib.contextmanager
    def trace_query(self, statement: str, *, system: Optional[str] = None, slow_ms: float = 500) -> Iterator[None]:
        """
        Record a database span. The statement is sanitized (literals become ``?``,
        max 1 KiB); parameters are never recorded. Slow queries are marked ``warn``.

        Example::

            with watchup.trace_query("SELECT * FROM orders WHERE id = %s", system="postgresql"):
                cursor.execute(sql, (order_id,))
        """
        sql = sanitize_sql(statement)
        meta: Dict[str, Any] = {"db_system": system} if system else {}
        start = time.perf_counter()
        end = self.start_trace(sql, type="db")
        try:
            yield
        except BaseException:
            end(status="err", meta=meta)
            raise
        elapsed = (time.perf_counter() - start) * 1000
        if elapsed > slow_ms:
            end(status="warn", meta={**meta, "slow": True})
        else:
            end(meta=meta)

    def monitor(self, name: Optional[str] = None) -> Callable[[F], F]:
        """
        Decorator for background work: runs the function in its own context,
        records a trace, and captures (then re-raises) any exception.

        Example::

            @watchup.monitor("job.nightly_cleanup")
            def nightly_cleanup(): ...
        """

        def decorate(fn: F) -> F:
            span = name or f"{fn.__module__}.{fn.__qualname__}"

            @functools.wraps(fn)
            def wrapper(*args: Any, **kwargs: Any) -> Any:
                with self.request_context(route=span):
                    with self.trace(span, type="function"):
                        try:
                            return fn(*args, **kwargs)
                        except Exception as exc:
                            self.capture_error(exc, route=span)
                            raise

            return cast(F, wrapper)

        return decorate

    # ── Feature flags ─────────────────────────────────────────────────────────

    def is_enabled(self, key: str, *, user_id: Optional[str] = None, **ctx: Any) -> bool:
        """
        Whether a flag is enabled for a user (local evaluation). Uses the
        current user when no ``user_id`` is given.

        Example::

            if watchup.is_enabled("new-checkout", user_id=user.id):
                return new_checkout_view(request)
        """
        return self._flags.is_enabled(key, self._flag_ctx(user_id, ctx))

    def get_variant(self, key: str, *, user_id: Optional[str] = None, **ctx: Any) -> str:
        """Variant key for a multivariate flag; ``"control"`` when off or not in rollout."""
        return self._flags.get_variant(key, self._flag_ctx(user_id, ctx))

    def _flag_ctx(self, user_id: Optional[str], ctx: Dict[str, Any]) -> Dict[str, Any]:
        user = self._user_dict() or {}
        merged: Dict[str, Any] = {"userId": user.get("id"), "email": user.get("email")}
        merged.update(ctx)
        if user_id is not None:
            merged["userId"] = user_id
        return merged

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    def flush(self) -> FlushResult:
        """Send everything queued now. Blocks until the attempt completes; never raises."""
        return self._queue.flush()

    def shutdown(self) -> None:
        """Stop background threads and deliver what is queued (up to ``shutdown_timeout``)."""
        if self._closed:
            return
        self._closed = True
        if self._flag_timer:
            self._flag_timer.cancel()
            self._flag_timer = None
        self._queue.shutdown(self._shutdown_timeout)
