# Recent Facto Documents, v2

This overlay is incremental to the existing v1 document overlay. Apply
`recent-documents-v2.patch` to the separate Python worker checkout, then copy
`recent_documents.py` to `app/hub/`, `request_gate.py` to `app/integrations/`,
and `test_recent_documents.py` to `tests/`. Run the document-ingestion, hub CRM,
business-integration, retry and recent-document tests before building.

`Dockerfile.recent` uses that patched checkout as its build context. Its
`BASE_IMAGE` must be the existing production hub image, preserving DeepSeek,
prospecting, dependencies and unrelated modules. Persist the resulting image in
the existing hub-worker Compose service; do not replace the app or queue worker.

## Behavior

- A supervised task checks the last 45 days of document evidence every 120
  seconds after the previous cycle finishes. Dates use America/Santiago.
- Recent documents no longer wait for the full product catalog or historical
  detail scan. Full history synchronization remains unchanged.
- The task reuses authentication, refreshes document details after two minutes,
  and backs off to at most 15 minutes on failure. Requests across both jobs share
  a 1.1-second start-time gate and respect a provider cooldown after 429/503.
- The existing evidence loader keeps pagination and validation protections. No
  incomplete list is represented as a complete history or financial snapshot.
- The CRM integration batch now stages validated issued and domestic received
  documents directly in `accounting_source_documents`. It matches the ERP's
  company RUT, direction and native document ID, preserving original dates.
- Existing posted/voided documents, ambiguous workbook identities, foreign
  acquisition evidence and unsupported provider states require review. They are
  not overwritten automatically. Credit-note documents remain credit notes.
- This does not create payments, outstanding balances, journal entries, cost
  entries, reconciliations, or closures. API evidence does not replace verified
  collection workbooks or bank statements.
- The visible dashboard refreshes at most once per minute and on returning to
  the tab, with an in-flight guard. This is polling, not a real-time webhook or a
  promise that every Facto web action is exposed by its API.

## Read-Only Production Audit, 11 September 2026

Facto `GET /documents` for September returned invoice 1557 (149,421 net CLP),
1558 (22,009 net CLP), and 1559 (16,330 net CLP). The CRM had only 1557 when
checked. September's documentary net sales should therefore be 187,760 CLP,
subject to subsequent documents/credit notes and without claiming confirmed
costs. The existing full worker had a 30-minute interval after its full cycle
and logged repeated provider rate limits while scanning product details.

## Production Verification, 11 September 2026

The backend projection and the recent-document hub task were deployed with
release fingerprint `6fae2d80d917`. The first automatic cycle completed at
14:05 UTC: 39 issued and 20 received records, complete pagination and no failed
details. It picked up a further invoice, 1560 (34,476 net CLP), issued while the
correction was being prepared.

The production dashboard was then verified with four September invoices, 1557
through 1560, totaling 222,236 net CLP. The three new invoices remain validated
source documents, not posted journal entries. Fingerprints of the protected
ledger, payment, bank, reconciliation and period tables remained unchanged.

Only the hub service was recreated; the app and prospecting queue worker were
left running unchanged. Its Compose image is pinned to
`clima-activa-agent:facto-recent-6fae2d80d917`. The server's earlier image had
already been pruned, so a private filesystem export of the running hub was
preserved and imported without runtime credentials before building the overlay.
Code, financial-table and recovery backups are in
`/root/crm-deploy-backups/facto-recent-20260911` on the VPS.

The faster frontend refresh remains a local change pending the Git publication.
The production dashboard currently retains its existing five-minute refresh
and manual refresh. Git-source redeployments of the separate Python project
must reapply this overlay and preserve the pinned hub image; a container restart
alone keeps the configured version.
