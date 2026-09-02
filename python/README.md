# watchup

Official Python SDK for [Watchup](https://watchup.site) — error tracking, request tracing, and custom analytics for Python web applications.

Works with **Flask**, **Django**, **FastAPI/Starlette**, and any **WSGI** framework. Zero required dependencies — uses the Python standard library only.

---

## Installation

```bash
pip install watchup
```

Requires Python 3.9+.

---

## Quick start

```python
from watchup import Watchup

watchup = Watchup(
    api_key="wup_live_xxxxxxxxxxxx",   # Dashboard → Project Settings → API Keys
    environment="production",
    release="v1.2.3",                  # optional: git SHA or version tag
)
```

---

## Flask

```python
from flask import Flask
from watchup import Watchup

watchup = Watchup(api_key="wup_live_xxxxxxxxxxxx")
app = Flask(__name__)

watchup.init_app(app)   # registers before_request, after_request, errorhandler hooks
```

`init_app` wires up:

- **Request tracing** — every request is recorded with method, route, status code, and duration
- **Error capture** — unhandled exceptions are reported with stack trace and request context
- **Transparent re-raise** — errors still propagate to your own error handlers

---

## Django

Add `WatchupDjangoMiddleware` to your `MIDDLEWARE` list and set `WATCHUP_API_KEY` in `settings.py`:

```python
# settings.py
MIDDLEWARE = [
    "watchup.WatchupDjangoMiddleware",
    # ... rest of your middleware
]

WATCHUP_API_KEY     = "wup_live_xxxxxxxxxxxx"
WATCHUP_ENVIRONMENT = "production"  # optional
WATCHUP_RELEASE     = "v1.2.3"     # optional
```

The middleware creates one client when Django constructs the middleware and reuses it for the lifetime of that middleware instance.

---

## FastAPI / Starlette

Use the built-in ASGI middleware. It records method, normalized path, status code, duration, and safe request metadata:

```python
import os
from fastapi import FastAPI
from watchup import Watchup, WatchupASGI

watchup = Watchup(api_key=os.environ["WATCHUP_API_KEY"])
app = FastAPI()
app.add_middleware(WatchupASGI, watchup_client=watchup)
```

The middleware captures exceptions as errors and re-raises them. Do not add a second HTTP middleware that calls `start_trace()` for the same request, or the request will be recorded twice.

---

## WSGI middleware (framework-agnostic)

```python
import os

from watchup import Watchup, WatchupWSGI

watchup = Watchup(api_key="wup_live_xxxxxxxxxxxx")

# Flask example
from flask import Flask
flask_app = Flask(__name__)
flask_app.wsgi_app = WatchupWSGI(flask_app.wsgi_app, watchup)

# Any WSGI app
application = WatchupWSGI(application, watchup)
```

---

## Manual tracking

### Capture an error

```python
try:
    process_order(order_id)
except Exception as exc:
    watchup.capture_error(exc, route="job.process_order", order_id=order_id)
```

### Track a custom event

```python
watchup.track("user.signed_up", {"plan": "pro", "source": "invite"})
watchup.track("order.placed", {"amount": 4999, "currency": "NGN"})
```

### Capture structured logs

Log streaming is opt-in. Captured logs appear in **Live logs** as `log.<level>` events and use the same background batching as events, traces, and errors.

```python
watchup = Watchup(
    api_key="wup_live_xxxxxxxxxxxx",
    logging=True,
    log_level="info",
)

watchup.capture_log(
    "Invoice retry scheduled",
    level="info",
    route="job.invoice_retry",
    invoice_id=invoice_id,
    retry_attempt=retry_attempt,
)
```

Valid levels are `debug`, `info`, `warning`, `error`, and `critical`. Do not put passwords, tokens, payment data, or raw request headers in log context.

### Time an operation

```python
end = watchup.start_trace("db.query_users")
try:
    rows = db.query("SELECT * FROM users")
    end()                       # status defaults to "ok"
except Exception as exc:
    end(status="err", meta={"query": "SELECT * FROM users"})
    raise
```

---

## User identification

Attach user identity to errors and traces:

```python
# After authentication — in a middleware or login view
watchup.set_user("usr_42", email="alice@example.com", name="Alice", plan="pro")

# On logout
watchup.clear_user()
```

Once set, every `capture_error`, `start_trace`, and request trace will include the user context.

---

## Configuration reference

| Parameter | Default | Description |
|---|---|---|
| `api_key` | *(required)* | Project API key (`wup_live_…`) |
| `base_url` | `https://api.watchup.site` | Override for self-hosted deployments |
| `environment` | `WATCHUP_ENV` env var, or `"production"` | Runtime label on every payload |
| `release` | `None` | App version / git SHA |
| `flush_interval` | `5.0` | Seconds between automatic flushes |
| `max_batch_size` | `100` | Item count that triggers an immediate flush |
| `sample_rate` | `1.0` | Fraction of requests to trace (0–1). Errors are always captured. |
| `debug` | `False` | Log SDK warnings to stderr |
| `logging` | `False` | Enable structured server log capture |
| `log_level` | `"debug"` | Lowest log level to capture |

Request tracing honors `sample_rate`; errors are captured regardless of the trace sample. Automatically captured request metadata includes the method, normalized path, base URL, user agent, and remote address. Authorization headers, cookies, query strings, and request bodies are never copied into telemetry.

---

## Lifecycle

```python
# Force an immediate flush
watchup.flush()

# Stop the background timer and flush remaining items (graceful shutdown)
watchup.shutdown()
```

The batcher runs on a daemon thread, retries a failed batch on the next flush, and registers an `atexit` handler. Call `shutdown()` from your process or worker shutdown hook when you need a deterministic final flush.

---

## Links

- **Website:** [watchup.site](https://watchup.site)
- **Documentation:** [watchup.site/docs](https://watchup.site/docs)
- **Python SDK docs:** [watchup.site/docs/sdks/python](https://watchup.site/docs/sdks/python)
- **Getting started:** [watchup.site/docs/getting-started](https://watchup.site/docs/getting-started)
- **Pricing:** [watchup.site/pricing](https://watchup.site/pricing)
- **Dashboard:** [app.watchup.site](https://watchup.site/login)

---

## License

MIT © Watchup Ltd
