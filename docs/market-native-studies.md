# Native Market Studies

## Scope

The administrator can now run a public product-page study directly in the CRM.
DeepSeek remains the selected default; changing models is explicit, revision-checked,
and limited to configured providers/models. No automatic fallback is used.
The old external researcher remains disabled and is only shown under Integrations.
No external credential is created by the native workflow.

The entry screen includes product/SKU search, links to search eight known competitor
sites, a public product URL, a model selector, daily usage and recent requests.
This is assisted source research, not unattended web-wide discovery. It does not
claim to search the whole market. A blocked or redirected page is not bypassed.

## Evidence And Safety

- Authenticated active administrators only. Service credentials never reach the UI.
- Public HTTPS host allowlist, no credentials, query strings or private endpoints.
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
unchanged. Native limits are USD 0.25/day and 10 attempts/day, America/Santiago.

Reservations serialize under the existing market advisory lock. One native job
can run at a time. A request UUID plus canonical input hash prevents duplicate
dispatch. Interrupted reservations become unknown after two minutes, retain their
reserved amount and are never automatically retried. Sources rejected before an
inference settle at zero; unconfirmed provider usage retains its reservation.
Costs use configured conservative uncached rates, not a billing reconciliation.
Unlike the temporary worker pilot, the administrator workflow does not expire
after one hour or disable itself because a tariff review date is eight days old.
Tariffs must still be maintained when a provider changes prices.

## Verification And Deployment

Run:

```text
node --experimental-transform-types --test scripts/test-market-native.mjs
node --experimental-transform-types --test scripts/test-market-study.mjs scripts/test-market-study-security.mjs scripts/test-market-extraction.mjs scripts/test-market-research-api.mjs
node scripts/test-market-native-browser.mjs
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

Deployment is separate: backup the affected market schema/data and current Edge
bundle, apply the additive migration, deploy the standalone market-study bundle,
then publish frontend through the existing main/Dokploy pipeline. Do not recreate
the Supabase stack, alter credentials, change other functions or delete resources.
Live production verification must use the normal authenticated UI, not minted
sessions. A successful local test or push is not production verification.

The dependency audit at implementation reported existing advisories in unrelated
dependencies; none named the two added packages (linkedom and robots-parser).
No broad dependency upgrade or infrastructure cleanup is part of this release.
