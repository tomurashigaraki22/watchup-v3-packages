"""
watchup · main client
"""

from __future__ import annotations

import os
import platform
import random
import threading
import traceback
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Literal, Optional, Union

from .batcher import Batcher
from .transport import Transport
from .types import ErrorPayload, EventPayload, TracePayload, WatchupUser

_DEFAULTS = {
    "base_url": "https://api.watchup.site",
    "flush_interval": 5.0,
    "max_batch_size": 100,
    "debug": False,
    "sample_rate": 1.0,
    "release": None,
    "logging": False,
    "log_level": "debug",
}

_LOG_LEVELS = {"debug": 10, "info": 20, "warning": 30, "error": 40, "critical": 50}


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
        Override for self-hosted deployments.
        Default: ``https://api.watchup.site``.
    environment : str
        Runtime label attached to every payload.
        Default: ``WATCHUP_ENV`` env var, or ``"production"``.
    release : str, optional
        App version / git SHA for deploy correlation.
    flush_interval : float
        Seconds between automatic queue flushes. Default: ``5.0``.
    max_batch_size : int
        Item count per type that triggers an immediate flush. Default: ``100``.
    sample_rate : float
        Fraction of requests to trace (0–1). Default: ``1.0``.
    debug : bool
        Log SDK warnings to stderr. Default: ``False``.
    logging : bool
        Enable opt-in structured log capture. Default: ``False``.
    log_level : str
        Lowest log level to capture: ``debug``, ``info``, ``warning``,
        ``error``, or ``critical``. Default: ``"debug"``.
    """

    def __init__(
        self,
        api_key: str,
        *,
        base_url: str = _DEFAULTS["base_url"],           # type: ignore[assignment]
        environment: Optional[str] = None,
        release: Optional[str] = None,
        flush_interval: float = _DEFAULTS["flush_interval"],  # type: ignore[assignment]
        max_batch_size: int = _DEFAULTS["max_batch_size"],    # type: ignore[assignment]
        sample_rate: float = _DEFAULTS["sample_rate"],        # type: ignore[assignment]
        debug: bool = _DEFAULTS["debug"],                     # type: ignore[assignment]
        logging: bool = _DEFAULTS["logging"],                 # type: ignore[assignment]
        log_level: Literal["debug", "info", "warning", "error", "critical"] = _DEFAULTS["log_level"],  # type: ignore[assignment]
    ) -> None:
        if not api_key:
            raise ValueError(
                "[watchup] api_key is required. "
                "Find it in your Watchup dashboard → Project Settings → API Keys."
            )

        self.environment: str = (
            environment
            or os.environ.get("WATCHUP_ENV")
            or os.environ.get("WATCHUP_ENVIRONMENT")
            or "production"
        )
        self.release: Optional[str] = release
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

        self._base_url = base_url
        self._api_key = api_key
        self._debug = debug
        self._logging_enabled = logging
        self._log_level = log_level if log_level in _LOG_LEVELS else "debug"

        transport = Transport(base_url, api_key, debug)
        self._batcher = Batcher(transport, flush_interval, max_batch_size)
        self._batcher.start()

        self._user: Optional[WatchupUser] = None

        # Feature flags
        self._flags: Dict[str, Any] = {}
        self._flags_lock = threading.Lock()
        self._flag_timer: Optional[threading.Timer] = None
        threading.Thread(target=self._fetch_flags, daemon=True).start()
        self._schedule_flag_poll()

    # ── Internal ──────────────────────────────────────────────────────────────

    def _user_dict(self) -> Optional[Dict[str, Any]]:
        return self._user.to_dict() if self._user else None

    def _should_sample(self) -> bool:
        """Return whether this request should create a trace."""
        return self._sample_rate >= 1 or (self._sample_rate > 0 and random.random() < self._sample_rate)

    def _fetch_flags(self) -> None:
        try:
            import urllib.request as _req
            request = _req.Request(
                f"{self._base_url}/api/v1/flags",
                headers={"X-Api-Key": self._api_key},
            )
            with _req.urlopen(request, timeout=8) as resp:
                import json as _json
                data = _json.loads(resp.read())
                if data.get("ok") and data.get("data", {}).get("flags"):
                    with self._flags_lock:
                        self._flags = {f["key"]: f for f in data["data"]["flags"]}
        except Exception:
            pass  # silently ignore — stale cache is fine

    def _schedule_flag_poll(self) -> None:
        self._flag_timer = threading.Timer(30.0, self._poll_flags)
        self._flag_timer.daemon = True
        self._flag_timer.start()

    def _poll_flags(self) -> None:
        self._fetch_flags()
        self._schedule_flag_poll()

    @staticmethod
    def _flag_bucket(flag_key: str, user_id: str) -> int:
        s = f"{flag_key}:{user_id}"
        h = 5381
        for ch in s.encode():
            h = ((h * 33) ^ ch) & 0xFFFFFFFF
        return h % 100

    # ── User identification ───────────────────────────────────────────────────

    def set_user(
        self,
        id: Union[str, int],
        *,
        email: Optional[str] = None,
        name: Optional[str] = None,
        **extra: Any,
    ) -> None:
        """
        Attach a user to all subsequent errors and traces.

        Example::

            watchup.set_user("usr_42", email="alice@example.com", name="Alice", plan="pro")
        """
        self._user = WatchupUser(id=id, email=email, name=name, extra=extra or None)

    def clear_user(self) -> None:
        """Remove the current user context."""
        self._user = None

    # ── Flask integration ─────────────────────────────────────────────────────

    def init_app(self, app: Any) -> None:
        """
        Register Watchup on a Flask application instance.

        Example::

            app = Flask(__name__)
            watchup.init_app(app)

        Registers ``before_request``, ``after_request``, and ``errorhandler``
        hooks automatically.
        """
        from .middleware import _flask_init_app
        _flask_init_app(self, app)

    # ── Manual tracking ───────────────────────────────────────────────────────

    def track(self, name: str, properties: Optional[Dict[str, Any]] = None) -> None:
        """
        Send a custom analytics event.

        Example::

            watchup.track("user.signed_up", {"plan": "pro", "source": "invite"})
            watchup.track("order.placed", {"amount": 4999, "currency": "NGN"})
        """
        if not name:
            return
        event = EventPayload(
            name=name,
            occurred_at=_now(),
            properties=properties or None,
        )
        self._batcher.add_event(event)

    def capture_log(
        self,
        message: str,
        *,
        level: Literal["debug", "info", "warning", "error", "critical"] = "info",
        route: Optional[str] = None,
        **context: Any,
    ) -> None:
        """Capture one structured server log for the Live logs stream.

        Log capture is disabled by default. When enabled, log entries are sent
        as ``log.<level>`` events and keep the current Watchup user context.
        """
        normalized_level = level if level in _LOG_LEVELS else "info"
        if not self._logging_enabled or _LOG_LEVELS[normalized_level] < _LOG_LEVELS[self._log_level]:
            return

        properties: Dict[str, Any] = dict(context)
        properties.update({
            "message": str(message),
            "level": normalized_level,
            "source": "server",
            "runtime": {
                "python": platform.python_version(),
                "implementation": platform.python_implementation(),
                "platform": platform.system(),
                "architecture": platform.machine(),
            },
        })
        if route:
            properties["route"] = route
        user = self._user_dict()
        if user:
            properties["user"] = user

        self._batcher.add_event(EventPayload(
            name=f"log.{normalized_level}",
            occurred_at=_now(),
            properties=properties,
        ))

    def capture_error(
        self,
        error: Union[BaseException, str],
        *,
        route: Optional[str] = None,
        level: Literal["debug", "info", "warning", "error", "fatal"] = "error",
        **context: Any,
    ) -> None:
        """
        Manually capture an error — use this for background jobs, queue
        consumers, cron tasks, or anywhere outside a request context.

        Example::

            try:
                process_order(order_id)
            except Exception as exc:
                watchup.capture_error(exc, route="job.process_order", order_id=order_id)
        """
        if isinstance(error, BaseException):
            message = str(error)
            stack = "".join(
                traceback.format_exception(type(error), error, error.__traceback__)
            )
        else:
            message = str(error)
            stack = None

        normalized_level = level if level in ("debug", "info", "warning", "error", "fatal") else "error"
        payload = ErrorPayload(
            message=message,
            level=normalized_level,
            route=route,
            stack=stack,
            error_type=type(error).__name__ if isinstance(error, BaseException) else None,
            context=context or None,
            timestamp=_now(),
            environment=self.environment,
            release=self.release,
            user=self._user_dict(),
        )
        self._batcher.add_error(payload)

    def start_trace(self, span: str) -> Callable[..., None]:
        """
        Time a non-HTTP operation and record it as a trace.

        Returns an ``end()`` callable. Call it when the operation finishes.

        Example::

            end = watchup.start_trace("db.query_users")
            try:
                rows = db.query(sql)
                end()                      # status defaults to "ok"
            except Exception as exc:
                end(status="err")
                raise

        The ``end()`` callable accepts optional keyword arguments:
            - ``status``: ``"ok"`` (default), ``"warn"``, or ``"err"``
            - ``meta``: arbitrary dict of extra context
        """
        import time as _time
        start = _time.time()

        def end(
            *,
            status: Literal["ok", "warn", "err"] = "ok",
            meta: Optional[Dict[str, Any]] = None,
        ) -> None:
            if status not in ("ok", "warn", "err"):
                status = "ok"
            ms = (_time.time() - start) * 1000
            status_code = 500 if status == "err" else 400 if status == "warn" else 200
            trace = TracePayload(
                span=span,
                ms=ms,
                status_code=status_code,
                status=status,
                timestamp=_now(),
                environment=self.environment,
                release=self.release,
                meta=meta,
                user=self._user_dict(),
            )
            self._batcher.add_trace(trace)

        return end

    # ── Feature flags ─────────────────────────────────────────────────────────

    def is_enabled(self, key: str, *, user_id: Optional[str] = None, **ctx: Any) -> bool:
        """
        Check whether a feature flag is enabled for a given user.
        Evaluated locally with zero network latency.

        Example::

            if watchup.is_enabled("new-checkout", user_id=user.id):
                return new_checkout_view(request)
        """
        with self._flags_lock:
            flag = self._flags.get(key)
        if not flag or not flag.get("enabled"):
            return False
        rollout = flag.get("rollout_percentage", 100)
        if rollout >= 100:
            return True
        if rollout <= 0:
            return False
        uid = str(user_id or ctx.get("email") or "")
        if not uid:
            return False
        return self._flag_bucket(key, uid) < rollout

    def get_variant(self, key: str, *, user_id: Optional[str] = None, **ctx: Any) -> str:
        """
        Get the variant key for a multivariate (A/B) flag.
        Returns ``"control"`` if the flag is off or the user is not in the rollout.

        Example::

            variant = watchup.get_variant("pricing-layout", user_id=user.id)
            # → "control" | "variant-a" | "variant-b"
        """
        if not self.is_enabled(key, user_id=user_id, **ctx):
            return "control"
        with self._flags_lock:
            flag = self._flags.get(key)
        variants: List[Dict[str, Any]] = flag.get("variants", []) if flag else []
        if not variants:
            return "on"
        uid = str(user_id or ctx.get("email") or "")
        bucket = self._flag_bucket(key, uid) if uid else 0
        cumulative = 0
        for variant in variants:
            cumulative += variant.get("weight", 0)
            if bucket < cumulative:
                return variant["key"]
        return variants[-1]["key"]

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    def flush(self) -> None:
        """Immediately flush all queued items."""
        self._batcher.flush(wait=True)

    def shutdown(self) -> None:
        """Stop the background flush timer and send remaining items."""
        if self._flag_timer:
            self._flag_timer.cancel()
            self._flag_timer = None
        self._batcher.stop()
        self._batcher.flush()
