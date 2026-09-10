import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { assistProspectingClaim, discoverBusinesses, parseWebDiscovery, publicWebsite, SEARCH_MODEL } from "../supabase/functions/crm-agent/prospecting-assistance.ts";
import { encryptApiKey } from "../supabase/functions/prospecting-integrations/deepseek.ts";
import { prospectingReport } from "../supabase/functions/crm-copilot/prospecting-report.ts";

const secret = "fixture-master-secret-at-least-32-characters", key = "sk-fixture-not-real-do-not-send";
const snapshot = { deepseek_enabled: true, campaign: { keywords: ["climatizacion"], sources: ["brave_search", "official_website"], target_types: ["tecnico"], territories: [{ comuna_code: "13101" }] } };
const tasks = [{ id: "task-1", keyword: "climatizacion", source: "brave_search", comuna_code: "13101", max_results: 20 }];
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const hit = (url = "https://clima-uno.cl/", title = "Clima Uno") => ({ type: "web_search_result", url, title });
const responseBody = (hits = [hit()]) => ({ content: [
  { type: "server_tool_use", name: "web_search", input: { query: "empresas climatizacion Santiago Chile" } },
  { type: "web_search_tool_result", content: hits },
  { type: "text", text: 'Invented business https://inventada.cl/' },
], usage: { input_tokens: 500, output_tokens: 200, server_tool_use: { web_search_requests: 1 } } });

test("native web discovery preserves tasks and scope, audits once, and never forwards credentials", async () => {
  let calls = 0, audit;
  const store = { secret, webDiscoverySupported: true,
    reserve: async () => audit ?? { reservation_token: "fixture" },
    finish: async (_, report) => { audit = report; return report; },
    credentials: async () => ({ status: "verified", models: [SEARCH_MODEL], api_key_encrypted: await encryptApiKey(key, secret) }),
    send: async (url, init) => {
      calls++; assert.equal(url, "https://api.deepseek.com/anthropic/v1/messages");
      assert.equal(init.redirect, "error"); assert.equal(init.headers["x-api-key"], key);
      const body = JSON.parse(init.body); assert.equal(body.model, SEARCH_MODEL);
      assert.equal(body.tools[0].name, "web_search"); assert.equal(body.tools[0].max_uses, 3);
      const input = JSON.parse(body.messages[0].content);
      assert.deepEqual(input.territories, snapshot.campaign.territories);
      assert.ok(!JSON.stringify(body).includes(key));
      return json(responseBody());
    } };
  const result = await assistProspectingClaim(snapshot, tasks, store);
  assert.equal(result.tasks, tasks); assert.equal(result.snapshot.campaign, snapshot.campaign);
  assert.equal(snapshot.deepseek_discoveries, undefined);
  assert.equal(result.snapshot.deepseek_discoveries.length, 1);
  assert.equal(result.snapshot.deepseek_discoveries[0].task_id, tasks[0].id);
  assert.equal(result.snapshot.deepseek_discoveries[0].phone, undefined);
  assert.equal(result.snapshot.deepseek_discoveries[0].evidence, undefined);
  assert.deepEqual(await assistProspectingClaim(snapshot, tasks, store), result);
  assert.equal(calls, 1); assert.equal(audit.tokens, 700); assert.equal(audit.mode, "web_discovery_v1");
  assert.ok(!JSON.stringify(audit).includes(key));
  assert.equal((await assistProspectingClaim({ ...snapshot, deepseek_enabled: false }, tasks, store)).snapshot.deepseek_discoveries, undefined);
  assert.equal((await assistProspectingClaim(snapshot, tasks, { ...store, webDiscoverySupported: false })).tasks, tasks);
  assert.equal(calls, 1);
});

