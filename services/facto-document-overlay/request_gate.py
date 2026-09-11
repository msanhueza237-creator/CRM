from __future__ import annotations

import asyncio
import time


class FactoRequestGate:
    """Pace the full-history and recent-document jobs through a shared gate."""

    def __init__(self, spacing=1.1, *, clock=time.monotonic, sleep=asyncio.sleep):
        self.spacing = spacing
        self.clock = clock
        self.sleep = sleep
        self.next_start = 0.0
        self.lock = asyncio.Lock()

    async def wait(self):
        async with self.lock:
            remaining = self.next_start - self.clock()
            while remaining > 0:
                await self.sleep(remaining)
                remaining = self.next_start - self.clock()
            self.next_start = self.clock() + self.spacing

    def defer(self, retry_after=None):
        delay = retry_after if retry_after is not None and 0 <= retry_after <= 300 else 60
        self.next_start = max(self.next_start, self.clock() + delay)


facto_request_gate = FactoRequestGate()
