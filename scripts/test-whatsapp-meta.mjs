import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import ts from "typescript";
import { describeMetaTemplate, buildMetaTemplateMessage, listMetaTemplates, whatsappDispatchId } from "../supabase/functions/crm-agent/whatsapp-meta.ts";
import { dispatchWhatsAppCampaign, getWhatsAppTemplates } from "../supabase/functions/crm-agent/whatsapp-dispatch.ts";

const rawTemplate = { id: "t1", name: "super_stars_catalogo", language: "es_CL", status: "APPROVED", category: "MARKETING",
  components: [{ type: "BODY", text: "Herramientas Super Stars" }, { type: "BUTTONS", buttons: [{ type: "CATALOG", text: "Ver catalogo" }] }] };
const campaignId = "00000000-0000-4000-8000-000000000001";
const company = { id: "c1", whatsapp: "+56912345678", whatsapp_opt_in: true, whatsapp_status: "opt_in" };
const payload = { campaignId, templateId: "t1", language: "es_CL", confirmSend: true, recipients: [{ companyId: "c1", phone: company.whatsapp, parameters: [] }] };
const defaultEnv = { META_WHATSAPP_ACCESS_TOKEN: "private-test", META_WHATSAPP_PHONE_NUMBER_ID: "p1", META_WHATSAPP_BUSINESS_ACCOUNT_ID: "b1", META_WHATSAPP_PRODUCTION_APPROVED: "true", META_WHATSAPP_APP_SECRET: "test", META_WHATSAPP_WEBHOOK_VERIFY_TOKEN: "test" };
const env = (overrides = {}) => (names) => names.map((n) => ({ ...defaultEnv, ...overrides })[n]).find(Boolean) || "";

function fakeDb(overrides = {}) {
  const tables = { whatsapp_settings: [{ active: true, phone_number_id: "p1", business_account_id: "b1" }], companies: [{ ...company }], campaigns: [{ id: campaignId, type: "whatsapp", status: "borrador" }], whatsapp_messages: [], interactions: [], ...overrides };
  return { tables, from(table) {
    const filters = []; let op = "select", value;
    const q = { select() { return q; }, order() { return q; }, limit() { return q; },
      eq(k, v) { filters.push((r) => r[k] === v); return q; }, in(k, values) { filters.push((r) => values.includes(r[k])); return q; },
      insert(v) { op = "insert"; value = v; return q; }, update(v) { op = "update"; value = v; return q; },
      maybeSingle() { return q.then((r) => ({ ...r, data: r.data?.[0] || null })); },
      then(resolve, reject) { return Promise.resolve().then(() => {
        if (!tables[table]) return { data: null, error: { code: "missing" } };
        if (op === "insert") {
          if (value.id && tables[table].some((r) => r.id === value.id)) return { data: null, error: { code: "23505" } };
          tables[table].push({ ...value }); return { data: null, error: null };
        }
        const selected = tables[table].filter((r) => filters.every((f) => f(r)));
        if (op === "update") selected.forEach((r) => Object.assign(r, value));
        return { data: selected.map((r) => ({ ...r })), error: null };
      }).then(resolve, reject); },
    }; return q;
  } };
}
function graph(template = rawTemplate, sendResponse) {
  const posts = [];
  return { posts, request: async (url, options) => {
    if (options?.method === "POST") { posts.push(JSON.parse(options.body)); return sendResponse ? sendResponse(posts.length) : Response.json({ messages: [{ id: `wamid.${posts.length}` }] }); }
    assert.match(String(url), /graph\.facebook\.com/);
    return Response.json({ data: [template] });
  } };
}