test("only actual tool results count, unsafe URLs and duplicate hosts are rejected, output is bounded", () => {
  const parsed = parseWebDiscovery(responseBody([hit(), hit("https://www.clima-uno.cl/contacto"), hit("http://127.0.0.1/"), hit("http://user:pass@clima.cl/"), hit("https://internal.local/")]), "task-1");
  assert.equal(parsed.discoveries.length, 1);
  assert.ok(!JSON.stringify(parsed).includes("inventada"));
  assert.equal(parseWebDiscovery(responseBody(Array.from({ length: 100 }, (_, i) => hit(`https://clima${i}.cl/`))), "task-1").discoveries.length, 30);
  for (const url of ["file:///etc/passwd", "http://[::1]/", "http://169.254.169.254/", "javascript:alert(1)", "https://x.cl:9000", "https://x.test/"])
    assert.equal(publicWebsite(url), null);
  assert.throws(() => parseWebDiscovery({ content: [{ type: "text", text: "Empresas reales..." }] }, "x"), /NO_WEB_SEARCH/);
  const failed = responseBody(); failed.content[1].content = { type: "web_search_tool_result_error", error_code: "unavailable" };
  assert.throws(() => parseWebDiscovery(failed, "x"), /WEB_SEARCH_FAILED/);
  assert.equal(parseWebDiscovery(responseBody([]), "x").discoveries.length, 0);
});

test("failures are redacted, no paid calls without credentials or after daily cap", async () => {
  for (const status of [402, 429, 401, 500, 200]) {
    let report;
    const result = await assistProspectingClaim(snapshot, tasks, { secret, webDiscoverySupported: true,
      reserve: async () => ({ reservation_token: "x" }), finish: async (_, r) => { report = r; return r; },
      credentials: async () => ({ status: "verified", models: [SEARCH_MODEL], api_key_encrypted: await encryptApiKey(key, secret) }),
      send: async () => json({ error: key }, status) });
    assert.equal(result.tasks, tasks); assert.equal(report.status, "fallback");
    assert.ok(!JSON.stringify(report).includes(key));
  }
  let read = 0;
  const store = { secret, webDiscoverySupported: true, reserve: async () => ({ status: "fallback", reason_code: "DAILY_LIMIT" }),
    finish: async (_, r) => r, credentials: async () => { read++; return {}; }, send: async () => assert.fail("No paid call") };
  await assistProspectingClaim(snapshot, tasks, store); assert.equal(read, 0);
  store.reserve = async () => ({ reservation_token: "x" });
  await assistProspectingClaim(snapshot, tasks, store); assert.equal(read, 1);
  await assert.rejects(discoverBusinesses(key, snapshot.campaign, tasks[0], async () => { throw new Error(key); }), /PROVIDER_UNAVAILABLE/);
});

