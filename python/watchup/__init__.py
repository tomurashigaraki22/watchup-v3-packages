"""
watchup — application monitoring SDK for Python

Quick start::

    from watchup import Watchup

    watchup = Watchup(api_key="wup_live_xxxxxxxxxxxx")

    # Flask
    watchup.init_app(app)

    # Manual error capture
    watchup.capture_error(exc, route="job.process_order")

    # Custom events
    watchup.track("user.signed_up", {"plan": "pro"})

    # Trace any operation
    with watchup.trace("db.query"):
        ...

Importing this package never makes network calls; the client starts its
background delivery thread when it is constructed.
"""

from ._queue import Diagnostic, FlushResult
from ._version import SDK_NAME, SDK_VERSION
from .client import Watchup
from .context import RequestContext
from .middleware import WatchupASGI, WatchupDjangoMiddleware, WatchupWSGI
from .sql import sanitize_sql

__all__ = [
    "Diagnostic",
    "FlushResult",
    "RequestContext",
    "SDK_NAME",
    "SDK_VERSION",
    "Watchup",
    "WatchupASGI",
    "WatchupDjangoMiddleware",
    "WatchupWSGI",
    "sanitize_sql",
]
__version__ = SDK_VERSION
