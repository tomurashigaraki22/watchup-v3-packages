"""Loader for spec/fixtures/vectors.json (generator syntax: spec/fixtures/README.md)."""

from __future__ import annotations

import json
import pathlib
from typing import Any, Dict, List

SPEC_DIR = pathlib.Path(__file__).resolve().parents[2] / "spec"
VECTORS: Dict[str, Any] = json.loads((SPEC_DIR / "fixtures" / "vectors.json").read_text(encoding="utf-8"))
SCHEMA: Dict[str, Any] = json.loads((SPEC_DIR / "envelope.schema.json").read_text(encoding="utf-8"))
KINDS = ("errors", "traces", "events")


def _expand(value: Any, i: int) -> Any:
    if isinstance(value, str):
        return value.replace("{i}", str(i))
    if isinstance(value, list):
        return [_expand(v, i) for v in value]
    if isinstance(value, dict):
        if "$repeat" in value:
            return str(value["$repeat"]) * value["times"]
        if "$object" in value:
            spec = value["$object"]
            return {str(spec["key"]).replace("{j}", str(j)): _expand(spec["value"], i) for j in range(spec["count"])}
        return {k: _expand(v, i) for k, v in value.items()}
    return value


def vector_input(vector: Dict[str, Any]) -> Dict[str, List[Dict[str, Any]]]:
    out: Dict[str, List[Dict[str, Any]]] = {k: [] for k in KINDS}
    for kind in KINDS:
        out[kind].extend(vector.get("input", {}).get(kind, []))
        gen = vector.get("generate", {}).get(kind)
        if gen:
            out[kind].extend(_expand(gen["template"], i) for i in range(gen["count"]))
    return out


def label(kind: str, item: Dict[str, Any]) -> str:
    field = {"errors": "message", "traces": "span", "events": "name"}[kind]
    return f"{kind}:{item[field]}"


def validate_envelope(body: Dict[str, Any]) -> List[str]:
    import re

    problems = [f"missing {k}" for k in SCHEMA["required"] if k not in body]
    defs = {"errors": "error", "traces": "trace", "events": "event"}
    for kind in KINDS:
        required = SCHEMA["$defs"][defs[kind]]["required"]
        for item in body.get(kind, []):
            problems.extend(f"{kind} item missing {k}" for k in required if k not in item)
    if not re.match(r"^wu_[A-Za-z0-9-]+_\d+$", body.get("idempotency_key", "")):
        problems.append("bad idempotency_key")
    return problems