test("catalog template uses exact locale, no fabricated variables", () => {
  const body = buildMetaTemplateMessage(describeMetaTemplate(rawTemplate), "56912345678", []);
  assert.equal(body.template.language.code, "es_CL");
  assert.deepEqual(body.template.components, [{ type: "button", sub_type: "CATALOG", index: 0 }]);
  assert.throws(() => buildMetaTemplateMessage(describeMetaTemplate(rawTemplate), "56912345678", ["invented"]));
});
test("variables and unsupported components fail closed", () => {
  const template = describeMetaTemplate({ ...rawTemplate, components: [{ type: "BODY", text: "Hola {{1}} {{2}}" }] });
  assert.throws(() => buildMetaTemplateMessage(template, "123", ["a", "b"]));
  assert.throws(() => buildMetaTemplateMessage(template, "56912345678", ["a"]));
  assert.equal(buildMetaTemplateMessage(template, "56912345678", ["a", "b"]).template.components[0].parameters.length, 2);
  for (const component of [{ type: "HEADER", format: "IMAGE" }, { type: "BUTTONS", buttons: [{ type: "URL", url: "https://a/{{1}}" }] }]) {
    assert.ok(describeMetaTemplate({ ...rawTemplate, components: [...rawTemplate.components, component] }).blockedReason);
  }
});
test("named variables and optional catalog thumbnail", () => {
  const template = describeMetaTemplate({ ...rawTemplate, parameter_format: "NAMED", components: [{ type: "BODY", text: "Hola {{nombre}}" }] });
  assert.equal(buildMetaTemplateMessage(template, "56912345678", ["Ana"]).template.components[0].parameters[0].parameter_name, "nombre");
  assert.equal(buildMetaTemplateMessage(describeMetaTemplate(rawTemplate), "56912345678", [], "SKU").template.components[0].parameters[0].action.thumbnail_product_retailer_id, "SKU");
});
test("pagination reconstructs trusted URL and rejects partial reports", async () => {
  let n = 0;
  const templates = await listMetaTemplates({ token: "secret", wabaId: "b1", version: "v26.0" }, async (url) => {
    assert.equal(url.hostname, "graph.facebook.com"); assert.equal(url.searchParams.has("access_token"), false);
    return Response.json(++n === 1 ? { data: [rawTemplate], paging: { next: "https://untrusted.test/?access_token=secret", cursors: { after: "next" } } } : { data: [{ ...rawTemplate, id: "t2" }] });
  });
  assert.equal(templates.length, 2);
  await assert.rejects(listMetaTemplates({ token: "secret", wabaId: "b1", version: "v26.0" }, async () => Response.json({ data: [], paging: { next: "x" } })), /paginacion/);
});
test("listing does not send messages or return secrets", async () => {
  const api = graph(); const db = fakeDb();
  const result = await getWhatsAppTemplates(db, env(), api.request);
  assert.equal(result.ready, true); assert.equal(api.posts.length, 0);
  assert.equal(JSON.stringify(result).includes("private-test"), false); assert.equal(db.tables.whatsapp_messages.length, 0);
});
for (const [name, change, envChange, dbChange, templateChange] of [
  ["confirmation", { confirmSend: false }], ["optin override", { allowWithoutOptIn: true }],
  ["wrong locale", { language: "es" }], ["production disabled", {}, { META_WHATSAPP_PRODUCTION_APPROVED: "false" }],
  ["inactive integration", {}, {}, { whatsapp_settings: [{ active: false }] }],
  ["account mismatch", {}, { META_WHATSAPP_BUSINESS_ACCOUNT_ID: "other" }],
  ["no optin", {}, {}, { companies: [{ ...company, whatsapp_opt_in: false }] }],
  ["optout", {}, {}, { companies: [{ ...company, whatsapp_status: "opt_out" }] }],
  ["wrong phone", { recipients: [{ companyId: "c1", phone: "56999999999", parameters: [] }] }],
  ["wrong variables", { recipients: [{ companyId: "c1", phone: company.whatsapp, parameters: ["bad"] }] }],
  ["no campaign", {}, {}, { campaigns: [] }], ["not approved", {}, {}, {}, { status: "PENDING" }],
]) test(`blocks ${name} before sending`, async () => {
  const api = graph({ ...rawTemplate, ...templateChange }); const db = fakeDb(dbChange);
  await assert.rejects(dispatchWhatsAppCampaign(db, env(envChange), { ...payload, ...change }, api.request));
  assert.equal(api.posts.length, 0); assert.equal(db.tables.whatsapp_messages.length, 0);
});
test("persistent reservation prevents sequential and concurrent duplicates", async () => {
  const db = fakeDb(); const api = graph();
  const results = await Promise.all([dispatchWhatsAppCampaign(db, env(), payload, api.request), dispatchWhatsAppCampaign(db, env(), payload, api.request)]);
  assert.equal(api.posts.length, 1); assert.equal(results.flatMap((r) => r.results).filter((r) => r.success).length, 1);
  await dispatchWhatsAppCampaign(db, env(), payload, api.request); assert.equal(api.posts.length, 1);
  assert.equal(db.tables.companies[0].whatsapp_status, "opt_in");
});
test("timeout remains reserved; does not retry or send remaining recipients", async () => {
  const db = fakeDb({ companies: [company, { ...company, id: "c2", whatsapp: "56922222222" }] });
  const api = graph(rawTemplate, () => { throw new Error("network uncertain"); });
  const p = { ...payload, recipients: [...payload.recipients, { companyId: "c2", phone: "56922222222", parameters: [] }] };
  const result = await dispatchWhatsAppCampaign(db, env(), p, api.request);
  assert.equal(api.posts.length, 1); assert.equal(result.results.length, 2); assert.equal(result.results.filter((r) => r.success).length, 0);
  assert.equal(db.tables.whatsapp_messages[0].status, "pending");
  await dispatchWhatsAppCampaign(db, env(), payload, api.request); assert.equal(api.posts.length, 1);
});
test("partial failures report only actual successes", async () => {
  const db = fakeDb({ companies: [company, { ...company, id: "c2", whatsapp: "56922222222" }] });
  const api = graph(rawTemplate, (n) => n === 1 ? Response.json({ messages: [{ id: "wamid.1" }] }) : Response.json({ error: { code: 100 } }, { status: 400 }));
  const result = await dispatchWhatsAppCampaign(db, env(), { ...payload, recipients: [...payload.recipients, { companyId: "c2", phone: "56922222222", parameters: [] }] }, api.request);
  assert.deepEqual(result.results.map((r) => r.success), [true, false]);
});
test("admin authorization ignores user-editable metadata and inactive profiles", async () => {
  const source = fs.readFileSync(new URL("../supabase/functions/crm-agent/index.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true);
  const fn = ast.statements.find((n) => ts.isFunctionDeclaration(n) && n.name?.text === "requireCrmAdmin");
  const compiled = ts.transpileModule(fn.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const requireAdmin = new Function(`${compiled}; return requireCrmAdmin;`)();
  const req = new Request("https://test", { headers: { Authorization: "Bearer user-session" } });
  for (const profile of [null, { role: "vendedor", active: true }, { role: "administrador", active: false }]) {
    const db = fakeDb({ profiles: profile ? [{ id: "u1", ...profile }] : [] });
    db.auth = { getUser: async () => ({ data: { user: { id: "u1", user_metadata: { role: "administrador" } } } }) };
    assert.equal((await requireAdmin(req, db)).authorized, false);
  }
  assert.match(source, /\["meta-whatsapp-send", "send-campaign"\]/);
  assert.equal(await whatsappDispatchId(campaignId, "56912345678"), await whatsappDispatchId(campaignId, "56912345678"));
});
