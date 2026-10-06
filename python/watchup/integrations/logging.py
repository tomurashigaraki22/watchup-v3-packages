"""
watchup · standard library ``logging`` handler

    import logging
    from watchup.integrations.logging import WatchupHandler
    logging.getLogger().addHandler(WatchupHandler(watchup, level=logging.INFO))

Records become structured WatchUp logs (requires ``Watchup(logging=True)``).
Records carrying ``exc_info`` at ERROR or above are also reported as errors.
The SDK's own ``watchup`` logger is ignored to prevent feedback loops.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from ..client import Watchup

_LEVELS = {
    logging.DEBUG: "debug",
    logging.INFO: "info",
    logging.WARNING: "warning",
    logging.ERROR: "error",
    logging.CRITICAL: "critical",
}


class WatchupHandler(logging.Handler):
    def __init__(self, watchup: Watchup, level: int = logging.INFO) -> None:
        super().__init__(level)
        self._watchup = watchup

    def emit(self, record: logging.LogRecord) -> None:
        if record.name == "watchup" or record.name.startswith("watchup."):
            return
        try:
            level = _LEVELS.get(record.levelno) or ("critical" if record.levelno > logging.CRITICAL else "debug")
            self._watchup.capture_log(
                record.getMessage(),
                level=level,  # type: ignore[arg-type]
                logger=record.name,
                module=record.module,
                line=record.lineno,
            )
            if record.exc_info and record.exc_info[1] is not None and record.levelno >= logging.ERROR:
                self._watchup.capture_error(record.exc_info[1], logger=record.name)
        except Exception:
            self.handleError(record)
