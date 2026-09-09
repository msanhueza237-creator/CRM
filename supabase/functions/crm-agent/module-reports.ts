import { resolveProducts } from "../crm-copilot/product-resolution.ts";
import { isModuleAnalysisTask, accountingAgents, type AgentRow as Row } from "../_shared/agent-module-contract.ts";

export type ModuleReader = {
  all: (table: string, select: string, filters?: Record<string, unknown>) => Promise<Row[]>;
  accounting: () => Promise<Row>;
  previousExecutive?: () => Promise<Row | null>;
};
const obj = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.map(obj) : [];
const finite = (value: unknown) => value === null || value === undefined || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);
const names: Record<string, string> = { commercial: "Comercial", marketing: "Marketing", logistics: "Logistica", foreign_trade: "Comercio Exterior", executive: "Gerente" };
export type ModuleSection = { key: string; title: string; href: string; source: string; source_from: string | null; source_to: string | null; row_count: number; complete: true; rows: Row[] };
function section(key: string, title: string, href: string, source: string, data: Row[]): ModuleSection {
  const dates = data.map((row) => String(row.source_at || row.updated_at || row.last_synced_at || "")).filter(Boolean).sort();
  return { key, title, href, source, source_from: dates[0] || null, source_to: dates.at(-1) || null, row_count: data.length, complete: true, rows: data };
}
export function assertModuleRequester(task: Row, profile: Row | null) {
  if (!isModuleAnalysisTask(task)) throw new Error("unsupported_module_analysis");
  if (!profile || profile.active !== true) throw new Error("module_requester_inactive");
  if (profile.role !== "administrador"
    && !(profile.role === "finanzas" && ["finance", "collections"].includes(String(task.agent_type)))) {
    throw new Error("module_requester_forbidden");
  }
}

