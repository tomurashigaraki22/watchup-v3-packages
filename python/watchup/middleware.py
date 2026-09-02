"""
watchup · middleware integrations

Flask
-----
    from watchup import Watchup
    watchup = Watchup(api_key="wup_live_...")
    watchup.init_app(app)

Django
------
    # settings.py
    MIDDLEWARE = [
        "watchup.middleware.WatchupDjangoMiddleware",
        ...
    ]
    WATCHUP_API_KEY = "wup_live_..."

WSGI (framework-agnostic)
------
    app.wsgi_app = WatchupWSGI(app.wsgi_app, watchup)
"""

from __future__ import annotations

import os
import time
import traceback
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any, Awaitable, Callable, Dict, Optional

from .types import ErrorPayload, TracePayload

if TYPE_CHECKING:
    from .client import Watchup


# ── helpers ───────────────────────────────────────────────────────────────────

def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _trace_status(status_code: int) -> str:
    if status_code >= 500:
        return "err"
    if status_code >= 400:
        return "warn"
    return "ok"


def _normalise_path(path: str) -> str:
    import re
    path = re.sub(r"/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", "/:id", path, flags=re.I)
    path = re.sub(r"/\d+", "/:id", path)
    return path.rstrip("/") or "/"


def _request_context(method: str, path: str, **extra: Any) -> Dict[str, Any]:
    """Build safe request context without copying authorization or cookies."""
    context: Dict[str, Any] = {"method": method, "path": path}
    context.update({key: value for key, value in extra.items() if value is not None})
    return context


# ── Flask integration ─────────────────────────────────────────────────────────

def _flask_init_app(watchup_client: "Watchup", app: Any) -> None:
    """Register Watchup before/after/teardown hooks on a Flask app."""
    try:
        from flask import g, request
    except ImportError as exc:
        raise ImportError(
            "Flask is not installed. Run: pip install flask"
        ) from exc

    @app.before_request
    def _before() -> None:
        g._watchup_start = time.time()

    @app.after_request
    def _after(response: Any) -> Any:
        start = getattr(g, "_watchup_start", None)
        if start is None:
            return response

        ms = (time.time() - start) * 1000
        route = request.endpoint or _normalise_path(request.path)
        span = f"{request.method} {route}"

        if not watchup_client._should_sample():
            return response

        trace = TracePayload(
            span=span,
            ms=ms,
            status_code=response.status_code,
            status=_trace_status(response.status_code),  # type: ignore[arg-type]
            timestamp=_now(),
            environment=watchup_client.environment,
            release=watchup_client.release,
            meta=_request_context(
                request.method,
                _normalise_path(request.path),
                url=request.base_url,
                user_agent=request.headers.get("User-Agent"),
                remote_addr=request.remote_addr,
            ),
            user=watchup_client._user_dict(),
        )
        watchup_client._batcher.add_trace(trace)
        return response

    @app.errorhandler(Exception)
    def _on_error(exc: Exception) -> Any:
        error = ErrorPayload(
            message=str(exc),
            level="error",
            route=f"{request.method} {_normalise_path(request.path)}",
            stack=traceback.format_exc(),
            context=_request_context(
                request.method,
                _normalise_path(request.path),
                url=request.base_url,
                user_agent=request.headers.get("User-Agent"),
                remote_addr=request.remote_addr,
            ),
            timestamp=_now(),
            environment=watchup_client.environment,
            release=watchup_client.release,
            user=watchup_client._user_dict(),
        )
        watchup_client._batcher.add_error(error)
        raise exc  # re-raise so Flask still handles it normally


# ── Django middleware class ───────────────────────────────────────────────────

class WatchupDjangoMiddleware:
    """
    Django middleware. Add to MIDDLEWARE in settings.py:

        MIDDLEWARE = [
            "watchup.middleware.WatchupDjangoMiddleware",
            ...
        ]

    Requires WATCHUP_API_KEY in Django settings (or the WATCHUP_API_KEY env var).
    Optionally set WATCHUP_ENVIRONMENT and WATCHUP_RELEASE in Django settings.
    """

    def __init__(self, get_response: Callable) -> None:
        self.get_response = get_response
        from django.conf import settings as django_settings
        from .client import Watchup

        api_key = (
            getattr(django_settings, "WATCHUP_API_KEY", None)
            or os.environ.get("WATCHUP_API_KEY", "")
        )
        environment = (
            getattr(django_settings, "WATCHUP_ENVIRONMENT", None)
            or os.environ.get("WATCHUP_ENVIRONMENT", "production")
        )
        release = getattr(django_settings, "WATCHUP_RELEASE", None)
        self.client = Watchup(api_key=api_key, environment=environment, release=release)

    def __call__(self, request: Any) -> Any:
        start = time.time()
        try:
            response = self.get_response(request)
        except Exception as exc:
            client = self.client
            error = ErrorPayload(
                    message=str(exc),
                    level="error",
                    route=f"{request.method} {_normalise_path(request.path)}",
                    stack=traceback.format_exc(),
                    context=_request_context(
                        request.method,
                        _normalise_path(request.path),
                        url=getattr(request, "build_absolute_uri", lambda path=None: None)(request.path),
                        user_agent=request.META.get("HTTP_USER_AGENT"),
                        remote_addr=request.META.get("REMOTE_ADDR"),
                    ),
                    timestamp=_now(),
                    environment=client.environment,
                    release=client.release,
                    user=client._user_dict(),
                )
            client._batcher.add_error(error)
            raise

        ms = (time.time() - start) * 1000
        client = self.client
        if client._should_sample():
            route = getattr(getattr(request, "resolver_match", None), "route", None)
            span = f"{request.method} {route or _normalise_path(request.path)}"
            trace = TracePayload(
                span=span,
                ms=ms,
                status_code=response.status_code,
                status=_trace_status(response.status_code),  # type: ignore[arg-type]
                timestamp=_now(),
                environment=client.environment,
                release=client.release,
                meta=_request_context(
                    request.method,
                    _normalise_path(request.path),
                    url=getattr(request, "build_absolute_uri", lambda path=None: None)(request.path),
                    user_agent=request.META.get("HTTP_USER_AGENT"),
                    remote_addr=request.META.get("REMOTE_ADDR"),
                ),
                user=client._user_dict(),
            )
            client._batcher.add_trace(trace)
        return response


