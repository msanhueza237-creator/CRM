# Facto Document Evidence Overlay v1

Worker base: `3ae811f705944ad662bfc6aaecb41721ab7e2e6c` in
`agente-inteligente-comercial`, with the CRM DeepSeek overlay already applied.
Patch: `facto-documents-v1.patch`.

The patch contains ONLY `app/hub/worker.py` and the new
`tests/test_facto_document_ingestion.py`. It does not reapply DeepSeek or change
`app/crm/http.py`, prospecting modules, dependencies, infrastructure or accounting.
The Dockerfile copies ONLY the changed hub module over an existing image that
already contains DeepSeek. It inherits that image's user, command and environment.
Tests are in the source patch, not the runtime image.

## Behavior

- `documents` and `document_details` receive the same enriched issued evidence:
  invoices, exempt invoices and domestic/export credit and debit notes. Purchase
  evidence goes to `purchase_documents` and `purchase_document_details`.
- The explicit `received_issued_flag` wins over type-ID defaults or resource names.
  Header values take precedence over flat list aliases after detail enrichment.
  Missing flags retain the established internal-type fallback; malformed flags
  are not silently interpreted as issued. A tax code alone never proves direction.
- Nested document IDs become stable external IDs, before generic envelope IDs.
  Explicit header/totals fields are exposed without parsing or rounding amounts or
  dates. Original header, totals, references and detail lines remain in the payload.
  `taxes_amount` also supplies the snapshot-compatible `tax_amount` alias.
- Details are fetched before publishing summaries, so summaries-first accounting
  ingestion retains references. A failed, empty or mismatched detail read does not
  downgrade an existing enriched record to a bare summary. That document is skipped
  for evidence writes, reported incomplete, and retried on a subsequent cycle.
- Credit/debit notes added to evidence are NOT positive sales inputs for inventory,
  commercial or financial snapshots, including exception fallbacks. Received
  credit signing remains limited to the previously supported internal type 28.
- No payment-status, unpaid-balance or outstanding-amount filter is added. The
  existing API scope remains `document_status=1`, from `2025-01-01` through the
  worker's current date (or an explicit loader `history_start`).
- `max_pages`, repeated pages and page-request errors raise
  `FactoDocumentLoadIncomplete` with partial records and the stop reason/page count.
  The monitor retains the collected evidence, reports integration status `error`,
  withholds financial and unified commercial snapshots, and refreshes inventory
  without partial demand history. Positive `next_page`/`nextPage` values no longer
  terminate pagination accidentally. A short page alone does not prove completion.

Completeness here means exhausting the requested API date/status range, not all
ERP history, all document types, all details, or the accounting ledger. Failure
status uses the existing hub integration-status endpoint; no new CRM resource or
schema is required. A detail failure can still leave conservative informational
snapshots based on the complete list response, but never an unfiltered note list.

## Verified Evidence

The initial NC80 regression uses user-verified identifiers: document `762`, internal
type `16`, tax code `61`, issued flag `1`, status `1`, date `2026-08-18`, referring
to invoice `1534` / document `731`, net CLP `9,091,838`. Surrounding test fields are
synthetic, not a full copied API response.

Read-only verification on 2026-09-10 used the existing container's `FactoClient`
without exporting credentials or changing files/services:

- `GET /document_types` returned one complete page with 20 types and did NOT list
  foreign purchase type `57`; `GET /document_types/57` returned 404.
- `GET /documents` for 2026-06-22 returned document `695`, folio `3`, type `57`,
  direction `0`, tax code `0`, status `1`.
- `GET /documents/695` confirmed Hangzhou Lifeng, `currency_id=39`,
  `exchange_rate_value=1`, net
  `11365601`, tax `2159464.19`, total `13525065.19`, dated `2026-06-22`.
  The patch adds this verified type to purchase EVIDENCE, not to unsigned or
  currency-unaware snapshot calculations. No undocumented ID was guessed.
  The response supplies no textual ISO currency code; this overlay preserves the
  native currency/rate fields rather than guessing a currency from the supplier.
- The existing Excel source is `43a5ecad-3fe1-41ee-bdf5-cfb04326d3c4`. The worker
  does not deduplicate that accounting source against native API document `695`.
  Reconcile the identities before any future posting; do not repost this purchase.
  The separate June 23 China inventory receipt (CLP 51.098M), cost document 1547
  (user-verified CLP 6M, August 18), and seven centralized ADS were not changed.

