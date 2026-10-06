"""
watchup · HTTP transport

Posts one chunk to the ingest API with urllib (stdlib only). Never raises:
failures become ``SendResult`` values so the queue can decide about retries.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Dict, Optional

from . import _contract as c
from ._queue import SendResult
from ._version import SDK_NAME, SDK_VERSION


class Transport:
    def __init__(self, base_url: str, api_key: str, timeout: float = 8.0) -> None:
        self._url = f"{base_url.rstrip('/')}{c.INGEST_PATH}"
        self._api_key = api_key
        self._timeout = timeout

    def headers(self, idempotency_key: str) -> Dict[str, str]:
        return {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self._api_key}",
            "X-Api-Key": self._api_key,
            "Idempotency-Key": idempotency_key,
            "User-Agent": f"{SDK_NAME}/{SDK_VERSION}",
        }

    def send(self, chunk: c.Chunk) -> SendResult:
        request = urllib.request.Request(
            self._url,
            data=chunk.body.encode("utf-8", "replace"),
            headers=self.headers(chunk.idempotency_key),
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self._timeout) as resp:
                return SendResult(ok=True, status=resp.status)
        except urllib.error.HTTPError as exc:
            return SendResult(
                ok=False,
                status=exc.code,
                code=_error_code(exc) or ("payload_too_large" if exc.code == 413 else None),
                retry_after_ms=c.parse_retry_after(exc.headers.get("Retry-After") if exc.headers else None),
            )
        except Exception as exc:  # URLError, timeouts, connection resets
            return SendResult(ok=False, error=str(exc))


def _error_code(exc: urllib.error.HTTPError) -> Optional[str]:
    try:
        body = json.loads(exc.read().decode("utf-8", "replace"))
    except Exception:
        return None
    code = body.get("code") if isinstance(body, dict) else None
    return code if isinstance(code, str) else None
