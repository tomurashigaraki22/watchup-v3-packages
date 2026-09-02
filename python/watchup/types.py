"""
watchup · payload types
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Literal, Optional, Union


# ── User ──────────────────────────────────────────────────────────────────────

@dataclass
class WatchupUser:
    id: Union[str, int]
    email: Optional[str] = None
    name: Optional[str] = None
    extra: Optional[Dict[str, Any]] = None

    def to_dict(self) -> Dict[str, Any]:
        d: Dict[str, Any] = {"id": self.id}
        if self.email is not None:
            d["email"] = self.email
        if self.name is not None:
            d["name"] = self.name
        if self.extra:
            d.update(self.extra)
        return d


# ── Ingest payloads ───────────────────────────────────────────────────────────

@dataclass
class TracePayload:
    span: str
    ms: float
    status_code: int
    status: Literal["ok", "warn", "err"]
    timestamp: str
    environment: Optional[str] = None
    release: Optional[str] = None
    meta: Optional[Dict[str, Any]] = None
    user: Optional[Dict[str, Any]] = None

    def to_dict(self) -> Dict[str, Any]:
        d: Dict[str, Any] = {
            "span": self.span,
            "ms": round(self.ms, 2),
            "status_code": self.status_code,
            "status": self.status,
            "timestamp": self.timestamp,
        }
        if self.environment is not None:
            d["environment"] = self.environment
        if self.release is not None:
            d["release"] = self.release
        if self.meta:
            d["meta"] = self.meta
        if self.user:
            d["user"] = self.user
        return d


@dataclass
class ErrorPayload:
    message: str
    level: Literal["debug", "info", "warning", "error", "fatal"]
    timestamp: str
    route: Optional[str] = None
    stack: Optional[str] = None
    context: Optional[Dict[str, Any]] = None
    environment: Optional[str] = None
    release: Optional[str] = None
    user: Optional[Dict[str, Any]] = None

    def to_dict(self) -> Dict[str, Any]:
        d: Dict[str, Any] = {
            "message": self.message,
            "level": self.level,
            "timestamp": self.timestamp,
        }
        if self.route is not None:
            d["route"] = self.route
        if self.stack is not None:
            d["stack"] = self.stack
        if self.context:
            d["context"] = self.context
        if self.environment is not None:
            d["environment"] = self.environment
        if self.release is not None:
            d["release"] = self.release
        if self.user:
            d["user"] = self.user
        return d


@dataclass
class EventPayload:
    name: str
    occurred_at: str
    properties: Optional[Dict[str, Any]] = None

    def to_dict(self) -> Dict[str, Any]:
        d: Dict[str, Any] = {"name": self.name, "occurred_at": self.occurred_at}
        if self.properties:
            d["properties"] = self.properties
        return d


# ── Batch ─────────────────────────────────────────────────────────────────────

@dataclass
class IngestBatch:
    traces: List[TracePayload] = field(default_factory=list)
    errors: List[ErrorPayload] = field(default_factory=list)
    events: List[EventPayload] = field(default_factory=list)