Documented emitted IDs `16/17/47/48` come from
[Koywe OpenAPI](https://raw.githubusercontent.com/koyweforest/api-billing-postman/main/openapi.json).
Tax-bureau codes and internal IDs are separate namespaces; see the
[SII DTE format](https://www.sii.cl/factura_electronica/factura_mercado/formato_dte_202602.pdf).
The type catalog cannot be used as a complete inventory of historical API types.

## Remaining Gaps

- Informational snapshots still do not subtract issued refunds or reverse the
  original invoice/product demand. They are not refund-adjusted net sales and must
  not be presented as an accounting reconciliation. Newly ingested notes remain
  evidence-only; adding them as positive amounts would be incorrect.
- Type 57 foreign purchases are evidence-only. Foreign currency conversion,
  exchange-rate policy and other unknown international types are not implemented.
- Amount/date parsing in `finance.py`, `commercial.py`, `inventory.py` and CRM
  readers is outside this patch. ISO dates and ordinary decimal strings work in
  existing paths, but Chilean grouped amounts such as `6.000.000`, ambiguous
  separators, non-ISO dates, nonfinite numbers and cross-midnight timezones still
  need dedicated parser work. This overlay preserves raw strings rather than
  silently interpreting those cases. The pre-existing worker end-date uses
  `date.today()`, not an explicit Chile timezone.
- Existing wrongly routed historical `documents` rows are not deleted or moved:
  the hub port only upserts. Downstream readers must use the payload direction,
  not the resource name, and reconcile historical duplicates explicitly.
- Unsupported/ambiguous document types are not inferred from names or tax codes
  without direction. Nonfinancial guides remain excluded. Detail reads without
  provider references cannot manufacture missing references. The existing detail
  cache TTL remains in force.
- Pagination hardening is for financial documents. Optional payments, receivables,
  inbox and product loaders retain their previous completeness behavior.

## Local Verification

Result: 184 selected tests passed. Targeted Ruff checks passed. The versioned
patch passed `git apply --reverse --check` against the patched checkout and its
manifest contains exactly the hub module and new test file.

Run in the separate Python checkout, preserving its existing changes:

```text
git rev-parse HEAD
git status --short
git apply --check <absolute-path-to-facto-documents-v1.patch>
git apply <absolute-path-to-facto-documents-v1.patch>
python -m pytest tests/test_facto_document_ingestion.py tests/test_inventory_snapshots.py tests/test_financial_snapshots.py tests/test_commercial_snapshots.py tests/test_hub_crm.py tests/test_product_detail_retries.py tests/test_business_integrations.py tests/test_hub_agents.py -q
python -m ruff check --isolated --select E4,E7,E9,F app/hub/worker.py tests/test_facto_document_ingestion.py
```

If already applied, use `git apply --reverse --check` to inspect that condition;
do not force, reset or reapply. Broad Ruff rules also flag pre-existing import,
timezone and `noqa` conventions in this module; unrelated lint cleanup is excluded.

## Image Preparation

Build context: the separately patched Python checkout. Pin `BASE_IMAGE` to the
existing DeepSeek-bearing image, preferably by digest. Do not use the unpatched
upstream image or the CRM frontend image. Example for a future authorized build:

```text
docker build --file <CRM>/services/facto-document-overlay/Dockerfile --build-arg BASE_IMAGE=<existing-worker-image@sha256:digest> --build-arg CRM_REVISION=<revision-identifying-this-overlay> --tag <new-local-worker-tag> <patched-python-checkout>
```

This preparation did not build or publish an image, change production code or
configuration, restart services, commit, deploy, migrate, post or repost entries.
The only production access was the explicitly requested read-only Facto API audit.

## One-Time Document Sync

Callable: `app.hub.worker.sync_facto_document_evidence(client, crm, *,
history_start=None, max_pages=20)`. It reads documents/details and upserts ONLY
`documents`, `purchase_documents`, `document_details`, `purchase_document_details`.
It does not call the monitor, health reporter, product/inventory/customer loaders,
snapshot writers, accounting source-sync routes or centralization routes.

The user reports a private backup at
`/root/crm-deploy-backups/financial-documents-20260910`; this task did not inspect
or modify it. After a separately authorized deployment of this overlay, run the
following in the existing worker container with its existing environment. This is
a recipe, NOT an operation executed by this task:

```sh
docker exec -i -e PYTHONDONTWRITEBYTECODE=1 crm-climactiva-agente-inteligente-comercial-amxo4p-hub-worker-1 python -B - <<'PY'
import asyncio
import json
from datetime import date
from app.config import get_settings
from app.hub.crm import HubCRMPort
from app.hub.worker import sync_facto_document_evidence
from app.integrations.facto import FactoClient

async def main():
    settings = get_settings()
    crm = HubCRMPort(
        base_url=settings.crm_base_url,
        api_key=settings.crm_api_key.get_secret_value(),
        timeout=settings.crm_timeout_seconds,
    )
    audit = await sync_facto_document_evidence(
        FactoClient(settings), crm,
        history_start=date(2025, 1, 1), max_pages=200,
    )
    print(json.dumps(audit, sort_keys=True))
    if not audit['complete']:
        raise SystemExit(2)

asyncio.run(main())
PY
```

An incomplete run retains successfully fetched evidence but exits nonzero; a CRM
write failure raises instead of claiming completion. Reruns use stable external
IDs and the existing HubCRM idempotency contract. Review the returned audit and
read both enriched summary/detail payloads for issued document `762` and received
document `695` before running any separately authorized source sync or reports.
Do not repost ADS or automatically centralize the existing Excel purchase.
