import assert from "node:assert/strict";
import { test } from "node:test";
import { requestHistoricalPreview } from "../src/modules/prospecting/historicalImportTransport.ts";

const file = new File(["Razón social;Email\nEmpresa;ventas@example.com"], "clientes.csv");
const preview = { filename: file.name, sha256: "a".repeat(64), sheets: ["CSV"],
  rows: [{ legal_name: "Empresa" }], preview: [{ legal_name: "Empresa" }], stats: { entities: 1 } };
const input = { file, relationshipDate: "2026-10-07", serviceUrl: "https://import.example.com",
  accessToken: "synthetic-session" };

test("sends the session and multipart file to HTTPS, without cookies or redirect following", async () => {
  let calls = 0;
  const result = await requestHistoricalPreview({ ...input, fetcher: async (url, options) => {
    calls++;
    assert.equal(String(url), "https://import.example.com/api/historical-imports/preview?relationship_date=2026-10-07");
    assert.equal(options.headers.Authorization, "Bearer synthetic-session");
    assert.equal(options.headers["Content-Type"], undefined);
    assert.equal(options.body.get("file").name, "clientes.csv");
    assert.equal(options.credentials, "omit");
    assert.equal(options.redirect, "error");
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json(preview);
  } });
  assert.equal(calls, 1);
  assert.deepEqual(result, preview);
});

for (const serviceUrl of [undefined, "", "http://localhost:8000", "https://localhost", "https://127.0.0.1",
  "https://user:password@import.example.com", "https://import.example.com/path", "https://import.example.com?token=x"]) {
  test(`rejects unsafe or missing service configuration: ${serviceUrl}`, async () => {
    await assert.rejects(requestHistoricalPreview({ ...input, serviceUrl,
      fetcher: () => assert.fail("Must not contact any service") }));
  });
}

for (const patch of [{ accessToken: "" }, { relationshipDate: "2026-02-30" },
  { file: new File(["test"], "malware.exe") },
  { file: new File([new Uint8Array(25 * 1024 * 1024 + 1)], "large.csv") }]) {
  test(`rejects invalid input before upload: ${Object.keys(patch)[0]} ${patch.file?.name || ""}`, async () => {
    await assert.rejects(requestHistoricalPreview({ ...input, ...patch,
      fetcher: () => assert.fail("Must not upload rejected inputs") }));
  });
}

for (const [status, message] of [[401, /sesión expiró/], [403, /permiso/], [413, /25 MB/], [503, /no está disponible/]]) {
  test(`shows useful error for HTTP ${status}`, async () => {
    await assert.rejects(requestHistoricalPreview({ ...input,
      fetcher: async () => new Response("", { status }) }), message);
  });
}
test("rejects SPA HTML instead of treating it as an import preview", async () => {
  await assert.rejects(requestHistoricalPreview({ ...input,
    fetcher: async () => new Response("<html>CRM</html>") }), /respuesta no válida/);
});
test("network failure gives a remote-service error without suggesting a local agent", async () => {
  await assert.rejects(requestHistoricalPreview({ ...input,
    fetcher: async () => { throw new TypeError("Failed to fetch"); } }), /servicio de importación/);
});
