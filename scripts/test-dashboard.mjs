import assert from "node:assert/strict";
import { test } from "node:test";
import { reportPeriod, incomeReportLink } from "../src/modules/accounting/reportNavigation.ts";

test("El acceso al informe conserva fechas y tipo de informe", () => {
  const url = new URL(incomeReportLink("2026-08-01", "2026-08-31"), "https://example.invalid");
  assert.equal(url.searchParams.get("report"), "income");
  assert.equal(url.searchParams.get("view"), "reports");
  assert.deepEqual(reportPeriod(url.searchParams, "2026-01-01", "2026-09-08"), { from: "2026-08-01", to: "2026-08-31" });
});
test("Fechas invalidas, invertidas o incompletas no alteran el informe", () => {
  for (const query of ["from=2026-02-30&to=2026-03-01", "from=2026-09-01&to=2026-08-01", "from=no&to=no", "from=2026-01-01", ""]) {
    assert.deepEqual(reportPeriod(new URLSearchParams(query), "2026-01-01", "2026-09-08"), { from: "2026-01-01", to: "2026-09-08" });
  }
});
