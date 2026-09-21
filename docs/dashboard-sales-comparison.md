# Annual sales comparison

The existing accounting `summary` and `bootstrap` responses now include optional
`dashboard.salesComparison`. The dashboard presents prior-year full-year sales,
both year-to-date totals, comparable growth and a twelve-month bar chart with a
document drill-down table. It rolls forward automatically with the business year.

## Data basis

- Reuses `dashboardSalesEvidence` and its validated Facto document policy.
- Net sales exclude VAT, include exempt amounts and deduct credit notes once,
  on their issue date. No journal income, cost or payment is generated.
- Reuses the existing complete document snapshot; no extra database reads.
- Compares the current month and YTD with the same cutoff in the prior year.
  Completed February compares with all of the prior February, including leap days.
- Retains full prior-year months and the annual total. The open month's full
  prior-year value is also accessible in the monthly table.
- Future current-year months are null, not zero or -100% growth.
- No documents means unknown coverage, not confirmed zero sales. A zero or
  negative baseline has an absolute difference but no percentage growth.
- Accounting regularizations remain in the existing financial result, not in
  this documentary comparison. Existing costs and margins are unchanged.
- Each amount links to `sales-period-net` with its exact date range. The same
  finance permissions apply; no new public endpoint is introduced.

## Verification

```powershell
node --experimental-strip-types --test scripts/test-dashboard-sales.mjs
node --experimental-strip-types scripts/test-dashboard-navigation.mjs
$env:DASHBOARD_UI_URL='http://127.0.0.1:5183'
node --experimental-strip-types scripts/test-dashboard-ui.mjs
node --experimental-strip-types scripts/test-dashboard-detail-ui.mjs
npm run build
```

UI fixtures cover administrator, finance and vendor access; desktop and mobile;
rendered chart pixels; partial-month links; missing/old backend responses; and
existing financial results. The prior-year sales drill-down explicitly extends
only the documentary sales date coverage; other metrics retain their original
coverage. End-to-end tests open the prior-year total and check its documents,
credit notes and unsupported date boundaries. Real-data totals were separately checked against
read-only source-document queries. Private verification files are not committed.

Release requires the frontend and `accounting-center` function together, including
`dashboard-sales-comparison.ts`. No migration, environment variable, new
credential or accounting data update is required. An older backend shows an
explicit unavailable state rather than fabricated historical amounts.
