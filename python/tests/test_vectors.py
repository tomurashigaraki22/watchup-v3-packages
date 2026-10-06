"""Shared contract vectors (spec/fixtures/vectors.json) against the Python implementation."""

from __future__ import annotations

import json
import re
import threading
from typing import Any, Dict, List, Optional

import pytest

from watchup import _contract as c
from watchup._queue import DeliveryQueue, Diagnostic, SendResult
from watchup.flags import flag_bucket

from .fixtures import KINDS, VECTORS, label, validate_envelope, vector_input


class Harness:
    def __init__(self, responses: Any, max_items: Optional[int] = None) -> None:
        self.clock = [1_000_000.0]
        self.sent: List[c.Chunk] = []
        self.attempts: List[Dict[str, str]] = []
        self.diagnostics: List[Diagnostic] = []
        self.script = list(responses) if isinstance(responses, list) else None
        self.mode = responses
        self.lock = threading.Lock()
        self.queue = DeliveryQueue(
            self.send,
            lambda: {"sdk": VECTORS["sdk"], "environment": "test"},
            max_items=max_items if max_items is not None else c.MAX_CHUNK_ITEMS,
            max_queue_items=10_000,
            auto_flush=False,
            on_diagnostic=self.diagnostics.append,
            now=lambda: self.clock[0],
            rand=lambda: 0.0,
        )

    def send(self, chunk: c.Chunk) -> SendResult:
        with self.lock:
            self.attempts.append({"key": chunk.idempotency_key, "body": chunk.body})
            if self.script is not None:
                status = self.script.pop(0) if self.script else 200
            else:
                status = 200 if self.mode == "always_200" else 503
        if 200 <= status < 300:
            self.sent.append(chunk)
            return SendResult(ok=True, status=status)
        return SendResult(ok=False, status=status)


def test_constants_match_spec() -> None:
    for key, value in VECTORS["constants"].items():
        assert getattr(c, key) == value, key


@pytest.mark.parametrize("vector", VECTORS["chunking"], ids=lambda v: v["name"])
def test_chunking(vector: Dict[str, Any]) -> None:
    h = Harness("always_200", vector.get("options", {}).get("max_items"))
    data = vector_input(vector)
    for kind in KINDS:
        for item in data[kind]:
            h.queue.enqueue(kind, item)
    h.queue.flush()

    expect = vector["expect"]
    assert len(h.sent) == expect["chunks"]
    order = []
    for chunk in h.sent:
        assert chunk.bytes == len(chunk.body.encode("utf-8"))
        assert chunk.bytes <= c.MAX_CHUNK_BYTES
        body = json.loads(chunk.body)
        assert validate_envelope(body) == []
        assert sum(len(body[k]) for k in KINDS) <= c.MAX_CHUNK_ITEMS
        order.extend((k, item) for k in KINDS for item in body[k])

    if "items_per_chunk" in expect:
        assert [ch.items for ch in h.sent] == expect["items_per_chunk"]
    if "sequence" in expect:
        assert [[label(k, i) for k in KINDS for i in json.loads(ch.body)[k]] for ch in h.sent] == expect["sequence"]
    if "truncated" in expect:
        assert [item.get("_watchup_truncated") is True for _, item in order] == expect["truncated"]
    if "max_message_bytes" in expect:
        for _, item in order:
            kept = re.sub(r"…\[truncated \d+ bytes\]$", "", item["message"])
            assert len(kept.encode("utf-8")) <= expect["max_message_bytes"]
            assert re.search(r"…\[truncated \d+ bytes\]$", item["message"])
    if expect.get("valid_utf8"):
        for _, item in order:
            assert "�" not in item["message"]
    if expect.get("context_marker"):
        ctx = order[0][1]["context"]
        assert ctx["_watchup_truncated"] is True
        assert ctx["original_bytes"] > c.MAX_CHUNK_BYTES
    for type_ in expect.get("diagnostics", []):
        assert type_ in [d.type for d in h.diagnostics]


@pytest.mark.parametrize("vector", VECTORS["redaction"], ids=lambda v: v["name"])
def test_redaction(vector: Dict[str, Any]) -> None:
    assert c.normalize(vector["input"]) == vector["expected"]


@pytest.mark.parametrize("vector", VECTORS["flag_buckets"], ids=lambda v: f"{v['flag']}:{v['id']}")
def test_flag_buckets(vector: Dict[str, Any]) -> None:
    assert flag_bucket(vector["flag"], vector["id"]) == vector["bucket"]


@pytest.mark.parametrize("vector", VECTORS["delivery"], ids=lambda v: v["name"])
def test_delivery(vector: Dict[str, Any]) -> None:
    h = Harness(vector["responses"])
    n = 0
    for kind in KINDS:
        for _ in range(vector["items"].get(kind, 0)):
            ident = f"{kind}-{n}"
            n += 1
            if kind == "errors":
                h.queue.enqueue(kind, {"message": ident, "level": "error", "timestamp": "t"})
            elif kind == "traces":
                h.queue.enqueue(kind, {"span": ident, "ms": 1, "status_code": 200, "status": "ok", "timestamp": "t"})
            else:
                h.queue.enqueue(kind, {"name": ident, "occurred_at": "t"})

    if vector["name"].startswith("shutdown"):
        h.queue.shutdown(0 if vector["name"] == "shutdown_reports_undelivered" else 5)
    elif vector.get("concurrent_flushes"):
        threads = [threading.Thread(target=h.queue.flush) for _ in range(vector["concurrent_flushes"])]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
    else:
        h.queue.flush()
        for _ in range(10):
            if not h.queue.retrying_count():
                break
            h.queue.flush(force=True)

    expect = vector["expect"]
    delivered = [label(k, i) for ch in h.sent for k in KINDS for i in json.loads(ch.body)[k]]
    assert len(delivered) == expect["delivered_items"]
    if "unique_items" in expect:
        assert len(set(delivered)) == expect["unique_items"]
    if "attempts" in expect:
        assert len(h.attempts) == expect["attempts"]
    if expect.get("same_idempotency_key"):
        assert len({a["key"] for a in h.attempts}) == 1
    if expect.get("retried_key_equals_first_key"):
        assert h.attempts[2]["key"] == h.attempts[0]["key"]
    if expect.get("first_pass_keys_distinct"):
        assert h.attempts[0]["key"] != h.attempts[1]["key"]
    if "pending_after_shutdown" in expect:
        assert h.queue.pending_count() + h.queue.retrying_count() == expect["pending_after_shutdown"]
    for type_ in expect.get("diagnostics", []):
        assert type_ in [d.type for d in h.diagnostics]
    bodies: Dict[str, str] = {}
    for a in h.attempts:
        if a["key"] in bodies:
            assert a["body"] == bodies[a["key"]]
        bodies[a["key"]] = a["body"]
