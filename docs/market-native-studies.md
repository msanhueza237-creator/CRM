# Native Market Studies

## Scope

The administrator can now run a public product-page study directly in the CRM.
DeepSeek remains the selected default; changing models is explicit, revision-checked,
and limited to configured providers/models. No automatic fallback is used.
The old external researcher remains disabled and is only shown under Integrations.
No external credential is created by the native workflow.

The entry screen selects a product and runs an open web search through the already
configured DeepSeek integration. Up to three complementary searches discover
individual product pages; up to eight different sellers are read. Competitor
examples are optional references, not a domain allowlist for discovery. No source
URL is required for the search. This is a bounded sample of the indexed public web,
not an exhaustive census of the market. Blocked or redirected pages are not bypassed.

The comparison shows current net sale price, current Facto product cost and landed
cost estimates from incoming imports with exactly the same SKU. The import selector
does not average different shipments. Offers have source/date, original amount,
currency, tax basis, availability and evidence. Provisional unit-net CLP comparisons
require an identified model, explicit single-unit presentation and tax basis.
Unknown currency, taxes, quantities or equivalence never become zero. Margins at
competitor prices are scenarios, not approved price changes. Sorting/filtering and
current/incoming cost scenarios are available without another paid query.

Manual single-source extraction remains under the optional known-link panel.
The selected product in the URL is shared with the researcher, fixing the former
independent selector that could display a different product.

## Evidence And Safety

- Authenticated active administrators only. Service credentials never reach the UI.
- Manual extraction keeps its original host allowlist. Open search only reads URLs
  returned by real native web-search tool blocks, never model-generated URL lists.
- Open-source requests reject credentials, private paths and sensitive query keys.
  DNS resolves public IPv4 only; HTTPS pins that validated address in its lookup
  callback, keeps certificate/SNI verification and never follows redirects. IPv6,
  private/link-local/metadata/reserved IPv4, mixed public/private DNS and IP literals
  fail closed. No browser cookies, proxy settings or authentication headers are sent.
- Robots rules, bounded downloads and request deadlines; no remote scripts execute.
- DOM/JSON-LD parsing with explicit single-product and single-offer checks.
- Only sanitized public product attributes go to the model, not internal costs,
  customer data or company documents. Values and quotes must occur in the source.
- An extraction is a draft. The administrator verifies price, currency, VAT,
  presentation and availability before saving through the existing import flow.
- Technical equivalence and cost basis still require the existing human review.
- Missing or ambiguous costs remain unknown, not zero. Incoming stock remains
  estimated. The source reader now uses the actual `import_shipments` table.
- Source pages can themselves contain errors. Matching a title/SKU is not proof
  of technical equivalence; the original source and capture remain available.

## Budget And Persistence

`market_native_studies.sql` adds only two market-owned tables and one service-only
RPC. The user explicitly approved this isolated schema addition on 2026-10-06.
It leaves customers, products, accounting tables and external pilot configuration
unchanged. The user approved USD 2.50/day and 10 attempts/day on 2026-10-06,
America/Santiago. Search and manual-source attempts share these limits.

Reservations serialize under the existing market advisory lock. One native job
can run at a time. A request UUID plus canonical input hash prevents duplicate
dispatch. Interrupted reservations become unknown after two minutes, retain their
reserved amount and are never automatically retried. Sources rejected before an
inference settle at zero; unconfirmed provider usage retains its reservation.
Single-source costs use configured conservative uncached rates, not a billing reconciliation.
Unlike the temporary worker pilot, the administrator workflow does not expire
after one hour or disable itself because a tariff review date is eight days old.
Tariffs must still be maintained when a provider changes prices.

## Open Search Budget Gate

Open search reserves USD 0.25 per user-triggered request, allowing up to ten
searches in the USD 2.50 daily reservation. It never releases that reservation from incomplete
provider token reports: native web search includes extra summarization usage.
Searches serialize one at a time and share the daily budget and attempt count
with manual source extractions. Existing receipts remain readable and duplicate IDs
never trigger another call. The updated service RPC reports `web_search_supported`;
old deployments keep the new paid action disabled. This control is a CRM reservation,
NOT a provider-enforced hard monetary billing cap. The user explicitly approved
publishing this change and one paid production test on 2026-10-06 after being told
the destination, affected module, daily reservation and billing limitation. The later
increase to ten searches does not clear existing receipts or authorize automatic
paid tests. The first day's previously used search still counts toward ten.
Production's existing Edge worker lifetime is 60 seconds: provider search is
bounded to 30 seconds, followed by two batches of at most four source reads with
8-second deadlines. The shared Edge runtime configuration is unchanged.

Sources checked for the provider contract:
https://api-docs.deepseek.com/guides/anthropic_api/
https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code/
The Responses API ignores built-in web_search, so open research uses the existing
Anthropic-compatible native search endpoint, without changing other CRM modules.
https://api-docs.deepseek.com/guides/responses_api/

## Verification And Deployment

Run:

```text
node --experimental-transform-types --test scripts/test-market-native.mjs
node --experimental-transform-types --test scripts/test-market-search.mjs
node --experimental-transform-types --test scripts/test-market-study.mjs scripts/test-market-study-security.mjs scripts/test-market-extraction.mjs scripts/test-market-research-api.mjs
node scripts/test-market-native-browser.mjs
node scripts/test-market-search-browser.mjs
node --experimental-transform-types scripts/test-market-study-browser.mjs tmp/market-regression-browser
node scripts/typecheck-market-study.mjs
node scripts/build-market-functions.mjs
npm run build
```

Browser fixtures intercept all traffic and use synthetic data. They cover desktop,
390px and 320px, explicit model selection, review invalidation after edits,
grounded draft -> reviewed import -> pending equivalence, existing simulation,
Dashboard and permission failures. PostgreSQL tests use an isolated local PGlite
database, including budget, role grants, idempotence and interrupted jobs.

Deployment is separate: backup the affected market schema/data, service RPC and current Edge
bundle. Apply `supabase/market_native_studies.sql` only with the approved budget change:
it upgrades the native policy constraint/default and RPC atomically, aborts if a job is
running or policy limits differ from the reviewed values, and leaves receipts unchanged.
It is idempotent for the approved USD 2.50 / ten-attempt policy. Deploy the standalone market-study bundle,
then publish frontend through the existing main/Dokploy pipeline. Do not recreate
the Supabase stack, alter credentials, change other functions or delete resources.
Live production verification must use the normal authenticated UI, not minted
sessions. A successful local test or push is not production verification.

The dependency audit at implementation reported existing advisories in unrelated
dependencies; none named the two added packages (linkedom and robots-parser).
No broad dependency upgrade or infrastructure cleanup is part of this release.
