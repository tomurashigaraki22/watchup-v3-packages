import asyncio
import unittest

from flask import Flask

from watchup import Watchup, WatchupASGI
from watchup.batcher import Batcher
from watchup.types import WatchupUser
from watchup.middleware import _flask_init_app


class FakeTransport:
    def __init__(self, outcomes=None):
        self.outcomes = list(outcomes or [True])
        self.batches = []

    def send(self, batch):
        self.batches.append(batch)
        return self.outcomes.pop(0) if self.outcomes else True


class SdkTests(unittest.TestCase):
    def test_python_39_compatible_payload_serialization(self):
        self.assertEqual(WatchupUser("usr_1", name="A").to_dict(), {"id": "usr_1", "name": "A"})

    def test_batch_is_requeued_when_transport_fails(self):
        transport = FakeTransport([False])
        batcher = Batcher(transport, 60, 10)
        batcher.add_event(type("Event", (), {"name": "test"})())
        batcher.flush(wait=True)
        with batcher._lock:
            self.assertEqual(len(batcher._events), 1)

    def test_invalid_configuration_is_rejected(self):
        with self.assertRaises(ValueError):
            Watchup("key", sample_rate=1.1)
        with self.assertRaises(ValueError):
            Watchup("key", flush_interval=0)
        with self.assertRaises(ValueError):
            Watchup("key", max_batch_size=0)

    def test_asgi_middleware_records_response_status(self):
        client = Watchup.__new__(Watchup)
        client.environment = "test"
        client.release = None
        client._user_dict = lambda: None
        client._should_sample = lambda: True
        client._batcher = type("Batcher", (), {"add_trace": lambda self, trace: setattr(self, "trace", trace)})()

        async def app(scope, receive, send):
            await send({"type": "http.response.start", "status": 204, "headers": []})
            await send({"type": "http.response.body", "body": b""})

        async def send(_message):
            return None

        asyncio.run(WatchupASGI(app, client)({"type": "http", "method": "GET", "path": "/health"}, None, send))
        self.assertEqual(client._batcher.trace.status_code, 204)
        self.assertEqual(client._batcher.trace.status, "ok")

    def test_flask_capture_contains_exception_type_stack_and_safe_request(self):
        app = Flask(__name__)
        app.testing = True
        client = Watchup.__new__(Watchup)
        client.environment = "test"
        client.release = "abc123"
        client._user_dict = lambda: None
        client._should_sample = lambda: True
        client._batcher = type("Batcher", (), {"add_trace": lambda self, trace: None, "add_error": lambda self, error: setattr(self, "error", error)})()
        _flask_init_app(client, app)

        @app.get("/orders/<int:order_id>")
        def order(order_id):
            raise ValueError("bad order")

        with self.assertRaises(ValueError):
            app.test_client().get("/orders/42", headers={"X-Request-ID": "req-1", "Authorization": "secret"})
        error = client._batcher.error
        self.assertEqual(error.error_type, "ValueError")
        self.assertIn("ValueError: bad order", error.stack)
        self.assertEqual(error.context["request"]["path"], "/orders/:id")
        self.assertEqual(error.context["request"]["headers"]["X-Request-ID"], "req-1")
        self.assertNotIn("Authorization", error.context["request"]["headers"])


if __name__ == "__main__":
    unittest.main()
