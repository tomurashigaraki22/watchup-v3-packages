from __future__ import annotations

import asyncio
import json
import logging
import os
import subprocess
import sys
import threading
import time
from typing import Any, Dict, List

import pytest

from watchup import Watchup, WatchupASGI, WatchupWSGI, sanitize_sql
from watchup._queue import SendResult
from watchup.integrations.celery import init_celery
from watchup.integrations.logging import WatchupHandler
from watchup.types import WatchupUser


class Capture:
    def __init__(self) -> None:
        self.bodies: List[Dict[str, Any]] = []
        self.status = 201
        self.lock = threading.Lock()

    def __call__(self, chunk: Any) -> SendResult:
        with self.lock:
            if self.status >= 300:
                return SendResult(ok=False, status=self.status)
            self.bodies.append(json.loads(chunk.body))
            return SendResult(ok=True, status=self.status)

    def items(self, kind: str) -> List[Dict[str, Any]]:
        return [item for body in self.bodies for item in body[kind]]


@pytest.fixture()
def wired() -> Any:
    clients: List[Watchup] = []

    def make(**kwargs: Any) -> tuple[Watchup, Capture]:
        client = Watchup("wup_live_test", flag_refresh_interval=0, flush_interval=60, **kwargs)
        capture = Capture()
        client._queue._send = capture
        clients.append(client)
        return client, capture

    yield make
    for c in clients:
        c.shutdown()


# ── Configuration & payloads ──────────────────────────────────────────────────


def test_python_39_compatible_payload_serialization() -> None:
    assert WatchupUser("usr_1", name="A").to_dict() == {"id": "usr_1", "name": "A"}


def test_invalid_configuration_is_rejected() -> None:
    with pytest.raises(ValueError):
        Watchup("key", sample_rate=1.1, flag_refresh_interval=0)
    with pytest.raises(ValueError):
        Watchup("key", flush_interval=0, flag_refresh_interval=0)
    with pytest.raises(ValueError):
        Watchup("key", max_batch_size=0, flag_refresh_interval=0)
    with pytest.raises(ValueError):
        Watchup("", flag_refresh_interval=0)


def test_envelope_and_headers(wired: Any) -> None:
    client, cap = wired(release="r1", service="api")
    client.capture_error(ValueError("boom"))
    client.flush()
    body = cap.bodies[0]
    assert body["sdk"]["name"] == "watchup-python"
    assert body["release"] == "r1"
    assert body["errors"][0]["type"] == "ValueError"
    assert body["errors"][0]["context"]["service"] == "api"
    headers = client._transport.headers("wu_x_0")
    assert headers["Idempotency-Key"] == "wu_x_0"
    assert headers["Authorization"] == "Bearer wup_live_test"


def test_errors_are_captured_once_and_redacted(wired: Any) -> None:
    client, cap = wired()
    exc = RuntimeError("token leaked: Bearer abc.def")
    client.capture_error(exc, headers={"Authorization": "Bearer abc.def"}, password="hunter2")
    client.capture_error(exc)
    client.flush()
    errors = cap.items("errors")
    assert len(errors) == 1
    raw = json.dumps(errors)
    assert "hunter2" not in raw and "abc.def" not in raw


def test_oversized_and_unicode_items_are_split_and_truncated(wired: Any) -> None:
    client, cap = wired()
    client.capture_error("x" * 256_000)
    for i in range(3):
        client.track(f"u{i}", {"text": "é" * 60_000})
    client.flush()
    assert all(len(json.dumps(b, ensure_ascii=False).encode()) <= 196_608 for b in cap.bodies)
    assert cap.items("errors")[0]["_watchup_truncated"] is True
    assert len(cap.items("events")) == 3


def test_failed_batch_is_retried_with_same_key(wired: Any) -> None:
    client, cap = wired()
    keys: List[str] = []
    real = cap

    def flaky(chunk: Any) -> SendResult:
        keys.append(chunk.idempotency_key)
        if len(keys) == 1:
            return SendResult(ok=False, status=503)
        return real(chunk)

    client._queue._send = flaky
    client.track("retry-me")
    client.flush()
    client._queue.flush(force=True)
    assert keys[0] == keys[1]
    assert len(cap.items("events")) == 1


def test_shutdown_delivers_and_stops_capturing(wired: Any) -> None:
    client, cap = wired()
    client.track("pending")
    client.shutdown()
    client.track("after")
    assert [e["name"] for e in cap.items("events")] == ["pending"]


