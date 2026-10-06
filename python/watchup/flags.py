"""
watchup · feature flags

Local evaluation identical to the JavaScript SDKs: the same djb2-xor hash over
UTF-16 code units, so a user lands in the same bucket in every runtime.
"""

from __future__ import annotations

import threading
import time
from typing import Any, Dict, List, Mapping, Optional


def flag_bucket(flag_key: str, user_id: str) -> int:
    data = f"{flag_key}:{user_id}".encode("utf-16-le", "surrogatepass")
    h = 5381
    for i in range(0, len(data), 2):
        unit = data[i] | (data[i + 1] << 8)
        h = ((h * 33) ^ unit) & 0xFFFFFFFF
    return h % 100


def matches_targeting(flag: Mapping[str, Any], ctx: Mapping[str, Any]) -> bool:
    rules = flag.get("targeting_rules") or []
    for rule in rules:
        value = ctx.get(rule.get("attribute", ""))
        val = "" if value is None else str(value)
        values = [str(v) for v in rule.get("values", [])]
        op = rule.get("operator")
        if op == "in" and val not in values:
            return False
        if op == "not_in" and val in values:
            return False
        if op == "contains" and not any(v in val for v in values):
            return False
        if op == "equals" and (not values or values[0] != val):
            return False
    return True


class FlagStore:
    """Thread-safe flag cache that expires when no refresh succeeds for ``max_age`` seconds."""

    def __init__(self, max_age: float = 24 * 3600, now: Any = time.monotonic) -> None:
        self._flags: Dict[str, Dict[str, Any]] = {}
        self._fetched_at: Optional[float] = None
        self._max_age = max_age
        self._now = now
        self._lock = threading.Lock()

    def replace(self, flags: List[Dict[str, Any]]) -> None:
        with self._lock:
            self._flags = {f["key"]: f for f in flags if isinstance(f, dict) and "key" in f}
            self._fetched_at = self._now()

    def get(self, key: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            if self._fetched_at is None or self._now() - self._fetched_at > self._max_age:
                return None
            return self._flags.get(key)

    def is_enabled(self, key: str, ctx: Mapping[str, Any]) -> bool:
        flag = self.get(key)
        if not flag or not flag.get("enabled"):
            return False
        if not matches_targeting(flag, ctx):
            return False
        rollout = flag.get("rollout_percentage", 100)
        rollout = float(rollout)
        if rollout >= 100:
            return True
        if rollout <= 0:
            return False
        uid = ctx.get("userId") or ctx.get("user_id") or ctx.get("email")
        if not uid:
            return False
        return flag_bucket(key, str(uid)) < rollout

    def get_variant(self, key: str, ctx: Mapping[str, Any]) -> str:
        if not self.is_enabled(key, ctx):
            return "control"
        flag = self.get(key) or {}
        variants = flag.get("variants") or []
        if not variants:
            return "on"
        uid = ctx.get("userId") or ctx.get("user_id") or ctx.get("email")
        bucket = flag_bucket(key, str(uid)) if uid else 0
        cumulative = 0
        for variant in variants:
            cumulative += variant.get("weight", 0)
            if bucket < cumulative:
                return str(variant["key"])
        return str(variants[-1]["key"])
