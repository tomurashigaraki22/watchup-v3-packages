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
    end = watchup.start_trace("db.query")
    end()
"""

from .client import Watchup
from .middleware import WatchupASGI, WatchupDjangoMiddleware, WatchupWSGI

__all__ = ["Watchup", "WatchupASGI", "WatchupDjangoMiddleware", "WatchupWSGI"]
__version__ = "2.0.0"