export async function buildBusinessModuleReport(task: Row, profile: Row, read: ModuleReader, consultedAt: string) {
  assertModuleRequester(task, profile);
  const agent = String(task.agent_type);
  const sections: ModuleSection[] = [];
  const metrics: Row = {};
  const recommendations: { title: string; detail: string; href: string }[] = [];
  const warnings: string[] = ["Analisis de registros del CRM al momento de la consulta; no es una lectura en vivo de proveedores. No contabiliza, publica ni aprueba propuestas."];
  let accounting: Row | null = null;
  const needsContent = ["marketing", "executive"].includes(agent);
  const needsTrade = ["foreign_trade", "logistics", "executive"].includes(agent);
  if (needsContent) {
    const allowed = await read.all("content_role_permissions", "role,permission,allowed", { role: profile.role, permission: "content.view" });
    if (!allowed.some((row) => row.allowed === true)) throw new Error("content_module_forbidden");
  }
  if (needsTrade) {
    const allowed = await read.all("foreign_trade_role_permissions", "role,permission,allowed", { role: profile.role, permission: "foreign_trade.view" });
    if (!allowed.some((row) => row.allowed === true)) throw new Error("foreign_trade_module_forbidden");
    if (agent === "foreign_trade") {
      const permission = await read.all("foreign_trade_agent_permissions", "agent_type,permission,allowed", { agent_type: agent, permission: "foreign_trade.read" });
      if (!permission.some((row) => row.allowed === true)) throw new Error("foreign_trade_agent_forbidden");
    }
  }
  if (accountingAgents.includes(agent)) {
    const result = await read.accounting();
    accounting = obj(rows(result.evidence)[0]?.accounting_module_report);
    if (accounting.module !== "accounting-center") throw new Error("invalid_accounting_module_report");
    Object.assign(metrics, obj(accounting.metrics));
    warnings.push(...(Array.isArray(result.warnings) ? result.warnings.map(String) : []));
  }

  if (["commercial", "marketing", "executive"].includes(agent)) {
    const companies = await read.all("companies", "id,name,rut,status,priority,next_follow_up,updated_at");
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santiago", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(consultedAt));
    const part = (type: string) => parts.find((item) => item.type === type)?.value;
    const asOf = `${part("year")}-${part("month")}-${part("day")}`;
    const overdue = companies.filter((row) => row.next_follow_up && String(row.next_follow_up) < asOf);
    sections.push(section("companies", "Empresas y seguimiento", "/empresas", "companies", companies.map((row) => ({ ...row, href: `/empresas/${row.id}` }))));
    metrics.companies = companies.length;
    metrics.followups_overdue = overdue.length;
    if (overdue.length) recommendations.push({ title: "Seguimientos pendientes", detail: `${overdue.length} empresas tienen una fecha de seguimiento anterior al corte. Revisar al responsable antes de contactar.`, href: "/empresas" });
  }
  if (["commercial", "executive"].includes(agent)) {
    const interactions = await read.all("interactions", "id,company_id,type,occurred_at,next_action,updated_at");
    sections.push(section("interactions", "Actividad comercial registrada", "/empresas", "interactions", interactions.map((row) => ({ ...row, href: `/empresas/${row.company_id}` }))));
    metrics.interactions = interactions.length;
  }

  // Reuse the same SKU identity/warehouse precedence used by the Copilot's catalog.
  const catalog = await read.all("content_products", "id,sku,name,brand,description_text,product_url,last_synced_at,source_status");
  const snapshots = await read.all("integration_records", "id,external_id,payload,updated_at", { provider: "facto", resource: "inventory_snapshots" });
  const details = await read.all("integration_records", "id,external_id,payload,updated_at", { provider: "facto", resource: "product_details" });
  const products = resolveProducts(snapshots, details, catalog.filter((row) => row.source_status !== "deleted"), false);
  const stockUnknown = products.filter((row) => row.stock_known !== true);
  const stockouts = products.filter((row) => row.stock_known === true && Number(row.stock) <= 0);
  sections.push(section("products", "Catalogo e inventario sincronizado", "/contenido?view=library", "Catalogo compartido: Facto y Tiendanube", products.map((row) => ({
    id: row.id, sku: row.sku, name: row.name, brands: row.brands, stock: row.stock, stock_source: row.stock_source,
    source_at: row.stock_updated_at, warnings: row.stock_warnings,
  }))));
  metrics.products = products.length;
  metrics.stock_unknown = stockUnknown.length;
  metrics.stockouts = stockouts.length;
  const unkeyed = catalog.filter((row) => !String(row.sku || "").trim());
  if (unkeyed.length) {
    warnings.push(`${unkeyed.length} productos de catalogo carecen de SKU y se presentan separados; no se suman a identidades verificadas.`);
    sections.push(section("unkeyed_products", "Productos sin SKU", "/contenido?view=library", "content_products", unkeyed.map(({ id, name, last_synced_at }) => ({ id, name, source_at: last_synced_at }))));
  }
  if (stockUnknown.length) warnings.push(`${stockUnknown.length} SKU tienen stock desconocido o identidad en revision, no stock cero.`);
  if (stockouts.length) recommendations.push({ title: "Revisar reposicion", detail: `${stockouts.length} SKU presentan stock conocido no positivo. Los embarques y escenarios no aumentan disponibilidad.`, href: "/comercio-exterior" });

  if (needsContent) {
    const campaigns = await read.all("campaigns", "id,name,type,status,send_at,updated_at");
    const publications = await read.all("content_publications", "id,product_id,channel_id,status,scheduled_at,published_at,updated_at");
    const schedules = await read.all("content_schedules", "id,name,active,next_run_at,operation_mode,updated_at");
    sections.push(section("campaigns", "Campanas", "/campanas", "campaigns", campaigns));
    sections.push(section("publications", "Publicaciones", "/contenido?view=publications", "content_publications", publications));
    sections.push(section("schedules", "Programacion de contenido", "/contenido?view=calendar", "content_schedules", schedules));
    metrics.campaigns = campaigns.length;
    metrics.publications = publications.length;
    metrics.pending_approval = publications.filter((row) => row.status === "pending_approval").length;
    metrics.failed_publications = publications.filter((row) => ["failed", "partial"].includes(String(row.status))).length;
    if (Number(metrics.pending_approval)) recommendations.push({ title: "Contenido para aprobar", detail: `${metrics.pending_approval} publicaciones esperan aprobacion en Centro de Contenido.`, href: "/contenido?view=publications" });
    if (Number(metrics.failed_publications)) recommendations.push({ title: "Revisar publicaciones con error", detail: `${metrics.failed_publications} publicaciones fallidas o parciales; revisar su causa antes de reintentar.`, href: "/contenido?view=publications" });
  }

  if (needsTrade) {
    const operations = await read.all("import_shipments", "id,reference,title,operation_type,status,inventory_mode,base_currency,value_usd,estimated_arrival,active_scenario_id,updated_at");
    const statuses = await read.all("foreign_trade_operation_statuses", "code,name,final_state");
    const documents = await read.all("foreign_trade_documents", "id,operation_id,document_type,original_file_name,parse_status,confirmed_at,updated_at");
    const scenarios = await read.all("foreign_trade_scenarios", "id,operation_id,name,status,landed_total_clp,projected_profit_clp,missing_inputs,calculated_at,updated_at");
    const costs = await read.all("foreign_trade_cost_lines", "id,operation_id,scenario_id,category,name,amount_original,currency,amount_clp,source_type,updated_at");
    const suppliers = await read.all("suppliers", "id,name,country_code,active,updated_at");
    const final = new Set(statuses.filter((row) => row.final_state === true).map((row) => row.code));
    const active = operations.filter((row) => statuses.some((s) => s.code === row.status) && !final.has(row.status));
    const href = (id: unknown) => `/comercio-exterior?operation=${encodeURIComponent(String(id || ""))}`;
    sections.push(section("operations", "Operaciones de importacion", "/comercio-exterior", "import_shipments", operations.map((row) => ({ ...row, href: href(row.id) }))));
    sections.push(section("trade_documents", "Documentos de importacion", "/comercio-exterior", "foreign_trade_documents", documents.map((row) => ({ ...row, href: href(row.operation_id) }))));
    sections.push(section("scenarios", "Escenarios, no costos realizados", "/comercio-exterior", "foreign_trade_scenarios", scenarios.map((row) => ({ ...row, href: href(row.operation_id) }))));
    sections.push(section("costs", "Costos por origen y moneda", "/comercio-exterior", "foreign_trade_cost_lines", costs.map((row) => ({ ...row, href: href(row.operation_id) }))));
    sections.push(section("suppliers", "Proveedores", "/comercio-exterior?view=suppliers", "suppliers", suppliers));
    metrics.active_operations = active.length;
    metrics.shipments_in_transit = operations.filter((row) => row.status === "in_transit").length;
    metrics.trade_documents_to_review = documents.filter((row) => ["review_required", "failed"].includes(String(row.parse_status))).length;
    metrics.scenarios_incomplete = scenarios.filter((row) => !row.calculated_at || finite(row.landed_total_clp) === null || (Array.isArray(row.missing_inputs) && row.missing_inputs.length)).length;
    warnings.push("Las operaciones, recepciones y simulaciones no se suman al stock del catalogo. Los costos conservan moneda, escenario y origen; no se duplican como gastos contables.");
    if (Number(metrics.trade_documents_to_review)) recommendations.push({ title: "Documentos de importacion pendientes", detail: `${metrics.trade_documents_to_review} documentos requieren revision en Comercio Exterior.`, href: "/comercio-exterior" });
    if (Number(metrics.scenarios_incomplete)) recommendations.push({ title: "Completar costos de escenarios", detail: `${metrics.scenarios_incomplete} escenarios no tienen todos los antecedentes calculados. No usarlos como costo definitivo.`, href: "/comercio-exterior" });
  }
  const summary = `${names[agent]}: ${sections.length} fuentes del CRM consultadas, ${products.length} SKU identificados. ${recommendations.length} asuntos para revisar en sus modulos. Los informes anteriores de agentes no se usaron como fuente de cifras.`;
  let fingerprint: string | null = null;
  let brief: Row | null = null;
  if (agent === "executive") {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify({ sections, metrics, recommendations })));
    fingerprint = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const previous = await read.previousExecutive?.();
    const previousModule = obj(rows(obj(previous?.result).evidence)[0]?.module_report);
    const input = obj(task.payload);
    const scheduled = input.mode === "morning" || input.mode === "review";
    metrics.notification_required = scheduled && (input.mode === "morning" || previousModule.fingerprint !== fingerprint);
    brief = {
      generated_at: consultedAt, mode: input.mode || "manual", headline: summary,
      sections: sections.map((item) => ({ key: item.key, title: item.title, count: item.row_count, items: [{ title: item.title, detail: `${item.row_count} registros. Origen: ${item.source_from || "sin fecha"} a ${item.source_to || "sin fecha"}. ${item.href}` }] })),
      recommendations: recommendations.map((item) => `${item.title}: ${item.detail}`),
    };
  }
  return {
    summary, metrics, warnings: [...new Set(warnings)], proposals: [],
    evidence: [{ ...(brief ? { executive_brief: brief } : {}), module_report: {
      contract_version: 1, agent, consulted_at: consultedAt, read_only: true,
      sections, recommendations, accounting, metrics, fingerprint,
      source_policy: "Los modulos son fuente; este analisis es una lectura con fecha, no un nuevo registro contable.",
    } }],
  };
}
