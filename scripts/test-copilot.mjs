import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

test("Migracion idempotente conserva historial y aplica RLS al bajar de rol", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role authenticated;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      create function public.current_role() returns text language sql stable as $$ select current_setting('request.jwt.claim.role',true) $$;
      create table copilot_conversations(id uuid primary key,user_id uuid,title text,metadata jsonb default '{}',updated_at timestamptz default now());
      create table copilot_messages(id uuid primary key,user_id uuid,conversation_id uuid,content text,created_at timestamptz default now());
      create table copilot_tool_runs(id uuid primary key,user_id uuid,conversation_id uuid);
      alter table copilot_conversations enable row level security;
      alter table copilot_messages enable row level security;
      alter table copilot_tool_runs enable row level security;
      grant usage on schema public, auth to authenticated;
      grant select on copilot_conversations,copilot_messages,copilot_tool_runs to authenticated;
      insert into copilot_conversations(id,user_id,title,metadata) values
        ('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','Anterior','{"engine":"central","role":"finanzas"}');
      insert into copilot_messages values('33333333-3333-4333-8333-333333333333','22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111','Dato historico',now());
    `);
    const sql = await readFile(new URL("../supabase/copilot_central.sql", import.meta.url), "utf8");
    await db.exec(sql); await db.exec(sql);
    assert.equal((await db.query("select content from copilot_messages")).rows[0].content, "Dato historico");
    await db.exec(`set role authenticated; set request.jwt.claim.sub = '22222222-2222-4222-8222-222222222222'; set request.jwt.claim.role = 'finanzas';`);
    assert.equal((await db.query("select * from copilot_messages")).rows.length, 1);
    await db.exec("set request.jwt.claim.role = 'vendedor';");
    assert.equal((await db.query("select * from copilot_messages")).rows.length, 0);
    await db.exec("set request.jwt.claim.role = 'finanzas'; set request.jwt.claim.sub = '44444444-4444-4444-8444-444444444444';");
    assert.equal((await db.query("select * from copilot_messages")).rows.length, 0);
  } finally { await db.close(); }
});
import { readFile } from "node:fs/promises";
import { CopilotSources } from "../supabase/functions/crm-copilot/sources.ts";
import {
  ToolRegistry,
  latestMetrics,
  validateArguments,
} from "../supabase/functions/crm-copilot/tool-registry.ts";
import { runOrchestrator } from "../supabase/functions/crm-copilot/orchestrator.ts";
import {
  dateRange,
  todayChile,
} from "../supabase/functions/crm-copilot/dates.ts";
import {
  decimalSum,
  matches,
  numeric,
} from "../supabase/functions/crm-copilot/contracts.ts";
import { centralHandler } from "../supabase/functions/crm-copilot/central.ts";

const stamp = new Date().toISOString(),
  operation = "11111111-1111-4111-8111-111111111111";
const actor = {
  id: "22222222-2222-4222-8222-222222222222",
  role: "administrador",
  accessToken: "test-user-token",
};
const config = {
  url: "https://fixtures.invalid",
  anonKey: "test-anon",
  serviceRoleKey: "test-service",
};
function fixture(role = "administrador") {
  const accesses = [];
  const source = new CopilotSources(config, { ...actor, role });
  source.records = async (resource) => {
    accesses.push(resource);
    const wrap = (payload, index) => ({
      id: `id-${index}`,
      external_id: `${index}`,
      payload,
      updated_at: stamp,
    });
    if (resource === "inventory_snapshots")
      return [
        {
          sku: "20X15INY",
          name: "Rejilla inyeccion",
          stock_known: true,
          available_units: 8,
          price_known: true,
          unit_price: 5000,
          price_currency_code: "CLP",
          cost_known: true,
          unit_cost_source: 1000,
          sales_history_available: true,
          units_sold_observed: 50,
          sales_history_start: "2026-01-01",
          sales_history_end: "2026-08-31",
        },
        {
          sku: "EMPTY",
          name: "Producto agotado",
          stock_known: true,
          available_units: 0,
        },
        {
          sku: "UNKNOWN",
          name: "Producto desconocido",
          stock_known: false,
          available_units: 0,
        },
      ].map(wrap);
    if (resource === "product_details")
      return [
        wrap(
          {
            sku: "20X15INY",
            name: "Rejilla",
            price: [
              {
                product_price_list_id: 1,
                currency_id: 39,
                unit_net: 5000,
                unit_tax: 950,
                unit_total: 5950,
              },
            ],
          },
          0,
        ),
      ];
    if (resource === "commercial_snapshots")
      return [
        wrap(
          {
            customers: [
              {
                customer_key: "c1",
                tax_id: "12.345.678-5",
                name: "Instalaciones Munoz",
                last_purchase_at: "2026-01-01",
                facto_net_sales: 10000,
              },
            ],
          },
          0,
        ),
      ];
    return [];
  };
  source.all = async (path) => {
    accesses.push(path);
    if (path.startsWith("companies?"))
      return [
        {
          id: "c1",
          name: "Instalaciones Munoz",
          rut: "12345678-5",
          type: "instalador_grande",
          updated_at: stamp,
        },
        { id: "c2", name: "Sin historia", rut: "", updated_at: stamp },
      ];
    if (path.startsWith("accounting_receivables?"))
      return Array.from({ length: 17 }, (_, i) => ({
        id: `${i}`,
        customer_name: `Cliente ${i}`,
        document_number: `${1500 + i}`,
        original_amount_clp: 20000000,
        paid_amount_clp: 0,
        balance_clp: 20000000,
        reported_at: stamp,
        reported_balance_clp: i === 16 ? 9687934 : 100000,
        due_on: null,
        updated_at: stamp,
      }));
    if (path.startsWith("import_shipments?"))
      return [
        {
          id: operation,
          title: "Contenedor China",
          status: "in_transit",
          estimated_arrival: "2026-10-01",
          value_usd: 10000,
          updated_at: stamp,
        },
      ];
    if (path.startsWith("content_publications?"))
      return [
        {
          id: "pub1",
          channel_id: "ig",
          product_id: "product1",
          status: "published",
          published_at: stamp,
          created_at: stamp,
          updated_at: stamp,
          body: "Publicacion verificada",
        },
        {
          id: "pub2",
          channel_id: "fb",
          status: "scheduled",
          scheduled_at: stamp,
          created_at: stamp,
        },
      ];
    if (path.startsWith("content_metrics?"))
      return [
        {
          id: "old",
          publication_id: "pub1",
          observed_at: "2026-01-01",
          likes: 7,
          reach: null,
        },
        {
          id: "new",
          publication_id: "pub1",
          observed_at: stamp,
          likes: 9,
          reach: null,
        },
      ];
    if (path.startsWith("content_products?"))
      return [{ id: "product1", name: "Rejilla" }];
    if (path.startsWith("campaigns?"))
      return [
        {
          id: "campaign1",
          name: "Campana septiembre",
          status: "borrador",
          updated_at: stamp,
        },
      ];
    if (path.startsWith("business_agent_tasks?"))
      return [
        {
          id: "agent1",
          agent_type: "foreign_trade",
          status: "completed",
          result_summary: "Operacion revisada",
          updated_at: stamp,
        },
      ];
    return [];
  };
  source.select = async (path) =>
    path.startsWith("content_channels?")
      ? [
          { id: "ig", code: "instagram" },
          { id: "fb", code: "facebook" },
        ]
      : [];
  source.entity = async () => operation;
  source.api = async (service, route) => {
    accesses.push(`${service}/${route}`);
    return route === "summary"
      ? {
          summary: {
            receivables: 11287934,
            bank_clp: 8210126,
            receivables_data_quality: "verified_full_snapshot",
          },
          dashboard: { warnings: [], current: { sales: 100 } },
          factoFreshness: { integrationUpdatedAt: stamp, stale: false },
        }
      : {
          rows: [{ classification: "net_sales", amount: 100 }],
          kind: "income",
        };
  };
  source.rpc = async (name, args) => {
    accesses.push(`${name}:${args.p_operation_id}`);
    return {
      operation: {
        id: operation,
        title: "Contenedor China",
        updated_at: stamp,
      },
      lines: [
        {
          id: "l1",
          sku: "20X15INY",
          product_name: "Rejilla",
          quantity: 300,
          currency: "USD",
        },
      ],
      totals: { quantity: 300 },
    };
  };
  return { source, registry: new ToolRegistry(source), accesses };
}
test("CLP exacto y montos desconocidos", () => {
  assert.equal(numeric(false), null);
  assert.equal(numeric(" "), null);
  assert.equal(numeric("0"), 0);
  assert.equal(decimalSum(["289066862.67", "0.01"]), "289066862.6800");
  assert.equal(decimalSum([null, 1]), null);
  assert.equal(decimalSum([]), "0.0000");
});
test("Fechas Chile, mes anterior, semana calendario y fecha invalida", () => {
  assert.deepEqual(
    dateRange({ period: "last_month" }, new Date("2026-03-01T16:00:00Z")),
    { from: "2026-02-01", to: "2026-02-28" },
  );
  assert.deepEqual(
    dateRange({ period: "this_week" }, new Date("2026-09-09T16:00:00Z")),
    { from: "2026-09-07", to: "2026-09-09" },
  );
  assert.equal(todayChile(new Date("2026-09-01T01:00:00Z")), "2026-08-31");
  assert.throws(() =>
    dateRange({ period: "custom", from: "2026-02-30", to: "2026-03-02" }),
  );
});
test("Busqueda normaliza RUT y acentos, no convierte puntuacion en coincidencia universal", () => {
  assert.equal(matches("muñoz", "MUNOZ"), true);
  assert.equal(matches("12.345.678-5", "12345678-5"), true);
  assert.equal(matches("---", "cualquiera"), false);
});
test("Stock cero no incluye stock desconocido, pagina y total independientes", async () => {
  const { registry } = fixture();
  const zero = await registry.execute("search_products", {
    stock_filter: "zero",
  });
  assert.equal(zero.table.rows.length, 1);
  assert.equal(zero.table.rows[0].sku, "EMPTY");
  const unknown = await registry.execute("search_products", {
    stock_filter: "unknown",
  });
  assert.equal(unknown.table.rows[0].stock, null);
  const page = await registry.execute("search_products", {
    limit: 1,
    offset: 1,
  });
  assert.equal(page.coverage.totalMatched, 3);
  assert.equal(page.coverage.nextOffset, 2);
});
test("Busqueda por producto y stock conocido conserva ambos filtros", async () => {
  const { registry } = fixture();
  const found = await registry.execute("search_products", { query: "rejilla", stock_filter: "known", limit: 5 });
  assert.equal(found.coverage.totalMatched, 1);
  assert.equal(found.table.rows[0].sku, "20X15INY");
  assert.equal(found.table.rows[0].stock, 8);
  const empty = await registry.execute("search_products", { query: "desconocido", stock_filter: "known" });
  assert.equal(empty.coverage.totalMatched, 0);
  assert.equal(empty.status, "empty");
  const zero = await registry.execute("search_products", { query: "agotado", stock_filter: "known" });
  assert.equal(zero.table.rows[0].stock, 0);
});
test("Precios de segmentos no se inventan; lista de origen conserva moneda ID", async () => {
  const { registry } = fixture();
  assert.equal(
    (await registry.execute("get_price_list", { segment: "distributor" }))
      .status,
    "needs_clarification",
  );
  const source = await registry.execute("get_price_list", {
    segment: "source",
  });
  assert.equal(source.table.rows[0].currency_id, 39);
  assert.equal(source.table.rows[0].total, 5950);
});

test("Actividad de agentes consulta resumen proyectado, no resultados masivos", async () => {
  const { registry, accesses } = fixture();
  const result = await registry.execute("get_agent_activity", {});
  assert.equal(result.table.rows[0].summary, "Operacion revisada");
  const path = accesses.find(path => path.startsWith("business_agent_tasks?"));
  assert.ok(path.includes("result_summary:result->>summary"));
  assert.ok(!path.includes(",result,"));
});
test("Cartera fixture: 17 documentos CLP 11287934, no suma saldos informados y conciliados", async () => {
  const result = await fixture().registry.execute("get_accounts_receivable", {
    state: "pending",
    limit: 10,
  });
  assert.equal(result.coverage.totalMatched, 17);
  assert.equal(result.data.selected_total_clp, "11287934.0000");
  assert.equal(result.data.dashboard_total_clp, 11287934);
  assert.equal(result.coverage.returned, 10);
  const overdue = await fixture().registry.execute("get_accounts_receivable", {
    state: "overdue",
  });
  assert.equal(overdue.coverage.totalMatched, 0);
});
test("Cartera parcial suprime total y no se certifica", async () => {
  const { source, registry } = fixture();
  source.api = async () => ({
    summary: { receivables: 42, receivables_suppressed: true },
  });
  const result = await registry.execute("get_accounts_receivable", {});
  assert.equal(result.status, "partial");
  assert.equal(result.data.dashboard_total_clp, null);
  assert.equal(result.data.selected_total_clp, null);
});
test("Clientes inactivos incluyen clientes sin correo y excluyen historial desconocido", async () => {
  const result = await fixture().registry.execute("search_customers", {
    query: "muñoz",
    inactive_days: 60,
  });
  assert.equal(result.coverage.totalMatched, 1);
  assert.equal(result.table.rows[0].category, "instalador_grande");
});
test("Contenido por canal y semana; metricas acumuladas no duplicadas ni null=0", async () => {
  const { registry } = fixture();
  const content = await registry.execute("get_content", {
    channel: "instagram",
    view: "published",
    period: "this_week",
  });
  assert.equal(content.coverage.totalMatched, 1);
  const metrics = await registry.execute("get_content_metrics", {
    channel: "instagram",
    period: "all",
  });
  assert.equal(metrics.data.totals.likes, "9.0000");
  assert.equal(metrics.data.totals.reach, null);
  assert.equal(
    latestMetrics([
      { publication_id: 1, observed_at: "2026-01-02" },
      { publication_id: 1, observed_at: "2026-01-01" },
    ]).length,
    1,
  );
});
test("Permisos antes de consultar fuentes y proyeccion sin costos", async () => {
  for (const role of ["vendedor", "visualizador"]) {
    const { registry, accesses } = fixture(role);
    assert.equal(
      (await registry.execute("get_financial_summary", {})).status,
      "forbidden",
    );
    assert.equal(accesses.length, 0);
    assert.equal(
      (
        await registry.execute("get_import_details", {
          operation_id: operation,
        })
      ).status,
      "forbidden",
    );
    const products = await registry.execute("search_products", {});
    assert.equal("unit_cost" in products.table.rows[0], false);
    const report = await registry.execute("generate_business_report", {});
    assert.ok(
      report.data.sections.every(
        (s) =>
          !["finance", "foreign_trade", "agents", "sales"].includes(s.domain),
      ),
    );
  }
  assert.equal(
    (await fixture("finanzas").registry.execute("get_imports", {})).status,
    "forbidden",
  );
});
test("SQL/URL arbitrarios, parametros extra y UUID invalidos nunca alcanzan la fuente", async () => {
  const { registry, accesses } = fixture();
  assert.equal(
    (await registry.execute("search_products", { sql: "drop table companies" }))
      .status,
    "needs_clarification",
  );
  assert.equal(
    (
      await registry.execute("get_import_details", {
        operation_id: "https://evil.invalid",
      })
    ).status,
    "needs_clarification",
  );
  assert.equal(
    (await registry.execute("execute_sql", {})).status,
    "unavailable",
  );
  assert.equal(accesses.length, 0);
  assert.throws(() => validateArguments({ properties: {} }, []));
});
test("Paginacion tolera limite inferior del servidor y exige total verificable", async () => {
  let calls = 0;
  const source = new CopilotSources(config, actor, undefined, async (url) => {
    const offset = Number(new URL(url).searchParams.get("offset"));
    calls++;
    return new Response(JSON.stringify([{ id: offset + 1 }]), {
      headers: { "Content-Range": `${offset}-${offset}/3` },
    });
  });
  assert.equal(
    (await source.all("companies?select=id&order=id.asc")).length,
    3,
  );
  assert.equal(calls, 3);
  const incomplete = new CopilotSources(
    config,
    actor,
    undefined,
    async () => new Response("[]"),
  );
  await assert.rejects(() => incomplete.all("companies?select=id"), /total/);
});
test("Fuente caida no se convierte en lista vacia", async () => {
  const { registry, source } = fixture();
  source.records = async () => {
    throw new Error("secret-token should not escape");
  };
  const result = await registry.execute("search_products", {});
  assert.equal(result.status, "unavailable");
  assert.equal(result.coverage.complete, false);
  assert.ok(!JSON.stringify(result).includes("secret-token"));
});

const scenarios = [
  ["Tenemos stock de rejilla?", [["search_products", { query: "rejilla" }]]],
  [
    "Muestrame productos sin stock",
    [["search_products", { stock_filter: "zero" }]],
  ],
  ["Lista distribuidores", [["get_price_list", { segment: "distributor" }]]],
  [
    "Que viene en el proximo contenedor?",
    [
      ["get_imports", { state: "upcoming" }],
      ["get_import_details", { operation_id: operation }],
    ],
  ],
  [
    "Clientes sin comprar 60 dias",
    [["search_customers", { inactive_days: 60 }]],
  ],
  [
    "Contenido publicado esta semana",
    [["get_content", { view: "published", period: "this_week" }]],
  ],
  ["Pendiente por cobrar", [["get_accounts_receivable", {}]]],
  ["Resumen financiero", [["get_financial_summary", {}]]],
  ["Informe completo del negocio", [["generate_business_report", {}]]],
  [
    "Reposicion segun stock, ventas y transito",
    [
      ["search_products", { stock_filter: "low" }],
      ["get_top_products", {}],
      ["get_imports", { state: "in_transit" }],
      ["get_import_details", { operation_id: operation }],
    ],
  ],
];
for (const [question, plan] of scenarios)
  test(`Contrato multi-step: ${question}`, async () => {
    let round = 0;
    const traces = [],
      requests = [];
    const result = await runOrchestrator({
      registry: fixture().registry,
      model: "fixture-model",
      apiKey: "fixture-key",
      message: question,
      history: [
        { role: "user", content: "Contexto anterior" },
        { role: "assistant", content: "Respuesta anterior" },
      ],
      signal: new AbortController().signal,
      onTrace: async (trace) => {
        traces.push(trace);
      },
      fetcher: async (_url, init) => {
        const payload = JSON.parse(init.body);
        requests.push(payload);
        const item = plan[round++];
        return new Response(
          JSON.stringify({
            output: item
              ? [
                  {
                    type: "function_call",
                    name: item[0],
                    call_id: `call-${round}`,
                    arguments: JSON.stringify(item[1]),
                  },
                ]
              : [
                  {
                    type: "message",
                    content: [
                      {
                        type: "output_text",
                        text: "Respuesta con evidencia verificada.",
                      },
                    ],
                  },
                ],
            usage: { input_tokens: 100, output_tokens: 50 },
          }),
        );
      },
    });
    assert.equal(result.results.length, plan.length);
    assert.equal(traces.length, plan.length);
    assert.equal(result.message, "Respuesta con evidencia verificada.");
    assert.equal(requests[0].tool_choice, "required");
    assert.equal(requests[0].store, false);
    assert.equal(requests[0].input[0].content, "Contexto anterior");
    assert.ok(
      requests
        .at(-1)
        .input.some((item) => item.type === "function_call_output"),
    );
  });
test("Sin herramienta verificada no entrega cifras del modelo", async () => {
  const result = await runOrchestrator({
    registry: fixture().registry,
    model: "fixture-model",
    apiKey: "x",
    message: "ventas",
    history: [],
    signal: new AbortController().signal,
    onTrace: async () => {},
    fetcher: async () =>
      new Response(
        JSON.stringify({
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: "Vendiste 999999" }],
            },
          ],
        }),
      ),
  });
  assert.ok(!result.message.includes("999999"));
  assert.match(result.message, /informacion suficiente/);
});
test("Cancelacion detiene el orquestador antes de consultas", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () =>
      runOrchestrator({
        registry: fixture().registry,
        model: "x",
        apiKey: "x",
        message: "stock",
        history: [],
        signal: controller.signal,
        onTrace: async () => {},
        fetcher: async () => {
          throw new Error("No debe llamarse");
        },
      }),
    /cancelada/,
  );
});
test("Historial exige propietario y rol de creacion", async () => {
  const previous = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return new Response(
      JSON.stringify([
        {
          id: operation,
          metadata: { engine: "central", role: "administrador" },
        },
      ]),
    );
  };
  try {
    await assert.rejects(
      () =>
        centralHandler(
          new Request(
            `https://fixtures.invalid/history?conversationId=${operation}`,
          ),
          config,
          { ...actor, role: "vendedor" },
          "trace",
          {},
        ),
      /permisos/,
    );
    assert.ok(urls[0].includes(`user_id=eq.${actor.id}`));
  } finally {
    globalThis.fetch = previous;
  }
});
test("Migracion aditiva y ruta central separada de acciones legacy", async () => {
  const sql = await readFile(
    new URL("../supabase/copilot_central.sql", import.meta.url),
    "utf8",
  );
  assert.match(sql, /add column if not exists metadata/);
  assert.doesNotMatch(sql, /delete from|truncate|drop table/i);
  const index = await readFile(
    new URL("../supabase/functions/crm-copilot/index.ts", import.meta.url),
    "utf8",
  );
  assert.match(index, /centralHandler\(req/);
  const registry = await readFile(
    new URL(
      "../supabase/functions/crm-copilot/tool-registry.ts",
      import.meta.url,
    ),
    "utf8",
  );
  assert.doesNotMatch(registry, /method: "(POST|PATCH|DELETE)"/);
});
