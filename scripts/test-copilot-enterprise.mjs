import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateFinancialPeriod,
  customerAnalytics,
  projectedSalesDocument,
} from "../supabase/functions/crm-copilot/business-analytics.ts";
import { copilotConfig } from "../supabase/functions/crm-copilot/config.ts";
import {
  safeData,
  redactSecrets,
  sessionExpires,
} from "../supabase/functions/crm-copilot/safety.ts";
import { modelPreview, redactArguments, runOrchestrator } from "../supabase/functions/crm-copilot/orchestrator.ts";
import { CopilotSources } from "../supabase/functions/crm-copilot/sources.ts";
import { dateRange } from "../supabase/functions/crm-copilot/dates.ts";
import { ToolRegistry } from "../supabase/functions/crm-copilot/tool-registry.ts";
import { centralHandler } from "../supabase/functions/crm-copilot/central.ts";
const accounts = [
  { id: "income", account_type: "income" },
  { id: "cost", account_type: "cost", classification: "cost_of_sales" },
  { id: "inventory", account_type: "asset", classification: "inventory" },
  { id: "expense", account_type: "expense" },
];
const doc = (id, net, date = "2026-09-10", type = "sales_invoice") => ({
  id,
  net_amount: net,
  exempt_amount: 0,
  tax_amount: net * 0.19,
  total_clp: net * 1.19,
  currency: "CLP",
  document_type: type,
  status: "validated",
  data_quality: "validated",
  issued_on: date,
  counterpart_tax_id: "12345678-9",
  counterpart_name: "Empresa",
});
const line = (id, amount, account = "income", date = "2026-09-10") => ({
  account_id: account,
  debit_clp: account === "income" ? 0 : amount,
  credit_clp: account === "income" ? amount : 0,
  accounting_journal_entries: {
    id: `entry-${id}-${account}`,
    source_document_id: id,
    status: "posted",
    entry_date: date,
  },
});
test("Configuracion central y limites validan variables sin propagarlas al cliente", () => {
  const c = copilotConfig(
    (k) =>
      ({
        OPENAI_MODEL: "modelo-autorizado",
        COPILOT_TIMEOUT_MS: "999999",
        COPILOT_HISTORY_MESSAGES: "invalid",
      })[k],
  );
  assert.equal(c.model, "modelo-autorizado");
  assert.equal(c.timeoutMs, 180000);
  assert.equal(c.historyMessages, 12);
  assert.equal(copilotConfig(() => undefined).maxOutputTokens, 5000);
  assert.equal(copilotConfig(() => undefined).timeoutMs, 50000);
});
test("Fechas calendario, ayer y 12 meses usan fecha de negocio", () => {
  const now = new Date("2026-09-16T01:00:00Z");
  assert.deepEqual(dateRange({ period: "yesterday" }, now), {
    from: "2026-09-14",
    to: "2026-09-14",
  });
  assert.deepEqual(dateRange({ period: "last_12_months" }, now), {
    from: "2025-10-01",
    to: "2026-09-15",
  });
  assert.deepEqual(dateRange({ period: "calendar_week" }, now), {
    from: "2026-09-14",
    to: "2026-09-20",
  });
});
test("Asientos, NC, costos y ventas pendientes se cuentan una sola vez", () => {
  const docs = [
    doc("posted", 1000),
    doc("pending", 500),
    doc("nc", 200, "2026-09-10", "sales_credit_note"),
  ];
  const cost = line("posted", 600, "cost"),
    inventory = {
      ...cost,
      account_id: "inventory",
      debit_clp: 0,
      credit_clp: 600,
    };
  const lines = [
    line("posted", 1000),
    line("nc", -200),
    cost,
    inventory,
    line(null, 100, "expense"),
  ];
  const totals = aggregateFinancialPeriod(docs, lines, lines, accounts, {
    from: "2026-09-01",
    to: "2026-09-15",
  });
  assert.equal(totals.sales, 1300);
  assert.equal(totals.salesPending, 500);
  assert.equal(totals.costs, 600);
  assert.equal(totals.operatingProfit, 600);
  assert.equal(totals.salesCostMissingDocuments, 1);
});
test("Factura de agosto contabilizada en septiembre no se reintroduce en agosto", () => {
  const docs = [doc("moved", 1000, "2026-08-31")],
    lines = [line("moved", 1000, "income", "2026-09-01")];
  const august = aggregateFinancialPeriod(
    docs,
    [],
    lines,
    accounts,
    { from: "2026-08-01", to: "2026-08-31" },
    "2026-09-15",
  );
  assert.equal(august.sales, 0);
  assert.equal(august.salesPendingDocuments, 0);
  const september = aggregateFinancialPeriod([], lines, lines, accounts, {
    from: "2026-09-01",
    to: "2026-09-15",
  });
  assert.equal(september.sales, 1000);
});
test("Ausencia de importe contable nunca se transforma en cero", () => {
  const incomplete = line("a", 100);
  incomplete.debit_clp = null;
  assert.throws(
    () =>
      aggregateFinancialPeriod([], [incomplete], [], accounts, {
        from: "2026-09-01",
        to: "2026-09-15",
      }),
    /incompletos/,
  );
});
test("Proyeccion conserva direccion Facto y excluye notas recibidas de las ventas", () => {
  const received = projectedSalesDocument({
    ...doc("purchase-note", 500, "2026-09-10", "sales_credit_note"),
    direction_4: 0,
  });
  const result = aggregateFinancialPeriod([received], [], [], accounts, {
    from: "2026-09-01",
    to: "2026-09-15",
  });
  assert.equal(result.sales, 0);
  assert.equal(result.excludedDocuments, 1);
});
test("Secretos se excluyen de preguntas, datos, contexto y proyecciones", () => {
  const key = "sk-proj-abcdefghijklmnopqrst";
  assert.ok(!redactSecrets(`API_KEY=${key} Bearer abc123`).includes(key));
  assert.deepEqual(
    safeData({ name: "Empresa", api_key: key, nested: { password: "x" } }),
    { name: "Empresa", nested: {} },
  );
  assert.ok(!JSON.stringify(redactArguments({ category: key })).includes(key));
  const preview = modelPreview({
    records: Array.from({ length: 100 }, (_, i) => ({ id: i })),
    raw_payload: { secret: key },
  });
  assert.equal(preview.records.length, 31);
  assert.equal(preview.raw_payload, undefined);
  assert.equal(
    sessionExpires({}, "2026-09-01T00:00:00Z", 30),
    "2026-10-01T00:00:00.000Z",
  );
});
test("Fuentes tienen timeout y cache aislada por usuario/turno", async () => {
  const fetcher = async (_u, options) =>
    new Promise((_r, reject) =>
      options.signal.addEventListener("abort", () =>
        reject(new DOMException("abort", "AbortError")),
      ),
    );
  const source = new CopilotSources(
    {
      url: "https://fixture.invalid",
      serviceRoleKey: "secret",
      anonKey: "anon",
    },
    { id: "u", role: "administrador", accessToken: "t" },
    undefined,
    fetcher,
    10,
  );
  await assert.rejects(() => source.select("companies?select=id"), /excedio/);
  assert.equal(source.metrics.requests, 1);
});
test("Nuevas herramientas financieras no se ofrecen ni ejecutan a vendedor", async () => {
  let touched = false;
  const source = new CopilotSources(
    {},
    { id: "u", role: "vendedor", accessToken: "" },
  );
  source.all = async () => {
    touched = true;
    return [];
  };
  const registry = new ToolRegistry(source);
  for (const name of [
    "get_sales_summary",
    "compare_sales_periods",
    "get_customer_sales",
    "get_product_profitability",
  ]) {
    assert.equal(
      registry.list().some((t) => t.name === name),
      false,
    );
    assert.equal((await registry.execute(name, {})).status, "forbidden");
  }
  assert.equal(touched, false);
});
test("Ranking de clientes descuenta NC y mantiene RUT/periodo sin snapshots", async () => {
  const source = {
    entity: async () => "entity",
    all: async (path) =>
      path.startsWith("companies")
        ? []
        : [
            doc("invoice", 1000),
            doc("nc", 200, "2026-09-11", "sales_credit_note"),
          ],
  };
  const result = await customerAnalytics(source, {
    from: "2026-09-01",
    to: "2026-09-15",
    limit: 10,
  });
  assert.equal(result.data.records[0].net_sales, 800);
  assert.equal(result.data.records[0].invoices, 1);
  assert.equal(result.data.total_customers, 1);
});
test("Prestamos exigen entidad y no presentan saldos con movimientos reversados o importes desconocidos", async () => {
  const movement = (kind, amount, status = "posted") => ({kind,amount_clp:amount,accounting_journal_entries:{status}});
  const source = {
    actor: {role:"administrador"}, entity: async () => "entity-fixture",
    api: async (service, route) => {
      assert.equal(service,"accounting-center");
      assert.equal(route,"loans?entityId=entity-fixture");
      return {loans:[
        {lender_name:"Completo",accounting_loan_movements:[movement("received",1000),movement("repayment",250)]},
        {lender_name:"Reversado",accounting_loan_movements:[movement("received",1000),movement("repayment",250,"reversed")]},
        {lender_name:"Desconocido",accounting_loan_movements:[movement("received",null)]},
      ]};
    },
  };
  const result = await new ToolRegistry(source).execute("get_loans",{});
  assert.equal(result.status,"partial");
  const records = result.data.records;
  assert.equal(records[0].outstanding_principal_clp,750);
  assert.equal(records[1].outstanding_principal_clp,null);
  assert.equal(records[2].received_clp,null);
  assert.equal(records[2].outstanding_principal_clp,null);
});

