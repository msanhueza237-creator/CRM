import assert from "node:assert/strict";
import test from "node:test";
import { FactoApiService } from "../src/facto-api-service.ts";
import { loadFactoApiConfig } from "../src/config.ts";
import { SafeLogger } from "../src/logger.ts";
import type { FactoConnectorConfig } from "../src/config.ts";

const config: FactoConnectorConfig["api"] = {
  baseUrl: "https://api-billing.example.test/V1",
  clientId: "client",
  clientSecret: "secret",
  resourceOwnerName: "owner",
  resourceOwnerPassword: "password",
  issuedFlag: "1",
  currencyMap: { "5": "USD", "38": "EUR", "39": "CLP" },
  timeoutMs: 5_000,
  maxRetries: 1,
  retryBaseMs: 1,
  maxRetryDelayMs: 1,
};

test("reintenta un 502 temporal y completa la lectura sin duplicar páginas", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/auth") && calls.length === 1) {
      return new Response("temporary", { status: 502, headers: { "retry-after": "0" } });
    }
    if (url.endsWith("/auth")) return Response.json({ access_token: "safe-test-token" });
    return Response.json({
      page_count: 1,
      total_items: 1,
      documents: [{
        document_id: "facto-1",
        document_type_taxbureau: 33,
        document_number: "1552",
        receiver_tax_id_code: "96.892.710-8",
        receiver_legal_name: "MALBEC COMERCIAL",
        issue_date: "2026-08-27",
        received_issued_flag: 1,
        currency_id: 39,
        net_amount: 2_861_195,
        taxes_amount: 543_629,
        total_amount: 3_404_824,
      }],
    });
  };
  try {
    const result = await new FactoApiService(config, new SafeLogger({ test: true })).readIssuedDocuments("2026-01-01", "2026-09-07");
    assert.equal(result.complete, true);
    assert.equal(result.documents.length, 1);
    assert.equal(result.documents[0].folio, "1552");
    assert.equal(calls.length, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("usa la dirección emitida y el catálogo monetario oficial por defecto", () => {
  const loaded = loadFactoApiConfig({
    FACTO_API_CLIENT_ID: "client",
    FACTO_API_CLIENT_SECRET: "secret",
    FACTO_API_RESOURCE_OWNER_NAME: "owner",
    FACTO_API_RESOURCE_OWNER_PASSWORD: "password",
  });
  assert.equal(loaded.baseUrl, "https://apifacto.com/v1");
  assert.equal(loaded.issuedFlag, "1");
  assert.deepEqual(loaded.currencyMap, { "5": "USD", "38": "EUR", "39": "CLP" });
});

test("no reintenta errores permanentes de autenticación", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("invalid", { status: 400 });
  };
  try {
    await assert.rejects(
      new FactoApiService(config, new SafeLogger({ test: true })).readIssuedDocuments("2026-01-01", "2026-09-07"),
      /autenticaci[oó]n \(400\)/i,
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("lee la colección HAL usada por el endpoint oficial actual", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    if (String(input).endsWith("/auth")) return Response.json({ access_token: "safe-test-token" });
    return Response.json({
      _links: { self: "/documents?page=1" },
      _embedded: {
        documents: [{
          document_id: "facto-hal-1",
          document_type_taxbureau: 33,
          document_number: "1552",
          receiver_tax_id_code: "96.892.710-8",
          receiver_legal_name: "MALBEC COMERCIAL",
          issue_date: "2026-08-27",
          received_issued_flag: 1,
          currency_id: 39,
          net_amount: "2861195",
          taxes_amount: "543629",
          total_amount: "3404824",
        }],
      },
      page_count: 1,
      page_size: 100,
      total_items: 1,
      page: 1,
    });
  };
  try {
    const result = await new FactoApiService(config, new SafeLogger({ test: true })).readIssuedDocuments("2026-01-01", "2026-09-07");
    assert.equal(result.complete, true);
    assert.equal(result.documents.length, 1);
    assert.equal(result.documents[0].externalId, "facto-hal-1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("limita localmente la fecha final si Facto ignora ese parámetro", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    if (String(input).endsWith("/auth")) return Response.json({ access_token: "safe-test-token" });
    return Response.json({
      _embedded: {
        documents: [
          document("facto-august", "2026-08-31"),
          document("facto-september", "2026-09-01"),
        ],
      },
      page_count: 1,
      total_items: 2,
    });
  };
  try {
    const result = await new FactoApiService(config, new SafeLogger({ test: true })).readIssuedDocuments("2026-08-01", "2026-08-31");
    assert.equal(result.complete, true);
    assert.deepEqual(result.documents.map((item) => item.externalId), ["facto-august"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function document(documentId: string, issueDate: string) {
  return {
    document_id: documentId,
    document_type_taxbureau: 33,
    document_number: "1552",
    receiver_tax_id_code: "96.892.710-8",
    receiver_legal_name: "MALBEC COMERCIAL",
    issue_date: issueDate,
    received_issued_flag: 1,
    currency_id: 39,
    net_amount: "2861195",
    taxes_amount: "543629",
    total_amount: "3404824",
  };
}
