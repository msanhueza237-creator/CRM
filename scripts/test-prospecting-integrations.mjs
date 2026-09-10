import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { createProspectingIntegrationHandler } from "../supabase/functions/prospecting-integrations/handler.ts";
import { encryptApiKey, decryptApiKey, validateApiKey, verifyDeepSeekKey } from "../supabase/functions/prospecting-integrations/deepseek.ts";

const secret = "fixture-master-secret-32-characters-minimum";
const key = "sk-fixture-not-a-real-deepseek-key";
const userId = "11111111-1111-4111-8111-111111111111";
const config = { supabaseUrl: "https://db.example.invalid", serviceRoleKey: "fixture-service-key", encryptionSecret: secret, appOrigin: "https://crm.example.invalid" };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function fixture(options = {}) {
  const state = { row: options.row, calls: [], writes: [], role: options.role ?? "administrador", active: options.active ?? true, providerStatus: 200, ...options };
  const send = async (input, init = {}) => {
    const url = new URL(String(input));
    state.calls.push({ url: url.href, ...init });
    if (url.href === "https://api.deepseek.com/models") {
      assert.equal(init.method, "GET");
      assert.equal(init.redirect, "error");
      assert.equal(init.headers.Authorization, `Bearer ${key}`);
      if (state.onProvider) await state.onProvider();
      return state.providerStatus === 200 ? json({ data: [{ id: "model-fixture" }] }) : json({ error: key }, state.providerStatus);
    }
    assert.equal(url.origin, config.supabaseUrl);
    if (url.pathname === "/auth/v1/user") return json({ id: userId }, state.authStatus ?? 200);
    if (url.pathname === "/rest/v1/profiles") return json([{ id: userId, role: state.role, active: state.active }]);
    assert.equal(url.pathname, "/rest/v1/prospecting_ai_integrations");
    if (state.storageError) return json({}, 503);
    if (init.method === "GET") return json(state.row ? [state.row] : []);
    const body = JSON.parse(init.body);
    state.writes.push(body);
    if (init.method === "POST") state.row = { ...body };
    else {
      assert.equal(init.method, "PATCH");
      if (url.searchParams.get("updated_at") === `eq.${state.row?.updated_at}`) state.row = { ...state.row, ...body };
    }
    return new Response(null, { status: 204 });
  };
  const handler = createProspectingIntegrationHandler({ ...config, ...(options.config ?? {}) }, send);
  const request = async (action = "status", body, overrides = {}) => {
    const response = await handler(new Request(`https://db.example.invalid/functions/v1/prospecting-integrations/${action}`, {
      method: action === "status" ? "GET" : "POST",
      headers: { Authorization: "Bearer fixture-session", Origin: config.appOrigin, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...overrides,
    }));
    const text = await response.text();
    assert.equal(text.includes(key), false, "raw provider key must never appear in responses");
    assert.equal(text.includes("api_key_encrypted"), false);
    return { response, body: text ? JSON.parse(text) : null };
  };
  return { state, request };
}
async function connected() {
  return { provider: "deepseek", api_key_encrypted: await encryptApiKey(key, secret), status: "verified", models: ["model-fixture"], updated_at: "2026-09-09T00:00:00Z" };
}

test("encrypted key roundtrip, random nonces, tamper and server-secret failures", async () => {
  const a = await encryptApiKey(key, secret), b = await encryptApiKey(key, secret);
  assert.notEqual(a, b); assert.ok(!a.includes(key));
  assert.equal(await decryptApiKey(a, secret), key);
  await assert.rejects(decryptApiKey(a, secret + "wrong"), error => error.code === "KEY_UNREADABLE");
  await assert.rejects(decryptApiKey(a.replace("v1.", "v2."), secret), error => error.code === "KEY_UNREADABLE");
  await assert.rejects(encryptApiKey(key, "short"), error => error.code === "SETUP_REQUIRED");
  for (const input of [undefined, "short", "abc\r\nAuthorization: injected", "x".repeat(513)]) assert.throws(() => validateApiKey(input));
  assert.equal(validateApiKey(` ${key} `), key);
});

test("server verifies active administrators before touching storage or provider", async () => {
  for (const options of [{ role: "vendedor" }, { role: "visualizador" }, { role: "finanzas" }, { active: false }, { authStatus: 401 }]) {
    const f = fixture(options);
    const result = await f.request("save", { apiKey: key });
    assert.equal(result.response.status, options.authStatus ?? 403);
    assert.ok(!f.state.calls.some(c => c.url.includes("prospecting_ai_integrations") || c.url.includes("api.deepseek.com")));
  }
  const f = fixture();
  assert.equal((await f.request("status", undefined, { headers: {} })).response.status, 401);
  assert.equal((await f.request("save", {}, { headers: { Origin: "https://evil.example.invalid" } })).response.status, 403);
  assert.equal(f.state.calls.length, 0);
});

test("status is redacted and cache-disabled, and does not contact DeepSeek", async () => {
  const f = fixture({ row: await connected() });
  const { body, response } = await f.request();
  assert.equal(body.configured, true); assert.equal(body.scope, "credentials_only");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.ok(!JSON.stringify(body).includes(f.state.row.api_key_encrypted));
  assert.equal(f.state.writes.length, 0);
  assert.ok(!f.state.calls.some(c => c.url.includes("deepseek.com")));
});

test("save calls models only, encrypts after verification, and replacement failure preserves previous credential", async () => {
  const f = fixture();
  const result = await f.request("save", { apiKey: key });
  assert.equal(result.response.status, 200); assert.equal(result.body.status, "verified");
  assert.equal(await decryptApiKey(f.state.row.api_key_encrypted, secret), key);
  assert.equal(f.state.writes.length, 1);
  assert.equal(JSON.stringify(f.state.writes).includes(key), false);
  const saved = { ...f.state.row };
  for (const code of [401, 403, 402, 429, 500]) {
    f.state.providerStatus = code;
    const invalid = await f.request("save", { apiKey: key });
    assert.ok(invalid.response.status >= 400);
    assert.deepEqual(f.state.row, saved);
    assert.equal(f.state.writes.length, 1);
  }
});

test("missing server installation fails closed and oversized/invalid keys never reach provider", async () => {
  const f = fixture({ config: { encryptionSecret: "" } });
  assert.equal((await f.request()).body.ready, false);
  assert.equal((await f.request("save", { apiKey: key })).body.code, "SETUP_REQUIRED");
  const broken = fixture({ storageError: true });
  assert.equal((await broken.request()).body.code, "STORAGE_UNAVAILABLE");
  const malformed = fixture();
  assert.equal((await malformed.request("save", { apiKey: "x".repeat(5000) })).response.status, 413);
  assert.equal((await malformed.request("save", { apiKey: "short" })).response.status, 400);
  assert.ok(!malformed.state.calls.some(c => c.url.includes("api.deepseek.com")));
});

test("verify decrypts server-side, records failure, and disconnect clears saved key without external calls", async () => {
  const f = fixture({ row: await connected() });
  assert.equal((await f.request("verify")).body.status, "verified");
  f.state.providerStatus = 401;
  assert.equal((await f.request("verify")).body.code, "KEY_REJECTED");
  assert.equal((await f.request()).body.status, "error");
  assert.equal(f.state.row.last_error_code, "KEY_REJECTED");
  const providerCalls = f.state.calls.filter(c => c.url.includes("deepseek.com")).length;
  assert.equal((await f.request("disconnect")).body.configured, false);
  assert.equal(f.state.row.api_key_encrypted, null); assert.deepEqual(f.state.row.models, []);
  assert.equal((await f.request("verify")).body.code, "NOT_CONFIGURED");
  assert.equal(f.state.calls.filter(c => c.url.includes("deepseek.com")).length, providerCalls);
});

test("a slow verify cannot revive a concurrently disconnected key", async () => {
  const f = fixture({ row: await connected() });
  f.state.onProvider = async () => { await f.request("disconnect"); };
  assert.equal((await f.request("verify")).body.status, "disconnected");
  assert.equal(f.state.row.api_key_encrypted, null);
});

test("provider redirects/network failures and malformed responses are sanitized", async () => {
  await assert.rejects(verifyDeepSeekKey(key, async () => { throw new Error(key); }), error => error.code === "PROVIDER_UNAVAILABLE" && !error.message.includes(key));
  for (const body of [null, {}, { data: [] }, { data: [{ id: "<script>" }] }, { data: [{ id: "x".repeat(129) }] }]) {
    await assert.rejects(verifyDeepSeekKey(key, async () => json(body)), error => error.code === "INVALID_PROVIDER_RESPONSE");
  }
  await assert.rejects(verifyDeepSeekKey(key, async () => json({ data: "x".repeat(33000) })), error => error.code === "INVALID_PROVIDER_RESPONSE");
});

test("SQL is idempotent and secrets are inaccessible to browser database roles", async () => {
  const db = new PGlite();
  try {
    await db.exec("create role anon; create role authenticated; create role service_role bypassrls; create table public.profiles(id uuid primary key);");
    const sql = await readFile(new URL("../supabase/prospecting_deepseek_settings.sql", import.meta.url), "utf8");
    await db.exec(sql); await db.exec(sql);
    await db.exec("set role service_role; insert into prospecting_ai_integrations(provider, api_key_encrypted) values ('deepseek','fixture-ciphertext'); reset role;");
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`set role ${role}`);
      await assert.rejects(db.query("select * from prospecting_ai_integrations"), /permission denied/);
      await assert.rejects(db.exec("update prospecting_ai_integrations set api_key_encrypted='replacement'"), /permission denied/);
      await db.exec("reset role");
    }
    assert.equal((await db.query("select api_key_encrypted from prospecting_ai_integrations")).rows[0].api_key_encrypted, "fixture-ciphertext");
  } finally { await db.close(); }
});
