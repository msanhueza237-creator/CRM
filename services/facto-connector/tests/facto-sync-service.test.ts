import assert from "node:assert/strict";
import test from "node:test";
import { FactoSyncService } from "../src/facto-sync-service.ts";
import { SafeLogger } from "../src/logger.ts";
import type { FactoApiReader, FactoBrowserReader } from "../src/types.ts";

test("el coordinador consulta primero la API y después la cartera web", async () => {
  const calls: string[] = [];
  const api: FactoApiReader = {
    async readIssuedDocuments(fromDate, toDate) {
      calls.push(`api:${fromDate}:${toDate}`);
      return { documents: [], pageCount: 1, pagesRead: 1, totalItems: 0, issuedFlag: "1", complete: true };
    },
  };
  const browser: FactoBrowserReader = {
    async readUnpaidDocuments(fromDate, toDate) {
      calls.push(`browser:${fromDate}:${toDate}`);
      return {
        section: "Documentos impagos",
        rows: [],
        pagesRead: 1,
        expectedRows: 0,
        complete: true,
        verifiedZero: true,
        warnings: [],
      };
    },
  };

  const service = new FactoSyncService(api, browser, new SafeLogger({ test: true }));
  const preview = await service.previewReceivables("2026-01-01", "2026-09-07");

  assert.deepEqual(calls, ["api:2026-01-01:2026-09-07", "browser:2026-01-01:2026-09-07"]);
  assert.equal(preview.coverage.complete, true);
  assert.equal(preview.coverage.verified_zero, true);
  assert.equal(preview.items.length, 0);
});

test("rechaza períodos futuros antes de consultar sistemas externos", async () => {
  const calls: string[] = [];
  const api: FactoApiReader = {
    async readIssuedDocuments() {
      calls.push("api");
      throw new Error("no debería ejecutarse");
    },
  };
  const browser: FactoBrowserReader = {
    async readUnpaidDocuments() {
      calls.push("browser");
      throw new Error("no debería ejecutarse");
    },
  };
  const service = new FactoSyncService(api, browser, new SafeLogger({ test: true }));

  await assert.rejects(
    service.previewReceivables("2099-01-01", "2099-02-01"),
    /futuro/i,
  );
  assert.deepEqual(calls, []);
});