# ── WSGI middleware (framework-agnostic) ──────────────────────────────────────

class WatchupWSGI:
    """
    WSGI middleware wrapper — works with any WSGI framework.

    Example (Flask):
        app.wsgi_app = WatchupWSGI(app.wsgi_app, watchup)

    Example (bare WSGI):
        application = WatchupWSGI(application, watchup)
    """

    def __init__(self, wsgi_app: Callable, watchup_client: "Watchup") -> None:
        self._app = wsgi_app
        self._client = watchup_client

    def __call__(self, environ: Dict, start_response: Callable) -> Any:
        start = time.time()
        status_holder: list = []

        def _start_response(status: str, headers: Any, exc_info: Any = None) -> Any:
            status_holder.append(int(status.split(" ", 1)[0]))
            return start_response(status, headers, exc_info)

        try:
            result = self._app(environ, _start_response)
        except Exception as exc:
            ms = (time.time() - start) * 1000
            path = environ.get("PATH_INFO", "/")
            method = environ.get("REQUEST_METHOD", "GET")
            error = ErrorPayload(
                message=str(exc),
                level="error",
                route=f"{method} {_normalise_path(path)}",
                stack=traceback.format_exc(),
                context=_request_context(
                    method,
                    _normalise_path(path),
                    server_name=environ.get("SERVER_NAME"),
                    remote_addr=environ.get("REMOTE_ADDR"),
                    user_agent=environ.get("HTTP_USER_AGENT"),
                ),
                timestamp=_now(),
                environment=self._client.environment,
                release=self._client.release,
                user=self._client._user_dict(),
            )
            self._client._batcher.add_error(error)
            raise

        ms = (time.time() - start) * 1000
        status_code = status_holder[0] if status_holder else 200
        path = environ.get("PATH_INFO", "/")
        method = environ.get("REQUEST_METHOD", "GET")
        trace = TracePayload(
            span=f"{method} {_normalise_path(path)}",
            ms=ms,
            status_code=status_code,
            status=_trace_status(status_code),  # type: ignore[arg-type]
            timestamp=_now(),
            environment=self._client.environment,
            release=self._client.release,
            meta=_request_context(
                method,
                _normalise_path(path),
                server_name=environ.get("SERVER_NAME"),
                remote_addr=environ.get("REMOTE_ADDR"),
                user_agent=environ.get("HTTP_USER_AGENT"),
            ),
            user=self._client._user_dict(),
        )
        if self._client._should_sample():
            self._client._batcher.add_trace(trace)
        return result


class WatchupASGI:
    """ASGI middleware for FastAPI, Starlette, and other ASGI applications."""

    def __init__(self, app: Callable[..., Awaitable[Any]], watchup_client: "Watchup") -> None:
        self._app = app
        self._client = watchup_client

    async def __call__(self, scope: Dict[str, Any], receive: Callable, send: Callable) -> Any:
        if scope.get("type") != "http":
            return await self._app(scope, receive, send)

        start = time.perf_counter()
        method = str(scope.get("method") or "GET")
        path = str(scope.get("path") or "/")
        status_code = 500
        response_started = False

        async def send_with_status(message: Dict[str, Any]) -> None:
            nonlocal status_code, response_started
            if message.get("type") == "http.response.start":
                status_code = int(message.get("status", 500))
                response_started = True
            await send(message)

        try:
            result = await self._app(scope, receive, send_with_status)
        except Exception as exc:
            self._client.capture_error(
                exc,
                route=f"{method} {_normalise_path(path)}",
                method=method,
                path=_normalise_path(path),
                client_ip=(scope.get("client") or [None])[0],
            )
            raise
        finally:
            if response_started and self._client._should_sample():
                ms = (time.perf_counter() - start) * 1000
                self._client._batcher.add_trace(TracePayload(
                    span=f"{method} {_normalise_path(path)}",
                    ms=ms,
                    status_code=status_code,
                    status=_trace_status(status_code),  # type: ignore[arg-type]
                    timestamp=_now(),
                    environment=self._client.environment,
                    release=self._client.release,
                    meta=_request_context(
                        method,
                        _normalise_path(path),
                        client_ip=(scope.get("client") or [None])[0],
                    ),
                    user=self._client._user_dict(),
                ))
        return result
