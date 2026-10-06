# Changelog — watchup (Python)

## 2.1.0

### Added
- Shared transport contract: byte-aware chunking (≤192 KiB, ≤100 items), truncation, redaction, an `Idempotency-Key` per chunk, retries with backoff and jitter.
- `contextvars` request context: `set_user()` inside a request (Flask, Django, ASGI, WSGI, Celery) applies to that request only; `request_context()` for jobs.
- Celery integration (`watchup.integrations.celery.init_celery`) and a `logging` handler (`watchup.integrations.logging.WatchupHandler`).
- `trace()` / `trace_query()` context managers, `monitor()` decorator, `sanitize_sql()`.
- Options: `service`, `max_queue_size`, `redact_keys`, `on_diagnostic`, `flag_refresh_interval`, `shutdown_timeout`, `timeout`.
- Fork safety: a forked child starts with an empty queue and fresh locks.
- Typed package (`py.typed`), `mypy --strict` clean.

### Fixed
- The Flask integration registered `errorhandler(Exception)`, which captured 404s and replaced the app's own handlers; it now listens to `got_request_exception`.
- Flask requests that raised had no trace; traces now use the URL rule (`/orders/<int:id>`) as the route.
- Django view exceptions were converted to 500 responses before the middleware saw them; `process_exception` now reports them. One client is shared per process.
- Feature-flag bucketing hashed UTF-8 bytes and ignored targeting rules; it now matches every other WatchUp SDK.

### Removed
- The internal `watchup.batcher` module (replaced by the delivery queue).