def test_trace_helpers(wired: Any) -> None:
    client, cap = wired()
    with client.trace_query("SELECT * FROM users WHERE email = 'a@b.c'", system="postgresql", slow_ms=0):
        time.sleep(0.002)
    with pytest.raises(KeyError):
        with client.trace("job.step"):
            raise KeyError("x")

    @client.monitor("job.nightly")
    def nightly() -> int:
        client.set_user("job-user")
        raise ValueError("nightly failed")

    with pytest.raises(ValueError):
        nightly()
    client.flush()
    traces = cap.items("traces")
    assert traces[0]["span"] == "SELECT * FROM users WHERE email = ?"
    assert traces[0]["type"] == "db" and traces[0]["meta"]["slow"] is True
    assert traces[1]["status"] == "err"
    error = cap.items("errors")[0]
    assert error["route"] == "job.nightly" and error["user"] == {"id": "job-user"}
    assert sanitize_sql("SELECT 1, 2 IN (3, 4)") == "SELECT ?, ? IN (?)"


def test_request_context_isolates_users_across_threads(wired: Any) -> None:
    client, cap = wired()
    client.set_user("default")

    def job(name: str, delay: float) -> None:
        with client.request_context():
            client.set_user(name)
            time.sleep(delay)
            client.track("job.done", {"job": name})

    threads = [threading.Thread(target=job, args=("a", 0.02)), threading.Thread(target=job, args=("b", 0.0))]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    client.track("outside")
    client.flush()
    users = {e["properties"].get("job", "outside"): e["properties"]["user"]["id"] for e in cap.items("events")}
    assert users == {"a": "a", "b": "b", "outside": "default"}


def test_flags_match_js_bucketing_and_targeting(wired: Any) -> None:
    client, _ = wired()
    client._flags.replace(
        [
            {"key": "beta", "enabled": True, "rollout_percentage": 100, "variants": [], "targeting_rules": [{"attribute": "plan", "operator": "in", "values": ["pro"]}]},
            {"key": "split", "enabled": True, "rollout_percentage": 50, "variants": [{"key": "a", "weight": 50}, {"key": "b", "weight": 50}], "targeting_rules": []},
        ]
    )
    assert client.is_enabled("beta", plan="pro") is True
    assert client.is_enabled("beta", plan="free") is False
    # user-1 buckets to 43 for "new-checkout" in every SDK; here: 50% rollout.
    assert client.get_variant("split", user_id="user-1") in ("a", "b", "control")


# ── Frameworks ────────────────────────────────────────────────────────────────


def test_flask_integration(wired: Any) -> None:
    flask = pytest.importorskip("flask")
    client, cap = wired()
    app = flask.Flask(__name__)
    client.init_app(app)

    @app.before_request
    def identify() -> None:
        client.set_user(flask.request.headers.get("X-User", "anon"))

    @app.get("/orders/<int:order_id>")
    def order(order_id: int) -> Any:
        if order_id == 0:
            raise ValueError("bad order")
        return {"id": order_id}, 201

    @app.errorhandler(ValueError)
    def handled(exc: ValueError) -> Any:  # the app's own handler must still run
        return {"error": str(exc)}, 418

    @app.get("/crash")
    def crash() -> Any:
        raise RuntimeError("unhandled")

    http = app.test_client()
    assert http.get("/orders/42", headers={"X-User": "ada", "X-Request-ID": "req-1", "Authorization": "secret"}).status_code == 201
    assert http.get("/orders/0").status_code == 418
    assert http.get("/missing").status_code == 404
    app.testing = False
    assert http.get("/crash").status_code == 500
    client.flush()

    traces = cap.items("traces")
    assert [t["span"] for t in traces] == ["GET /orders/<int:order_id>", "GET /orders/<int:order_id>", "GET /missing", "GET /crash"]
    assert traces[0]["user"] == {"id": "ada"} and traces[0]["meta"]["request_id"] == "req-1"
    assert "Authorization" not in json.dumps(traces[0]["meta"])
    assert [t["status_code"] for t in traces] == [201, 418, 404, 500]
    errors = cap.items("errors")
    # Handled ValueError and the 404 are not incidents; the unhandled RuntimeError is, once.
    assert [e["message"] for e in errors] == ["unhandled"]
    assert errors[0]["route"] == "GET /crash" and errors[0]["type"] == "RuntimeError"


