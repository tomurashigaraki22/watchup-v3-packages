"""
watchup · framework integrations

Flask
-----
    watchup = Watchup(api_key="wup_live_...")
    watchup.init_app(app)

Django
------
    # settings.py
    MIDDLEWARE = ["watchup.WatchupDjangoMiddleware", ...]
    WATCHUP_API_KEY = "wup_live_..."

ASGI (FastAPI / Starlette)
--------------------------
    app.add_middleware(WatchupASGI, watchup_client=watchup)

WSGI (any framework)
--------------------
    app.wsgi_app = WatchupWSGI(app.wsgi_app, watchup)

Every integration opens a per-request context (request ID, user), records one
trace with the route template and real status code, reports unhandled
exceptions once, and leaves the framework's own error handling unchanged.
"""

from __future__ import annotations

import os
import re
import threading
import time
from typing import TYPE_CHECKING, Any, Awaitable, Callable, Dict, Iterable, List, Optional

from .context import RequestContext, _current, safe_request_id, trace_id_from

if TYPE_CHECKING:
    from .client import Watchup

_UUID = re.compile(r"/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=/|$)", re.IGNORECASE)
_HEX = re.compile(r"/[0-9a-f]{24,64}(?=/|$)", re.IGNORECASE)
_NUM = re.compile(r"/\d+(?=/|$)")
_SAFE_HEADERS = ("Accept", "Content-Type", "Origin", "Referer", "User-Agent", "X-Request-ID", "X-Correlation-ID")


def _normalise_path(path: str) -> str:
    path = path.split("?", 1)[0] or "/"
    path = _UUID.sub("/:id", path)
    path = _HEX.sub("/:id", path)
    path = _NUM.sub("/:id", path)
    return path.rstrip("/") or "/"


def _trace_status(status_code: int) -> str:
    if status_code >= 500:
        return "err"
    if status_code >= 400:
        return "warn"
    return "ok"


def _request_context(method: str, path: str, **extra: Any) -> Dict[str, Any]:
    """Safe request metadata: never authorization headers, cookies or bodies."""
    context: Dict[str, Any] = {"method": method, "path": path}
    context.update({key: value for key, value in extra.items() if value is not None})
    return context


def _new_context(method: str, headers_get: Callable[[str], Any]) -> RequestContext:
    ctx = RequestContext(method=method.upper())
    rid = safe_request_id(headers_get("X-Request-ID"))
    if rid:
        ctx.request_id = rid
    ctx.trace_id = trace_id_from(headers_get("traceparent"))
    return ctx


def _record(client: Watchup, ctx: RequestContext, span: str, ms: float, status_code: int, meta: Dict[str, Any]) -> None:
    from .client import _now
    from .types import TracePayload

    if not client._should_sample():
        return
    merged = dict(meta)
    merged.update(client._base_context_for(ctx))
    client._queue.enqueue(
        "traces",
        TracePayload(
            span=span,
            ms=ms,
            status_code=status_code,
            status=_trace_status(status_code),  # type: ignore[arg-type]
            timestamp=_now(),
            environment=client.environment,
            release=client.release,
            meta=merged,
            user=ctx.user if ctx.user is not None else (client._user.to_dict() if client._user else None),
            trace_type="http",
        ).to_dict(),
    )


# ── Flask ─────────────────────────────────────────────────────────────────────


def _flask_request_context(request: Any, path: str) -> Dict[str, Any]:
    headers = {name: request.headers.get(name) for name in _SAFE_HEADERS if request.headers.get(name)}
    return {
        "request": _request_context(
            request.method,
            path,
            url=request.base_url,
            user_agent=request.headers.get("User-Agent"),
            remote_addr=request.remote_addr,
            headers=headers,
        )
    }


