# watchup

Official Python SDK for [Watchup](https://watchup.site): error tracking, request tracing, custom events, structured logs, database spans and feature flags.

Works with **Flask**, **Django**, **FastAPI/Starlette** (ASGI), any **WSGI** app, **Celery** and the standard `logging` module. No required dependencies — standard library only. Python **3.9–3.13**. Typed (`py.typed`).

## Install

```bash
pip install watchup
```

## Quick start (Flask)

<!-- example: examples/python_flask.py -->
```python
"""Flask quick start for the watchup Python SDK.

Run: WATCHUP_API_KEY=wup_live_xxx python examples/python_flask.py
"""

import os

from flask import Flask, request

from watchup import Watchup

watchup = Watchup(
    api_key=os.environ["WATCHUP_API_KEY"],
    base_url=os.environ.get("WATCHUP_BASE_URL", "https://api.watchup.site"),  # omit in production
    environment=os.environ.get("APP_ENV", "production"),
    release=os.environ.get("GIT_SHA"),
    service="orders-api",
)

app = Flask(__name__)
watchup.init_app(app)  # request traces, error capture, per-request context


@app.before_request
def identify() -> None:
    user_id = request.headers.get("X-User-ID")
    if user_id:
        watchup.set_user(user_id)  # request-scoped


@app.get("/orders/<int:order_id>")
def get_order(order_id: int) -> dict:
    with watchup.trace_query("SELECT * FROM orders WHERE id = %s", system="postgresql"):
        order = {"id": order_id}
    watchup.track("order.viewed", {"order_id": order_id})
    return order


@app.get("/fail")
def fail() -> str:
    raise RuntimeError("Something broke")


if __name__ == "__main__":
    # Demo traffic, then a graceful shutdown that flushes everything.
    client = app.test_client()
    client.get("/orders/42", headers={"X-User-ID": "user-1"})
    client.get("/fail")
    watchup.shutdown()
```

This example runs in CI against a mock ingest server. `init_app` records one trace per request (using the URL rule, e.g. `GET /orders/<int:order_id>`), reports unhandled exceptions through Flask's `got_request_exception` signal — so `404`s and your own error handlers are untouched — and gives every request its own context.

## Django

```python
# settings.py
MIDDLEWARE = ["watchup.WatchupDjangoMiddleware", ...]
WATCHUP_API_KEY = "wup_live_xxxxxxxxxxxx"
WATCHUP_ENVIRONMENT = "production"  # optional
WATCHUP_RELEASE = "v1.2.3"          # optional
WATCHUP_SERVICE = "web"             # optional
# or: WATCHUP_CLIENT = Watchup(...)  to reuse an existing client
```

Traces use the resolver route (`GET /books/<int:book_id>/`); view exceptions are reported through `process_exception`, and Django's own error handling is unchanged. One client is shared per process.

## FastAPI / Starlette

```python
from fastapi import FastAPI
from watchup import Watchup, WatchupASGI

watchup = Watchup(api_key=os.environ["WATCHUP_API_KEY"])
app = FastAPI()
app.add_middleware(WatchupASGI, watchup_client=watchup)
```

Traces use the route template (`GET /items/{item_id}`); each request (and asyncio task) has its own context.

## WSGI, Celery and logging

```python
from watchup import WatchupWSGI
application = WatchupWSGI(application, watchup)

from watchup.integrations.celery import init_celery
init_celery(watchup)  # one trace per task, failures reported once, per-task context

import logging
from watchup.integrations.logging import WatchupHandler
logging.getLogger().addHandler(WatchupHandler(watchup))  # needs Watchup(logging=True)
```

## Manual instrumentation

```python
watchup.capture_error(exc, route="job.process_order", order_id=order_id)  # each exception once
watchup.track("user.signed_up", {"plan": "pro"})
watchup.capture_log("Invoice retry scheduled", level="info", invoice_id=invoice_id)  # Watchup(logging=True)

with watchup.trace("job.generate_report"):
    generate_report()

with watchup.trace_query("SELECT * FROM users WHERE email = %s", system="postgresql"):
    cursor.execute(sql, (email,))  # literals become ?, parameters are never recorded

@watchup.monitor("job.nightly_cleanup")  # own context + trace + error capture
def nightly_cleanup(): ...

with watchup.request_context(route="job.send_email"):
    watchup.set_user(job.user_id)  # scoped to this block
```

`set_user()` inside a request (or `request_context()`) applies to that request only; outside, it sets the default user.

## Configuration

| Parameter | Default | Description |
| --- | --- | --- |
| `api_key` | *(required)* | Secret project key (`wup_live_…`). |
| `base_url` | `https://api.watchup.site` | Self-hosted API URL. |
| `environment` | `WATCHUP_ENV` / `WATCHUP_ENVIRONMENT`, then `"production"` | Label on every item. |
| `release` / `service` | `None` | Deploy and service labels. |
| `flush_interval` | `5.0` | Seconds between background flushes. |
| `max_batch_size` / `max_queue_size` | `100` / `1000` | Items per request / items kept while the API is unreachable. |
| `sample_rate` | `1.0` | Fraction of requests traced; errors are always captured. |
| `logging` / `log_level` | `False` / `"debug"` | Opt-in structured logs. |
| `redact_keys` | `None` | Extra keys to redact. |
| `on_diagnostic` | `None` | Delivery diagnostics callback (never captured data). |
| `flag_refresh_interval` | `30.0` | Feature-flag refresh in seconds; `0` turns flags off. |
| `shutdown_timeout` / `timeout` | `5.0` / `8.0` | Shutdown and per-request timeouts in seconds. |
| `debug` | `False` | Log diagnostics through the `watchup` logger. |

## Delivery and lifecycle

- Items are redacted and serialized when captured; requests stay under 192 KiB and 100 items, and oversized items are truncated rather than dropped.
- Every request has an `Idempotency-Key`; failures are retried with the same key (backoff with jitter, `Retry-After` honoured).
- Sending happens on a daemon thread, never on your request thread. `flush()` is synchronous: when it returns, everything queued before the call has been attempted. `shutdown()` waits up to `shutdown_timeout` and also runs at interpreter exit.
- Fork-safe: a forked worker starts with an empty queue (the parent sends what it had queued).
- Importing `watchup` makes no network calls.

## Links

- [Python SDK docs](https://watchup.site/docs/sdks/python) · [Changelog](./CHANGELOG.md) · [Transport contract](../spec/README.md)

## License

MIT © Watchup Ltd