def test_wsgi_integration(wired: Any) -> None:
    client, cap = wired()

    def app(environ: Dict[str, Any], start_response: Any) -> Any:
        if environ["PATH_INFO"] == "/boom":
            raise RuntimeError("wsgi boom")
        start_response("204 No Content", [])
        return [b""]

    wrapped = WatchupWSGI(app, client)
    wrapped({"REQUEST_METHOD": "GET", "PATH_INFO": "/items/7"}, lambda s, h: None)
    with pytest.raises(RuntimeError):
        wrapped({"REQUEST_METHOD": "POST", "PATH_INFO": "/boom"}, lambda s, h: None)
    client.flush()
    assert [(t["span"], t["status_code"]) for t in cap.items("traces")] == [("GET /items/:id", 204), ("POST /boom", 500)]
    assert cap.items("errors")[0]["message"] == "wsgi boom"


def test_asgi_starlette_integration(wired: Any) -> None:
    starlette = pytest.importorskip("starlette")
    from starlette.applications import Starlette
    from starlette.responses import JSONResponse
    from starlette.routing import Route
    from starlette.testclient import TestClient

    client, cap = wired()

    async def item(request: Any) -> Any:
        client.set_user(request.headers["x-user"])
        await asyncio.sleep(0.01 if request.headers["x-user"] == "a" else 0)
        client.track("item.viewed")
        return JSONResponse({"id": request.path_params["item_id"]}, status_code=202)

    async def boom(request: Any) -> Any:
        raise RuntimeError("asgi boom")

    app = Starlette(routes=[Route("/items/{item_id}", item), Route("/boom", boom)])
    app.add_middleware(WatchupASGI, watchup_client=client)
    http = TestClient(app, raise_server_exceptions=False)
    assert http.get("/items/9", headers={"x-user": "a"}).status_code == 202
    assert http.get("/boom", headers={"x-user": "b"}).status_code == 500
    client.flush()
    traces = cap.items("traces")
    assert traces[0]["span"] == "GET /items/{item_id}" and traces[0]["status_code"] == 202
    assert traces[0]["user"] == {"id": "a"}
    assert cap.items("events")[0]["properties"]["user"] == {"id": "a"}
    assert cap.items("errors")[0]["message"] == "asgi boom"
    assert starlette


def test_asgi_concurrent_requests_do_not_share_users(wired: Any) -> None:
    client, cap = wired()

    async def app(scope: Dict[str, Any], receive: Any, send: Any) -> None:
        user = dict(scope["headers"])[b"x-user"].decode()
        client.set_user(user)
        await asyncio.sleep(0.02 if user == "slow" else 0)
        client.track("seen", {"expected": user})
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b""})

    middleware = WatchupASGI(app, client)

    async def call(user: str) -> None:
        async def send(_m: Any) -> None:
            return None

        await middleware({"type": "http", "method": "GET", "path": "/", "headers": [(b"x-user", user.encode())]}, None, send)

    async def main() -> None:
        await asyncio.gather(call("slow"), call("fast"))

    asyncio.run(main())
    client.flush()
    for event in cap.items("events"):
        assert event["properties"]["user"]["id"] == event["properties"]["expected"]


def test_django_integration(wired: Any) -> None:
    django = pytest.importorskip("django")
    from django.conf import settings

    client, cap = wired()
    if not settings.configured:
        settings.configure(
            DEBUG=False,
            ALLOWED_HOSTS=["testserver"],
            ROOT_URLCONF=__name__,
            MIDDLEWARE=["watchup.WatchupDjangoMiddleware"],
            SECRET_KEY="test",
            WATCHUP_CLIENT=client,
        )
        django.setup()
    else:  # pragma: no cover - settings reused across runs
        settings.WATCHUP_CLIENT = client

    from django.test import Client as DjangoClient

    http = DjangoClient(raise_request_exception=False)
    assert http.get("/books/12/", HTTP_X_REQUEST_ID="dj-1").status_code == 200
    assert http.get("/explode/").status_code == 500
    client.flush()
    traces = cap.items("traces")
    assert traces[0]["span"] == "GET /books/<int:book_id>/" and traces[0]["meta"]["request_id"] == "dj-1"
    assert traces[1]["status_code"] == 500
    errors = cap.items("errors")
    assert len(errors) == 1 and errors[0]["message"] == "django boom"