def _flask_init_app(watchup_client: Watchup, app: Any) -> None:
    """Register request hooks and the got_request_exception signal on a Flask app."""
    try:
        from flask import g, got_request_exception, request
    except ImportError as exc:
        raise ImportError("Flask is not installed. Run: pip install flask") from exc

    def span_of() -> str:
        rule = getattr(request, "url_rule", None)
        return f"{request.method} {rule.rule if rule is not None else _normalise_path(request.path)}"

    @app.before_request
    def _before() -> None:
        ctx = _new_context(request.method, request.headers.get)
        g._watchup_ctx = ctx
        g._watchup_token = _current.set(ctx)
        g._watchup_start = time.perf_counter()
        g._watchup_recorded = False

    def finish(status_code: int) -> None:
        start = getattr(g, "_watchup_start", None)
        ctx: Optional[RequestContext] = getattr(g, "_watchup_ctx", None)
        if start is None or ctx is None or getattr(g, "_watchup_recorded", True):
            return
        g._watchup_recorded = True
        span = span_of()
        ctx.route = span
        path = _normalise_path(request.path)
        _record(
            watchup_client,
            ctx,
            span,
            (time.perf_counter() - start) * 1000,
            status_code,
            _flask_request_context(request, path)["request"],
        )

    @app.after_request
    def _after(response: Any) -> Any:
        finish(response.status_code)
        return response

    @app.teardown_request
    def _teardown(exc: Optional[BaseException]) -> None:
        # after_request is skipped when a view raises; record the 500 here.
        if exc is not None:
            finish(500)
        token = getattr(g, "_watchup_token", None)
        if token is not None:
            try:
                _current.reset(token)
            except ValueError:
                pass
            g._watchup_token = None

    def _on_exception(sender: Any, exception: BaseException, **_extra: Any) -> None:
        path = _normalise_path(request.path)
        ctx = getattr(g, "_watchup_ctx", None)
        if ctx is not None:
            ctx.route = span_of()
        watchup_client.capture_error(exception, route=span_of(), **_flask_request_context(request, path))

    # A signal (not an errorhandler) so the app's own error handlers and
    # HTTPExceptions such as 404 are left completely alone.
    got_request_exception.connect(_on_exception, app, weak=False)


# ── Django ────────────────────────────────────────────────────────────────────

_django_client: Optional[Watchup] = None
_django_lock = threading.Lock()


def _django_watchup() -> Watchup:
    global _django_client
    from django.conf import settings as django_settings

    configured = getattr(django_settings, "WATCHUP_CLIENT", None)
    if configured is not None:
        return configured  # type: ignore[no-any-return]
    with _django_lock:
        if _django_client is None:
            from .client import Watchup

            _django_client = Watchup(
                api_key=getattr(django_settings, "WATCHUP_API_KEY", None) or os.environ.get("WATCHUP_API_KEY", ""),
                environment=getattr(django_settings, "WATCHUP_ENVIRONMENT", None) or os.environ.get("WATCHUP_ENVIRONMENT"),
                release=getattr(django_settings, "WATCHUP_RELEASE", None),
                service=getattr(django_settings, "WATCHUP_SERVICE", None),
            )
        return _django_client


class WatchupDjangoMiddleware:
    """
    Django middleware. Add ``"watchup.WatchupDjangoMiddleware"`` to MIDDLEWARE and
    set ``WATCHUP_API_KEY`` (or ``WATCHUP_CLIENT`` to an existing ``Watchup``).
    One client is shared per process.
    """

    def __init__(self, get_response: Callable[[Any], Any]) -> None:
        self.get_response = get_response
        self.client = _django_watchup()

    def _context(self, request: Any) -> Dict[str, Any]:
        path = _normalise_path(request.path)
        return _request_context(
            request.method,
            path,
            url=request.build_absolute_uri(request.path) if hasattr(request, "build_absolute_uri") else None,
            user_agent=request.META.get("HTTP_USER_AGENT"),
            remote_addr=request.META.get("REMOTE_ADDR"),
        )

    def _span(self, request: Any) -> str:
        route = getattr(getattr(request, "resolver_match", None), "route", None)
        return f"{request.method} {'/' + route.lstrip('/') if route else _normalise_path(request.path)}"

    def __call__(self, request: Any) -> Any:
        ctx = _new_context(request.method, lambda name: request.META.get("HTTP_" + name.upper().replace("-", "_")))
        request.watchup_context = ctx
        token = _current.set(ctx)
        start = time.perf_counter()
        try:
            response = self.get_response(request)
        except Exception as exc:  # only reached when no Django handler converted it
            ctx.route = self._span(request)
            self.client.capture_error(exc, route=ctx.route, request=self._context(request))
            raise
        finally:
            _current.reset(token)
        ctx.route = self._span(request)
        _record(self.client, ctx, ctx.route, (time.perf_counter() - start) * 1000, response.status_code, self._context(request))
        return response

    def process_exception(self, request: Any, exception: Exception) -> None:
        """Called by Django for view exceptions; returning None keeps Django's handling."""
        ctx: Optional[RequestContext] = getattr(request, "watchup_context", None)
        route = self._span(request)
        if ctx is not None:
            ctx.route = route
            token = _current.set(ctx)
            try:
                self.client.capture_error(exception, route=route, request=self._context(request))
            finally:
                _current.reset(token)
        else:
            self.client.capture_error(exception, route=route, request=self._context(request))
        return None


