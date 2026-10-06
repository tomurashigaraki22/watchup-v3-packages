"""Contract workload for the Python SDK (run with PYTHONPATH=python)."""

import os

from watchup import Watchup

watchup = Watchup(
    "wup_live_test",
    base_url=os.environ["WATCHUP_BASE_URL"],
    environment="contract",
    flush_interval=60,
    flag_refresh_interval=0,
    shutdown_timeout=8,
)
watchup.set_user("contract-user")
watchup.capture_error(RuntimeError("x" * 256_000), headers={"Authorization": "Bearer secret-token-123"}, password="hunter2")
for i in range(3):
    watchup.track(f"unicode-{i}", {"text": "é" * 60_000})
for i in range(150):
    watchup.start_trace(f"contract-trace-{i}")()
watchup.flush()
watchup.shutdown()
