# Reviewed merchandise cost returns

The Facto document view uses the existing cost importer for sales and a separate
review for credit notes. Both use the authenticated accounting service and the
existing journal posting and audit mechanisms. No database migration is needed.

`POST facto/cost-return-review` requires the accounting `post` permission.
Preview requests (`preview: true`) are read-only. Confirmation requires the
returned `reviewKey` and `confirmed: true`. An older backend cannot interpret
the new preview route as a legacy write. The old `facto/cost-entry` route rejects
unreviewed credit notes.

The review requires a validated, SII-accepted CLP note, one exact matching
invoice, balanced original cost, an open period, documented evidence and an
explicit confirmation that the goods physically returned and are saleable.
Damaged goods under review, estimates, inconsistent references, unbalanced
costs, drafts and existing note costs are not accepted. Confirmation reloads
the financial evidence and refuses a stale preview.

The entry debits inventory and credits cost of sales at the note's date. It
does not post revenue, VAT, payments, banks or physical stock movements.
Persisted source, date, status, amount and balanced lines are checked before
reporting success. The existing credit-note read model updates the dashboard
from this linked journal entry rather than subtracting the amount again.

## Conservative concurrency boundary

The controlled path uses `facto-cost-return:<invoiceId>` with the existing
database unique constraint on entity and idempotency key. Only one independent
controlled return can be registered per invoice through this version. Two
simultaneous notes cannot each consume the same original cost through this path.
A further note or an existing partial/reversed registration requires joint
reconciliation; it must not be forced with another key. Manual journal changes
remain a separate authorized accounting workflow.

The CRM does not read the Facto journal through its document API. Evidence of
the source journal and physical disposition must be independently verified by
the authorized reviewer. Do not use this screen to invent a reversal absent
from Facto, or to resolve a global adjustment without its document breakdown.

Tests: `node --experimental-strip-types --test scripts/test-facto-cost-return.mjs
scripts/test-facto-cost-evidence.mjs scripts/test-verified-facto-cost-ui.mjs
scripts/test-facto-posting-review.mjs scripts/test-dashboard-sales.mjs`.
