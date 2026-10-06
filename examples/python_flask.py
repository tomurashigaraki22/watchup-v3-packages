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