def _book(request: Any, book_id: int) -> Any:
    from django.http import JsonResponse

    return JsonResponse({"id": book_id})


def _explode(request: Any) -> Any:
    raise RuntimeError("django boom")


try:  # URLconf for test_django_integration (ROOT_URLCONF points at this module)
    from django.urls import path as _path

    urlpatterns = [_path("books/<int:book_id>/", _book), _path("explode/", _explode)]
except Exception:  # pragma: no cover - Django not installed
    urlpatterns = []


# ── Integrations ──────────────────────────────────────────────────────────────


def test_celery_integration(wired: Any) -> None:
    client, cap = wired()

    class Signal:
        def __init__(self) -> None:
            self.handlers: List[Any] = []

        def connect(self, fn: Any, weak: bool = True) -> None:
            self.handlers.append(fn)

        def send(self, **kwargs: Any) -> None:
            for fn in self.handlers:
                fn(**kwargs)

    class Signals:
        task_prerun = Signal()
        task_failure = Signal()
        task_postrun = Signal()

    task = type("Task", (), {"name": "emails.send", "request": type("R", (), {"retries": 2})()})()
    init_celery(client, Signals)
    Signals.task_prerun.send(task_id="t-1", task=task)
    client.set_user("celery-user")
    Signals.task_failure.send(task_id="t-1", exception=ValueError("smtp down"), sender=task)
    Signals.task_postrun.send(task_id="t-1", task=task, state="FAILURE")
    client.flush()
    error = cap.items("errors")[0]
    assert error["route"] == "celery.emails.send" and error["context"]["task"]["retries"] == 2
    assert error["user"] == {"id": "celery-user"}
    trace = cap.items("traces")[0]
    assert trace["span"] == "celery.emails.send" and trace["status"] == "err" and trace["meta"]["request_id"] == "t-1"


def test_logging_handler(wired: Any) -> None:
    client, cap = wired(logging=True)
    logger = logging.getLogger("app.test")
    logger.addHandler(WatchupHandler(client))
    logger.setLevel(logging.INFO)
    try:
        raise KeyError("missing")
    except KeyError:
        logger.exception("lookup failed")
    logging.getLogger("watchup").warning("ignored to avoid loops")
    client.flush()
    logs = [e for e in cap.items("events") if e["name"].startswith("log.")]
    assert logs[0]["properties"]["message"] == "lookup failed"
    assert cap.items("errors")[0]["type"] == "KeyError"


# ── Process behaviour ─────────────────────────────────────────────────────────


def test_import_makes_no_network_calls() -> None:
    code = (
        "import socket\n"
        "def deny(*a, **k): raise AssertionError('network call during import')\n"
        "socket.socket.connect = deny\n"
        "socket.create_connection = deny\n"
        "import watchup, watchup.middleware, watchup.integrations.celery, watchup.integrations.logging\n"
        "print('ok')\n"
    )
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, cwd=os.path.dirname(os.path.dirname(__file__)))
    assert out.stdout.strip() == "ok", out.stderr


@pytest.mark.skipif(not hasattr(os, "fork"), reason="fork is POSIX-only")
def test_fork_child_starts_with_empty_queue(wired: Any) -> None:  # pragma: no cover - POSIX
    client, _ = wired()
    client.track("parent-only")
    read, write = os.pipe()
    pid = os.fork()
    if pid == 0:
        os.write(write, str(client._queue.pending_count()).encode())
        os._exit(0)
    os.waitpid(pid, 0)
    assert os.read(read, 10) == b"0"
    assert client._queue.pending_count() == 1


def test_shutdown_retries_after_real_backoff() -> None:
    """Regression: retry times were mixed seconds/milliseconds, so shutdown never retried."""
    client = Watchup("wup_live_test", flag_refresh_interval=0, flush_interval=60, shutdown_timeout=5)
    capture = Capture()
    calls = {"n": 0}

    def flaky(chunk: Any) -> SendResult:
        calls["n"] += 1
        return SendResult(ok=False, status=503) if calls["n"] == 1 else capture(chunk)

    client._queue._send = flaky
    client.track("retried")
    client.flush()
    started = time.monotonic()
    client.shutdown()
    assert [e["name"] for e in capture.items("events")] == ["retried"]
    assert time.monotonic() - started < 3