# ── WSGI ──────────────────────────────────────────────────────────────────────


class WatchupWSGI:
    """
    WSGI middleware — works with any WSGI framework.

        app.wsgi_app = WatchupWSGI(app.wsgi_app, watchup)
    """

    def __init__(self, wsgi_app: Callable[..., Any], watchup_client: Watchup) -> None:
        self._app = wsgi_app
        self._client = watchup_client

    def __call__(self, environ: Dict[str, Any], start_response: Callable[..., Any]) -> Iterable[bytes]:
        method = environ.get("REQUEST_METHOD", "GET")
        path = environ.get("PATH_INFO", "/")
        ctx = _new_context(method, lambda name: environ.get("HTTP_" + name.upper().replace("-", "_")))
        ctx.route = f"{method} {_normalise_path(path)}"
        meta = _request_context(
            method,
            _normalise_path(path),
            server_name=environ.get("SERVER_NAME"),
            remote_addr=environ.get("REMOTE_ADDR"),
            user_agent=environ.get("HTTP_USER_AGENT"),
        )
        status_holder: List[int] = []
        start = time.perf_counter()

        def _start_response(status: str, headers: Any, exc_info: Any = None) -> Any:
            status_holder.append(int(status.split(" ", 1)[0]))
            return start_response(status, headers, exc_info) if exc_info is not None else start_response(status, headers)

        token = _current.set(ctx)
        try:
            result = self._app(environ, _start_response)
        except Exception as exc:
            self._client.capture_error(exc, route=ctx.route, request=meta)
            _record(self._client, ctx, ctx.route, (time.perf_counter() - start) * 1000, 500, meta)
            raise
        finally:
            _current.reset(token)

        _record(self._client, ctx, ctx.route, (time.perf_counter() - start) * 1000, status_holder[0] if status_holder else 200, meta)
        return result  # type: ignore[no-any-return]


# ── ASGI ──────────────────────────────────────────────────────────────────────


class WatchupASGI:
    """ASGI middleware for FastAPI, Starlette and other ASGI apps (HTTP only)."""

    def __init__(self, app: Callable[..., Awaitable[Any]], watchup_client: Watchup) -> None:
        self._app = app
        self._client = watchup_client

    async def __call__(self, scope: Dict[str, Any], receive: Callable[..., Any], send: Callable[..., Any]) -> Any:
        if scope.get("type") != "http":
            return await self._app(scope, receive, send)

        method = str(scope.get("method") or "GET")
        path = str(scope.get("path") or "/")
        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers") or []}
        ctx = _new_context(method, lambda name: headers.get(name.lower()))
        status_code = 500
        response_started = False
        start = time.perf_counter()

        async def send_with_status(message: Dict[str, Any]) -> None:
            nonlocal status_code, response_started
            if message.get("type") == "http.response.start":
                status_code = int(message.get("status", 500))
                response_started = True
            await send(message)

        def span() -> str:
            # Starlette/FastAPI put the matched route on the scope after routing.
            route = scope.get("route")
            template = getattr(route, "path", None)
            return f"{method} {template or _normalise_path(path)}"

        token = _current.set(ctx)
        try:
            return await self._app(scope, receive, send_with_status)
        except Exception as exc:
            ctx.route = span()
            self._client.capture_error(
                exc,
                route=ctx.route,
                request=_request_context(method, _normalise_path(path), client_ip=(scope.get("client") or [None])[0]),
            )
            raise
        finally:
            ctx.route = span()
            _record(
                self._client,
                ctx,
                ctx.route,
                (time.perf_counter() - start) * 1000,
                status_code if response_started else 500,
                _request_context(method, _normalise_path(path)),
            )
            _current.reset(token)


__all__ = ["WatchupASGI", "WatchupDjangoMiddleware", "WatchupWSGI", "_normalise_path"]