test("SQL: opt-in snapshots, versions, lease checks, private reservations, retries and daily cap", async () => {
  const db = new PGlite(); await db.waitReady;
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create table prospecting_campaigns(id uuid primary key default gen_random_uuid(), version integer not null default 1);
      create table prospecting_runs(id uuid primary key default gen_random_uuid(), campaign_id uuid references prospecting_campaigns,
        snapshot jsonb not null default '{}', claimed_by_api_key uuid, claimed_by_worker text, lease_token uuid,
        status text not null default 'running', lease_expires_at timestamptz default now()+interval '2 minutes');`);
    const migration = await readFile(new URL("../supabase/prospecting_deepseek_search.sql", import.meta.url), "utf8");
    await db.exec(migration); await db.exec(migration);
    const cid = (await db.query("insert into prospecting_campaigns default values returning id")).rows[0].id;
    const api = "22222222-2222-4222-8222-222222222222", token = "33333333-3333-4333-8333-333333333333";
    const create = async () => (await db.query("insert into prospecting_runs(campaign_id,claimed_by_api_key,claimed_by_worker,lease_token) values($1,$2,'worker',$3) returning *", [cid, api, token])).rows[0];
    const reserve = async (id, lease = token) => (await db.query("select reserve_prospecting_search_assistance($1,$2,'worker',$3) as value", [id, api, lease])).rows[0].value;
    const finish = async (id, reservation, report) => (await db.query("select finish_prospecting_search_assistance($1,$2,$3::jsonb) as value", [id, reservation, JSON.stringify(report)])).rows[0].value;
    const old = await create(); assert.equal(old.snapshot.deepseek_enabled, false);
    assert.equal((await reserve(old.id)).status, "disabled");
    const version = (await db.query("update prospecting_campaigns set deepseek_enabled=true where id=$1 returning version", [cid])).rows[0].version;
    assert.equal(version, 2);
    assert.equal((await db.query("select snapshot from prospecting_runs where id=$1", [old.id])).rows[0].snapshot.deepseek_enabled, false);
    const run = await create(); assert.equal(run.snapshot.deepseek_enabled, true);
    await assert.rejects(reserve(run.id, api), /Invalid active run lease/);
    const first = await reserve(run.id); assert.ok(first.reservation_token);
    assert.equal((await reserve(run.id)).reason_code, "INTERRUPTED");
    assert.equal((await finish(run.id, first.reservation_token, { status: "applied" })).status, "fallback");
    for (let i = 1; i < 20; i++) {
      const next = await create(), reservation = await reserve(next.id); assert.ok(reservation.reservation_token);
      const report = await finish(next.id, reservation.reservation_token, { status: "applied", queries: [], tokens: 20 });
      assert.equal((await reserve(next.id)).status, "applied"); assert.ok(report.completed_at);
    }
    const limited = await create(); assert.equal((await reserve(limited.id)).reason_code, "DAILY_LIMIT");
    const expired = await create(); await db.query("update prospecting_runs set lease_expires_at=now()-interval '1 minute' where id=$1", [expired.id]);
    await assert.rejects(reserve(expired.id), /Invalid active run lease/);
    const exposed = (await db.query("select search_assistance from prospecting_runs")).rows;
    assert.ok(!JSON.stringify(exposed).includes("reservation_token"));
    await db.exec("set role authenticated");
    await assert.rejects(db.query("select * from prospecting_search_reservations"), /permission denied/);
    await assert.rejects(reserve(run.id), /permission denied/);
    await assert.rejects(finish(run.id, token, { status: "applied" }), /permission denied/);
    await db.exec("reset role");
  } finally { await db.close(); }
});

test("Copilot reads actual run status and active evidence, with strict run/campaign filters and no writes", async () => {
  const runId = "33333333-3333-4333-8333-333333333333", campaignId = "44444444-4444-4444-8444-444444444444";
  const paths = [];
  const source = { all: async path => {
    paths.push(path); assert.ok(!path.includes("integrations") && !path.includes("reservations"));
    if (path.startsWith("prospecting_campaigns?")) return [{ id: campaignId, name: "Santiago HVAC", deepseek_enabled: true, keywords: ["climatizacion"] }];
    if (path.startsWith("prospecting_runs?")) return [{ id: runId, campaign_id: campaignId, status: "running", candidates_found: 1, total_tasks: 2, completed_tasks: 1, snapshot: { deepseek_enabled: true }, search_assistance: { status: "fallback", reason_code: "RATE_LIMIT" } }];
    if (path.startsWith("prospecting_campaign_candidates?")) { assert.ok(path.includes(`run_id=eq.${runId}`)); return [{ id: "candidate", entity_id: "entity", review_status: "pending", score: 80 }]; }
    if (path.startsWith("active_prospect_source_records?")) { assert.ok(path.includes(`run_id=eq.${runId}`)); return [{ id: "evidence", entity_id: "entity", provider: "official_website", source_url: "https://fixture.invalid" }]; }
    if (path.startsWith("prospect_entities?")) return [{ id: "entity", name: "Clima Uno", business_line: "HVAC" }];
    assert.fail(path);
  } };
  const runReport = await prospectingReport(source, { view: "runs", query: "Santiago" });
  assert.equal(runReport.table.rows[0].deepseek, "DeepSeek no disponible; otras fuentes continuan");
  assert.equal(runReport.table.rows[0].assistance_reason, "RATE_LIMIT");
  assert.equal((await prospectingReport(source, { view: "runs", query: "Valdivia" })).coverage.totalMatched, 0);
  const report = await prospectingReport(source, { view: "candidates", run_id: runId, campaign_id: campaignId, query: "Clima" });
  assert.equal(report.table.rows[0].name, "Clima Uno"); assert.equal(report.table.rows[0].review_status, "pending");
  assert.equal(report.table.rows[0].official_evidence_count, 1);
  assert.match(report.evidence[0].path, /view=candidates/);
  await assert.rejects(prospectingReport(source, { view: "candidates" }), /run_id/);
  await assert.rejects(prospectingReport(source, { view: "candidates", run_id: "x&select=*" }), /invalido/);
  await assert.rejects(prospectingReport(source, { view: "candidates", run_id: runId, campaign_id: runId }), /no pertenece/);
});
