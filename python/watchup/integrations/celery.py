"""
watchup · Celery integration

    from watchup.integrations.celery import init_celery
    init_celery(watchup)

Each task runs in its own WatchUp context (so ``set_user`` is per task), is
recorded as a ``celery.<task name>`` trace, and failures are reported once
with the task ID and retry count. Task arguments are never recorded.
"""

from __future__ import annotations

import time
from typing import TYPE_CHECKING, Any, Dict

from ..context import RequestContext, _current

if TYPE_CHECKING:
    from ..client import Watchup


def init_celery(watchup: Watchup, signals: Any = None) -> None:
    """Connect WatchUp to Celery's task signals. ``signals`` is injectable for tests."""
    if signals is None:
        try:
            from celery import signals as celery_signals
        except ImportError as exc:
            raise ImportError("Celery is not installed. Run: pip install celery") from exc
        signals = celery_signals

    running: Dict[str, Dict[str, Any]] = {}

    def span_of(task: Any) -> str:
        return f"celery.{getattr(task, 'name', None) or 'task'}"

    def on_prerun(task_id: str = "", task: Any = None, **_: Any) -> None:
        ctx = RequestContext(request_id=task_id or RequestContext().request_id, route=span_of(task))
        running[task_id] = {"ctx": ctx, "token": _current.set(ctx), "start": time.perf_counter(), "failed": False}

    def on_failure(task_id: str = "", exception: BaseException = None, sender: Any = None, **_: Any) -> None:  # type: ignore[assignment]
        state = running.get(task_id)
        if state is not None:
            state["failed"] = True
        request = getattr(sender, "request", None)
        watchup.capture_error(
            exception if exception is not None else "Celery task failed",
            route=span_of(sender),
            task={"id": task_id, "name": getattr(sender, "name", None), "retries": getattr(request, "retries", None)},
        )

    def on_postrun(task_id: str = "", task: Any = None, state: Any = None, **_: Any) -> None:
        info = running.pop(task_id, None)
        if info is None:
            return
        try:
            ms = (time.perf_counter() - info["start"]) * 1000
            failed = info["failed"] or state == "FAILURE"
            retried = state == "RETRY"
            from ..client import _now
            from ..types import TracePayload

            ctx: RequestContext = info["ctx"]
            watchup._queue.enqueue(
                "traces",
                TracePayload(
                    span=span_of(task),
                    ms=ms,
                    status_code=500 if failed else 400 if retried else 200,
                    status="err" if failed else "warn" if retried else "ok",
                    timestamp=_now(),
                    environment=watchup.environment,
                    release=watchup.release,
                    meta={**watchup._base_context_for(ctx), "task_state": state, "source": "worker"},
                    user=ctx.user,
                    trace_type="function",
                ).to_dict(),
            )
        finally:
            try:
                _current.reset(info["token"])
            except ValueError:
                pass

    signals.task_prerun.connect(on_prerun, weak=False)
    signals.task_failure.connect(on_failure, weak=False)
    signals.task_postrun.connect(on_postrun, weak=False)