test("Saldo agotado y limite temporal de OpenAI se distinguen sin exponer el error privado", async () => {
  for (const [code, type, expected] of [
    ["credit_balance_exhausted","insufficient_quota","AI_QUOTA_EXHAUSTED"],
    ["insufficient_quota","insufficient_quota","AI_QUOTA_EXHAUSTED"],
    ["rate_limit_exceeded","requests","AI_RATE_LIMITED"],
  ]) {
    await assert.rejects(() => runOrchestrator({
      registry:{list:()=>[]},model:"configured-model",apiKey:"mock-secret",message:"Ventas del mes",history:[],signal:new AbortController().signal,
      onTrace:async()=>assert.fail("No debe consultar fuentes sin respuesta del modelo"),
      fetcher:async()=>new Response(JSON.stringify({error:{code,type,message:"private-provider-detail"}}),{status:429}),
    }), error=>error.code === expected && !error.message.includes("private-provider-detail"));
  }
});

test("Endpoint central conserva auditoria, permisos y contexto sin escribir datos del negocio", async () => {
  const oldFetch = globalThis.fetch,
    oldDeno = globalThis.Deno,
    writes = [];
  const id = "11111111-1111-4111-8111-111111111111",
    key = "sk-proj-abcdefghijklmnopqrst";
  globalThis.Deno = {
    env: { get: (name) => (name === "OPENAI_API_KEY" ? key : undefined) },
  };
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url),
      payload = init.body ? JSON.parse(init.body) : {};
    const response = (data) =>
      new Response(JSON.stringify(data), {
        headers: { "Content-Type": "application/json", "content-range": "*/0" },
      });
    if (u.hostname === "api.openai.com") {
      assert.ok(!JSON.stringify(payload.input).includes(key));
      assert.equal(payload.store, false);
      assert.equal(payload.reasoning.effort, "low");
      const second = payload.input.some(
        (p) => p.type === "function_call_output",
      );
      return response({
        output: second
          ? [
              {
                type: "message",
                content: [
                  {
                    type: "output_text",
                    text: `Sin publicaciones programadas. ${key}`,
                  },
                ],
              },
            ]
          : [
              {
                type: "function_call",
                name: "get_content",
                call_id: "call-1",
                arguments: JSON.stringify({ view: "scheduled", period: "all" }),
              },
            ],
        usage: { input_tokens: 50, output_tokens: 20 },
      });
    }
    if (init.method && init.method !== "GET") {
      assert.ok(u.pathname.includes("/copilot_"), u.pathname);
      writes.push({ path: u.pathname, payload });
      return response([
        { id, created_at: new Date().toISOString(), ...payload },
      ]);
    }
    return response([]);
  };
  try {
    const response = await centralHandler(
      new Request("https://fixture.invalid/functions/v1/crm-copilot/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: `Que publicamos? API_KEY=${key}` }),
      }),
      {
        url: "https://fixture.invalid",
        serviceRoleKey: "service",
        anonKey: "anon",
      },
      { id, role: "administrador", accessToken: "user" },
      "trace-test",
      {},
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(!JSON.stringify(body).includes(key));
    assert.equal(body.timings.requests > 0, true);
    assert.ok(writes.some((w) => w.path.endsWith("copilot_tool_runs")));
    assert.ok(
      writes.some(
        (w) =>
          w.path.endsWith("copilot_audit_events") &&
          w.payload.event_type === "central_read_turn",
      ),
    );
    assert.ok(
      writes.find(
        (w) => w.path.endsWith("copilot_conversations") && w.payload.metadata,
      )?.payload.metadata.expiresAt,
    );
    assert.ok(!JSON.stringify(writes).includes(key));
  } finally {
    globalThis.fetch = oldFetch;
    globalThis.Deno = oldDeno;
  }
});
