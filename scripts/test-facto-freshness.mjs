import assert from "node:assert/strict";
import { buildFactoFreshness } from "../supabase/functions/accounting-center/facto-freshness.ts";
import { factoFreshnessLabel } from "../src/modules/accounting/factoFreshnessLabel.ts";
const now = Date.parse("2026-10-01T12:00:00Z");
const reading = "2026-10-01T10:00:00Z";
const success = { status: "completed", created_at: "2026-10-01T10:05:00Z", completed_at: "2026-10-01T10:10:00Z" };
function check(name, expected, read, latest, successful, connection = "connected") {
  const result = buildFactoFreshness(connection, read, latest, successful, now);
  assert.equal(result.state, expected, name);
  assert.equal(result.stale, expected !== "mirror_consolidated", name);
  assert.equal(result.accountingSyncedAt, successful?.status === "completed" ? new Date(successful.completed_at).toISOString() : null);
  console.log("PASS " + name);
}
check("no data", "unknown", null);
check("missing reading after success", "unknown", null, success, success);
check("recent mirror successfully consolidated", "mirror_consolidated", reading, success, success);
for (const status of ["failed", "cancelled", "partial", "running"]) {
  const latest = { status, created_at: "2026-10-01T11:00:00Z", completed_at: "2026-10-01T11:02:00Z" };
  check(status + " after success", status, reading, latest, success);
  check(status + " cannot become success", status, reading, latest, latest);
}
check("old reading even after consolidation", "old_reading", "2026-09-29T10:00:00Z", success, success);
check("new snapshot during successful run", "pending", "2026-10-01T10:07:00Z", success, success);
check("no completed run", "pending", reading);
check("connection failed", "unknown", reading, success, success, "error");
check("unknown connection", "unknown", reading, success, success, "unknown");
check("future reading", "unknown", "2026-10-02T10:00:00Z", success, success);
check("invalid reading", "unknown", "bad timestamp", success, success);
check("unknown latest status", "unknown", reading, { ...success, status: "surprise" }, success);
assert.equal(factoFreshnessLabel(undefined), "Actualización sin confirmar", "old backend must not imply success");
assert.equal(factoFreshnessLabel("surprise"), "Actualización sin confirmar");
