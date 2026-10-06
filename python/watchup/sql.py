"""
watchup · SQL statement sanitizer for database spans

Literals become ``?`` and statements are capped at 1 KiB, so span names never
carry credentials or unbounded parameter values. Mirrors @watchupltd/core.
"""

from __future__ import annotations

import re

from ._contract import truncate_utf8

MAX_STATEMENT_BYTES = 1024

_RULES = (
    (re.compile(r"--[^\n]*"), " "),
    (re.compile(r"/\*[\s\S]*?\*/"), " "),
    (re.compile(r"'(?:[^']|'')*'"), "?"),
    (re.compile(r"\$\$[\s\S]*?\$\$"), "?"),
    (re.compile(r"\b0x[0-9a-f]+\b", re.IGNORECASE), "?"),
    (re.compile(r"(^|[^\w$])-?\d+(?:\.\d+)?(?:e[+-]?\d+)?\b", re.IGNORECASE), r"\1?"),
    (re.compile(r"\(\s*\?(?:\s*,\s*\?)+\s*\)"), "(?)"),
    (re.compile(r"\s+"), " "),
)


def sanitize_sql(sql: str) -> str:
    out = sql
    for pattern, replacement in _RULES:
        out = pattern.sub(replacement, out)
    return truncate_utf8(out.strip(), MAX_STATEMENT_BYTES)[0]
