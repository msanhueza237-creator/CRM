import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import ts from "typescript";
import { executeResearch, parseResearch, discoveryIdentity, RESEARCH_MODEL } from "../supabase/functions/crm-agent/prospecting-research.ts";
import { encryptApiKey } from "../supabase/functions/prospecting-integrations/deepseek.ts";

const secret = "fixture-master-secret-at-least-32-characters", key = "sk-fixture-not-real-do-not-send";
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const hit = (url, title = "Clima Andes") => ({ type: "web_search_result", title, url });
const body = hits => ({ model: RESEARCH_MODEL, content: [
  { type: "server_tool_use", name: "web_search", input: { query: "climatizacion Santiago" } },
  { type: "web_search_tool_result", content: hits },
  { type: "text", text: "Empresa inventada https://inventada.cl" },
], usage: { input_tokens: 100, output_tokens: 25 } });
const balance = (amount = "5") => ({ is_available: true, balance_infos: [{ currency: "USD", total_balance: amount }] });

test("API claim rejects old workers before assigning a run and stages candidates for v3", async () => {
  const source = await readFile(new URL("../supabase/functions/crm-agent/index.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true);
  const node = ast.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === "handleProspectingRoute");
  assert.ok(node);
  const js = ts.transpileModule(node.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const route = new Function("deps", `const {withProspectingIdempotency,readJsonObject,requiredString,boundedInteger,asObject,RequestValidationError,RESEARCH_CAPABILITY}=deps; ${js}; return handleProspectingRoute;`)({
    withProspectingIdempotency: async (_context, _validation, _action, _payload, run) => run(),
    readJsonObject: request => request.json(), requiredString: value => value,
    boundedInteger: (value, _min, _max, fallback) => value ?? fallback,
    asObject: value => value && typeof value === "object" ? value : {},
    RequestValidationError: Error, RESEARCH_CAPABILITY: "deepseek_research_v3",
  });
  const calls = [], run = { id: "run", snapshot: { campaign: { sources: ["deepseek_web"] } }, candidates_found: 0 };
  const supabase = { rpc: async name => {
    calls.push(name);
    return { data: name === "claim_prospecting_run" ? { run, tasks: [], lease_token: "lease" } : { candidates_found: 19 } };
  } };
  const request = capabilities => ({ req: new Request("https://fixture/claim", { method: "POST", body: JSON.stringify({ worker_id: "worker", capabilities }) }), supabase });
  await assert.rejects(route(request(["deepseek_candidates_v2"]), { key_id: "key" }, ["claim"]), /Actualiza el worker/);
  assert.equal(calls.length, 0);
  const result = await route(request(["deepseek_research_v3"]), { key_id: "key" }, ["claim"]);
  assert.deepEqual(calls, ["claim_prospecting_run", "stage_prospecting_discoveries"]);
  assert.equal(result.body.candidates_found, 19);
  assert.equal(result.body.snapshot.brave_disabled, true);
});

test("Pro native search uses real tool hits, balance preflight and an idempotent reservation", async () => {
  let audit, paid = 0;
  const store = { secret,
    reserve: async () => audit ?? { reservation_token: "fixture", kind: "discovery", task: { id: "task", keyword: "clima", comuna_name: "Santiago" }, snapshot: { campaign: {} } },
    credentials: async () => ({ status: "verified", models: [RESEARCH_MODEL], api_key_encrypted: await encryptApiKey(key, secret) }),
    finish: async (_, report) => (audit = report),
    send: async (url, init) => {
      assert.equal(new URL(url).host, "api.deepseek.com");
      if (url.endsWith("/balance")) return json(balance());
      paid++;
      const input = JSON.parse(init.body);
      assert.equal(input.model, "deepseek-v4-pro");
      assert.deepEqual(input.thinking, { type: "enabled" });
      assert.equal(input.output_config.effort, "high");
      assert.equal(input.tools[0].max_uses, 3);
      assert.equal(JSON.parse(input.messages[0].content).territory.comuna, "Santiago");
      return json(body([hit("https://climaandes.cl")]));
    },
  };
  const first = await executeResearch(store);
  assert.equal(first.status, "applied"); assert.equal(first.tokens, 125);
  assert.equal(first.balance_before_usd, 5); assert.equal(first.discoveries.length, 1);
  assert.equal(first.discoveries[0].phone, undefined);
  assert.ok(!JSON.stringify(first).includes(key) && !JSON.stringify(first).includes("inventada"));
  assert.deepEqual(await executeResearch(store), first); assert.equal(paid, 1);
  audit = { status: "limited", reason_code: "DAILY_LIMIT" };
  assert.equal((await executeResearch(store)).status, "limited"); assert.equal(paid, 1);
});

test("social business identities stay separate; untrusted text and private URLs never become candidates", () => {
  const result = parseResearch(body([
    hit("https://instagram.com/climauno/"), hit("https://www.instagram.com/climauno/reels/"),
    hit("https://instagram.com/climados/"), hit("https://facebook.com/profile.php?id=123"),
    hit("https://facebook.com/profile.php?id=456"), hit("https://facebook.com/login/"),
    hit("https://directorio.cl/empresa/1"), hit("https://directorio.cl/empresa/2"),
    hit("http://127.0.0.1/"), hit("http://169.254.169.254/latest/meta-data"),
  ]), "task");
  assert.equal(result.discoveries.length, 6);
  assert.equal(result.discoveries.filter(h => h.channel === "instagram").length, 2);
  for (const value of ["file:///etc/passwd", "https://x.local/", "https://x.cl:9000", "https://x:y@clima.cl/", "https://instagram.com/p/123"])
    assert.equal(discoveryIdentity(value), null);
  assert.throws(() => parseResearch({ content: [] }, "task"), /NO_WEB_SEARCH/);
  assert.equal(parseResearch(body([]), "task").discoveries.length, 0);
  assert.equal(parseResearch(body(Array.from({ length: 80 }, (_, i) => hit(`https://clima${i}.cl/`))), "t").discoveries.length, 60);
});

test("unavailable or low balance prevents any paid request and errors never expose the key", async () => {
  for (const reply of [balance("0.24"), { is_available: true }, balance("NaN")]) {
    let requests = 0;
    const result = await executeResearch({ secret,
      reserve: async () => ({ reservation_token: "fixture" }), finish: async (_, report) => report,
      credentials: async () => ({ status: "verified", models: [RESEARCH_MODEL], api_key_encrypted: await encryptApiKey(key, secret) }),
      send: async url => { requests++; assert.ok(url.endsWith("/balance")); return json(reply); },
    });
    assert.equal(result.status, "fallback"); assert.equal(requests, 1);
    assert.ok(!JSON.stringify(result).includes(key));
  }
});

test("SQL: full schema, staged candidates over 30, durable leases, replay, caps, pause and evidence guard", async () => {
  const db = new PGlite(); await db.waitReady;
  const sql = async file => (await readFile(new URL(`../supabase/${file}.sql`, import.meta.url), "utf8")).replace(/create extension if not exists\s+"?pgcrypto"?\s*;/gi, "");
  const uid = "11111111-1111-4111-8111-111111111111", api = "22222222-2222-4222-8222-222222222222";
  try {
    await db.exec(`create schema auth; create role anon; create role authenticated; create role service_role bypassrls;
      create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('app.uid',true),'')::uuid $$;
      create function auth.role() returns text language sql stable as $$ select coalesce(nullif(current_setting('app.role',true),''),'authenticated') $$;`);
    for (const file of ["schema", "prospecting_preflight", "agent_api_keys", "prospecting", "prospecting_high_precision_admission", "prospecting_enrichment", "prospecting_deepseek_search", "prospecting_discovery_candidates", "prospecting_contact_import"])
      await db.exec(await sql(file));
    await db.query("insert into auth.users values($1)", [uid]);
    await db.query("insert into profiles(id,full_name,role) values($1,'Test','administrador')", [uid]);
    await db.query("select set_config('app.uid',$1,false)", [uid]);
    const campaign = (await db.query(`insert into prospecting_campaigns(name,keywords,sources,region_codes,comuna_codes,candidate_limit,created_by)
      values('HVAC',array['clima','frio'],array['brave_search','official_website'],array['13'],array['13101'],1000,$1) returning id`, [uid])).rows[0].id;
    const old = (await db.query("select enqueue_prospecting_run($1,$2) result", [campaign, uid])).rows[0].result;
    await db.query("update prospecting_runs set status='cancelled' where id=$1", [old.id]);
    await db.exec(await sql("prospecting_native_research"));
    await db.exec(await sql("prospecting_native_research"));
    const config = (await db.query("select sources,deepseek_enabled from prospecting_campaigns where id=$1", [campaign])).rows[0];
    assert.ok(config.sources.includes("deepseek_web") && !config.sources.includes("brave_search"));
    assert.equal(config.deepseek_enabled, true);
    assert.ok((await db.query("select snapshot from prospecting_runs where id=$1", [old.id])).rows[0].snapshot.campaign.sources.includes("brave_search"));
    await db.query("select enqueue_prospecting_run($1,$2)", [campaign, uid]);
    const claim = (await db.query("select claim_prospecting_run($1,'worker',300) result", [api])).rows[0].result;
    const rid = claim.run.id, lease = claim.lease_token;
    const tasks = (await db.query("select id from prospecting_tasks where run_id=$1", [rid])).rows;
    assert.equal(tasks.length, 2);
    const reserve = async (operation, kind = "discovery", token = lease) => (await db.query("select reserve_native_prospecting_research($1,$2,$3,$4,'worker',$5) result", [rid, operation, kind, api, token])).rows[0].result;
    const finish = async (token, report) => (await db.query("select finish_native_prospecting_research($1,$2::jsonb) result", [token, JSON.stringify(report)])).rows[0].result;
    await assert.rejects(reserve(tasks[0].id, "discovery", api), /Invalid research lease/);
    await assert.rejects(reserve(old.id), /Invalid research task/);
    const one = await reserve(tasks[0].id); assert.ok(one.reservation_token);
    assert.equal((await reserve(tasks[0].id)).status, "preparing");
    const report = { status: "applied", mode: "native_research_v3", queries: ["clima"], web_requests: 1, tokens: 125,
      discoveries: Array.from({ length: 40 }, (_, i) => ({ name: `Clima ${i}`, website: `https://instagram.com/clima${i}`, source_url: `https://instagram.com/clima${i}/reels/`, task_id: tasks[0].id })) };
    const done = await finish(one.reservation_token, report);
    assert.equal(done.added, 40); assert.deepEqual(await reserve(tasks[0].id), done);
    assert.deepEqual(await finish(one.reservation_token, report), done);
    assert.equal((await db.query("select count(*)::int n from prospecting_campaign_candidates where run_id=$1", [rid])).rows[0].n, 40);
    assert.equal((await db.query("select count(*)::int n from prospect_enrichment_jobs where run_id=$1", [rid])).rows[0].n, 40);
    const row = (await db.query("select * from prospecting_campaign_candidates where run_id=$1 limit 1", [rid])).rows[0];
    assert.equal(row.candidate_snapshot.import_eligible, false); assert.deepEqual(row.candidate_snapshot.evidence, []);
    await db.query("update prospecting_campaign_candidates set review_status='approved' where id=$1", [row.id]).then(() => assert.fail("Unverified approval allowed"), error => assert.match(error.message, /valid|evid|approv/i));
    const jobClaim = (await db.query("select claim_prospect_enrichment($1,'worker',300) result", [api])).rows[0].result;
    const job = jobClaim.job;
    assert.ok(job, JSON.stringify(jobClaim));
    const v = await reserve(job.id, "validation", jobClaim.lease_token ?? job.lease_token); assert.ok(v.reservation_token);
    await finish(v.reservation_token, { status: "applied", discoveries: [], queries: ["oficial"] });
    const two = await reserve(tasks[1].id);
    await db.query("update prospecting_runs set status='paused' where id=$1", [rid]);
    await finish(two.reservation_token, { ...report, discoveries: [{ name: "Paused", website: "https://paused.cl", source_url: "https://paused.cl" }] });
    assert.equal((await db.query("select count(*)::int n from prospecting_campaign_candidates where run_id=$1", [rid])).rows[0].n, 40);
    await assert.rejects(reserve(tasks[1].id), /Invalid research lease/);
    await db.query("update prospecting_runs set status='running' where id=$1", [rid]);
    const addTask = async keyword => (await db.query("insert into prospecting_tasks(run_id,source,keyword,region_code,comuna_code) values($1,'deepseek_web',$2,'13','13101') returning id", [rid, keyword])).rows[0].id;
    for (let i = 0; i < 10; i++) {
      const id = await addTask("clima-" + i);
      const reserved = await reserve(id); assert.ok(reserved.reservation_token);
      if (i === 0) {
        await db.query("update prospecting_research_requests set created_at=now()-interval '4 minutes' where reservation_token=$1", [reserved.reservation_token]);
        assert.equal((await reserve(id)).reason_code, "INTERRUPTED");
        assert.equal((await finish(reserved.reservation_token, report)).reason_code, "INTERRUPTED");
      } else await finish(reserved.reservation_token, { status: "fallback", discoveries: [], reason_code: "PROVIDER_UNAVAILABLE" });
    }
    const cappedTask = await addTask("cap");
    assert.equal((await reserve(cappedTask)).reason_code, "RUN_LIMIT");
    const counts = (await db.query("select count(*)::int n from prospecting_research_requests")).rows[0].n;
    await db.query("insert into prospecting_research_requests(run_id,operation_id,kind,completed_at) select $1,gen_random_uuid(),'validation',now() from generate_series(1,$2::integer)", [rid, 20 - counts]);
    assert.equal((await reserve(cappedTask)).reason_code, "DAILY_LIMIT");
    await db.exec("set role authenticated");
    await assert.rejects(db.query("select * from prospecting_research_requests"), /permission denied/);
    await assert.rejects(reserve(tasks[0].id), /permission denied/);
    await db.exec("reset role");
  } finally { await db.close(); }
});
