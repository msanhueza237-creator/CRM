from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from app.config import get_settings
from app.integrations.facto import FactoClient

logger = logging.getLogger("clima_activa.facto_recent")
INTERVAL_SECONDS = 120
LOOKBACK_DAYS = 45


async def sync_recent_documents(crm, *, client=None, today=None, sync=None):
    # Import lazily: the hub supervises this task alongside the full history job.
    from app.hub.worker import sync_facto_document_evidence

    today = today or datetime.now(ZoneInfo("America/Santiago")).date()
    settings = get_settings().model_copy(update={"facto_document_detail_cache_minutes": 2})
    client = client or FactoClient(settings)
    return await (sync or sync_facto_document_evidence)(
        client, crm, history_start=today - timedelta(days=LOOKBACK_DAYS), max_pages=50,
    )


async def recent_documents_monitor(crm):
    settings = get_settings()
    if not settings.facto_enabled:
        return
    # Reuse authentication across cycles; do not authenticate every two minutes.
    client = FactoClient(settings.model_copy(update={"facto_document_detail_cache_minutes": 2}))
    failures = 0
    while True:
        try:
            audit = await sync_recent_documents(crm, client=client)
            if not audit.get("complete"):
                raise RuntimeError("Recent document evidence incomplete")
            failures = 0
            logger.info("Facto recent documents synchronized: %s", audit)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            failures += 1
            # Never log provider bodies, credentials or token-bearing URLs.
            logger.warning("Facto recent documents pending: %s", type(exc).__name__)
        await asyncio.sleep(min(900, INTERVAL_SECONDS * (2 ** min(failures, 3))))
