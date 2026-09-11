import asyncio
from datetime import date

import pytest

from app.hub.recent_documents import recent_documents_monitor, sync_recent_documents
from app.integrations.request_gate import FactoRequestGate


@pytest.mark.asyncio
async def test_recent_sync_is_independent_of_catalog_and_uses_a_bounded_window():
    calls = []

    async def sync(client, crm, **kwargs):
        calls.append((client, crm, kwargs))
        return {"complete": True}

    assert await sync_recent_documents("crm", client="client", today=date(2026, 9, 11), sync=sync) == {"complete": True}
    assert calls == [("client", "crm", {"history_start": date(2026, 7, 28), "max_pages": 50})]


@pytest.mark.asyncio
async def test_gate_spaces_requests_and_honors_shared_cooldown():
    now = [0.0]
    sleeps = []

    async def sleep(seconds):
        sleeps.append(seconds)
        now[0] += seconds

    gate = FactoRequestGate(spacing=1.1, clock=lambda: now[0], sleep=sleep)
    await gate.wait()
    await gate.wait()
    assert sleeps == [1.1]
    gate.defer(20)
    await gate.wait()
    assert now[0] == pytest.approx(21.1)
    gate.defer()
    await gate.wait()
    assert now[0] == pytest.approx(81.1)


@pytest.mark.asyncio
async def test_monitor_reuses_client_and_backs_off_on_failure(monkeypatch):
    import app.hub.recent_documents as module

    class Settings:
        facto_enabled = True

        def model_copy(self, **kwargs):
            return self

    sleeps, clients = [], []
    monkeypatch.setattr(module, "get_settings", lambda: Settings())
    client = object()
    monkeypatch.setattr(module, "FactoClient", lambda settings: client)

    async def sync(crm, *, client):
        clients.append(client)
        if len(clients) == 1:
            raise RuntimeError("temporary")
        return {"complete": True}

    async def sleep(seconds):
        sleeps.append(seconds)
        if len(sleeps) == 2:
            raise asyncio.CancelledError()

    monkeypatch.setattr(module, "sync_recent_documents", sync)
    monkeypatch.setattr(module.asyncio, "sleep", sleep)
    with pytest.raises(asyncio.CancelledError):
        await recent_documents_monitor("crm")
    assert clients == [client, client]
    assert sleeps == [240, 120]
