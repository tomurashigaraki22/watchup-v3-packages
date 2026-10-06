"""
watchup · request context

``contextvars`` keep the user and request IDs per request (threads, asyncio
tasks and greenlets each see their own), so concurrent requests never share
identity.
"""

from __future__ import annotations

import contextlib
import contextvars
import re
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, Iterator, Optional


@dataclass
class RequestContext:
    request_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    trace_id: Optional[str] = None
    method: Optional[str] = None
    route: Optional[str] = None
    user: Optional[Dict[str, Any]] = None


_current: contextvars.ContextVar[Optional[RequestContext]] = contextvars.ContextVar("watchup_request_context", default=None)

_SAFE_ID = re.compile(r"^[\w\-.:]{1,128}$")
_TRACEPARENT = re.compile(r"^[\da-f]{2}-([\da-f]{32})-[\da-f]{16}-[\da-f]{2}$", re.IGNORECASE)


def current() -> Optional[RequestContext]:
    return _current.get()


@contextlib.contextmanager
def scope(ctx: Optional[RequestContext] = None) -> Iterator[RequestContext]:
    """Run a block with its own request context."""
    ctx = ctx or RequestContext()
    token = _current.set(ctx)
    try:
        yield ctx
    finally:
        _current.reset(token)


def safe_request_id(value: Any) -> Optional[str]:
    return value if isinstance(value, str) and _SAFE_ID.match(value) else None


def trace_id_from(header: Any) -> Optional[str]:
    if not isinstance(header, str):
        return None
    match = _TRACEPARENT.match(header.strip())
    return match.group(1).lower() if match else None
