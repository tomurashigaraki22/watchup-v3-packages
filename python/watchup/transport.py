"""
watchup · HTTP transport

Posts ingest batches to the Watchup API. All failures are swallowed —
the SDK must never crash the host application.
"""

from __future__ import annotations

import json
import logging
import urllib.error
import urllib.request
from typing import Any, Dict

from .types import IngestBatch

log = logging.getLogger("watchup")


class Transport:
    def __init__(self, base_url: str, api_key: str, debug: bool = False) -> None:
        self._url = f"{base_url.rstrip('/')}/api/v1/ingest/batch"
        self._headers = {
            "Content-Type": "application/json",
            "X-Api-Key": api_key,
            "User-Agent": "watchup-python",
        }
        self._debug = debug

    def send(self, batch: IngestBatch) -> bool:
        payload: Dict[str, Any] = {}
        if batch.traces:
            payload["traces"] = [t.to_dict() for t in batch.traces]
        if batch.errors:
            payload["errors"] = [e.to_dict() for e in batch.errors]
        if batch.events:
            payload["events"] = [ev.to_dict() for ev in batch.events]

        if not payload:
            return True

        try:
            body = json.dumps(payload).encode()
            req = urllib.request.Request(
                self._url,
                data=body,
                headers=self._headers,
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=8) as resp:
                if resp.status >= 400:
                    if self._debug:
                        log.warning("[watchup] ingest %s", resp.status)
                    return False
                return True
        except Exception as exc:
            if self._debug:
                log.warning("[watchup] send failed: %s", exc)
            # Intentionally no re-raise; the batcher will retry the batch.
            return False
