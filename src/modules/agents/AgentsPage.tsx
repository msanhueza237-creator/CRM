import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  CircleDollarSign,
  Megaphone,
  PackageSearch,
  RefreshCw,
  Sparkles,
  Truck,
  UserRoundSearch,
  WalletCards,
  XCircle,
} from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { syncGmailCustomsReferences } from "../../lib/gmailApi";
import { isSupabaseConfigured, supabase } from "../../lib/supabase";
import { useAuth } from "../auth/AuthContext";
import { useCompanyStore } from "../companies/CompanyStore";

type AgentType =
  | "commercial"
  | "marketing"
  | "finance"
  | "collections"
  | "logistics"
  | "foreign_trade"
  | "executive";

interface AgentTask {
  id: string;
  agent_type: AgentType;
  action: string;
  status: string;
  created_at: string;
  result?: {
    summary?: string;
    warnings?: string[];
    metrics?: Record<string, string | number | boolean | null>;
  } | null;
  error_code?: string | null;
}

interface Proposal {
  id: string;
  kind: string;
  title: string;
  summary: string;
  risk_level: string;
  status: string;
  created_at: string;
}

interface AgentActionItem {
  id: string;
  proposal_id: string;
  kind: string;
  destination_module: string;
  destination_path: string;
  destination_record_id: string | null;
  title: string;
  summary: string | null;
  status: string;
  created_at: string;
}

interface ProposalDecisionResult {
  decision?: string;
  message?: string;
  destination_module?: string;
  destination_path?: string;
}

interface RiskAlert {
  id: string;
  sku: string;
  severity: string;
  title: string;
  detail: string;
  status: string;
}

interface Connection {
  provider: string;
  status: string;
  read_only: boolean;
  message: string | null;
  last_success_at: string | null;
}

interface InventorySnapshotRecord {
  payload: {
    sku?: string;
    available_units?: number;
    unit_cost_usd?: number;
    average_daily_demand?: number;
    stock_known?: boolean;
    cost_known?: boolean;
    cost_available_in_source?: boolean;
    cost_requires_usd_conversion?: boolean;
    demand_available?: boolean;
    demand_observation_days?: number;
    units_sold_observed?: number;
    name?: string;
    price_known?: boolean;
    unit_price?: number;
    unit_margin?: number | null;
    margin_percent?: number | null;
    sales_history_available?: boolean;
  };
}

interface IntegrationPayloadRecord {
  external_id?: string | null;
  resource: string;
  payload: Record<string, unknown>;
  updated_at?: string | null;
}

function compactExecutivePayload(
  payload: Record<string, unknown> | null | undefined,
  fields: string[],
) {
  const source = payload ?? {};
  return Object.fromEntries(
    fields
      .filter((field) => source[field] !== undefined && source[field] !== null && source[field] !== "")
      .map((field) => [field, source[field]]),
  );
}

const executiveDocumentFields = [
  "document_id", "folio", "number", "document_number", "document_type", "date", "issued_at",
  "issue_date", "receiver_business_name", "receiver_legal_name", "recipient_business_name",
  "customer_name", "customer", "net_total", "net_amount", "total", "total_amount", "gross_total",
  "status", "document_status",
];

function executiveObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function executiveNestedObject(source: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = executiveObject(source[key]);
    if (Object.keys(value).length) return value;
  }
  return {};
}

function executiveScalar(value: unknown, objectKeys = ["name", "description", "label", "code", "id", "value", "amount", "total"]) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "object") return value;
  const source = executiveObject(value);
  for (const key of objectKeys) {
    const nested = source[key];
    if (nested !== undefined && nested !== null && nested !== "" && typeof nested !== "object") return nested;
  }
  return undefined;
}

function executiveFirst(containers: Record<string, unknown>[], keys: string[], objectKeys?: string[]) {
  for (const container of containers) {
    for (const key of keys) {
      const value = executiveScalar(container[key], objectKeys);
      if (value !== undefined) return value;
    }
  }
  return undefined;
}

function compactExecutiveDocument(payload: Record<string, unknown> | null | undefined) {
  const source = payload ?? {};
  const document = executiveNestedObject(source, "document", "data") || source;
  const effectiveDocument = Object.keys(document).length ? document : source;
  const header = executiveNestedObject(effectiveDocument, "header", "encabezado");
  const party = executiveNestedObject(
    effectiveDocument,
    "customer",
    "client",
    "receiver",
    "recipient",
    "receptor",
  );
  const headerParty = executiveNestedObject(header, "customer", "client", "receiver", "recipient", "receptor");
  const totals = executiveNestedObject(effectiveDocument, "totals", "amounts", "montos");
  const customerContainers = [party, headerParty, header, effectiveDocument, source];
  const documentContainers = [effectiveDocument, header, source];
  const totalContainers = [totals, header, effectiveDocument, source];
  const customerName = executiveFirst(customerContainers, [
    "receiver_legal_name", "receiver_business_name", "receiver_name", "receiverLegalName",
    "receiverBusinessName", "receiverName", "recipient_legal_name", "recipient_business_name",
    "recipient_name", "customer_legal_name", "customer_business_name", "customer_name",
    "client_legal_name", "client_business_name", "client_name", "receptor_razon_social",
    "receptor_nombre", "razon_social_receptor", "business_name", "legal_name", "name",
    "razon_social", "trade_name", "customer",
  ]);
  const customerTaxId = executiveFirst(customerContainers, [
    "receiver_tax_id_code", "receiver_tax_id", "receiver_rut", "receiverTaxIdCode", "receiverTaxId",
    "recipient_tax_id_code", "recipient_tax_id", "recipient_rut", "customer_tax_id_code",
    "customer_tax_id", "customer_rut", "client_tax_id_code", "client_tax_id", "client_rut",
    "receptor_rut", "rut_receptor", "tax_id_code", "tax_id", "rut", "identifier",
  ]);
  const documentNumber = executiveFirst(documentContainers, [
    "document_number", "number", "folio", "reference_number",
  ]);
  const documentType = executiveFirst(documentContainers, [
    "document_type", "document_type_name", "type_name", "dte_type", "tipo_documento",
  ], ["name", "description", "label", "code", "id"]);
  const issueDate = executiveFirst(documentContainers, [
    "issue_date", "issued_at", "date", "emission_date", "document_date", "fecha_emision", "fecha",
  ]);
  const netTotal = executiveFirst(totalContainers, [
    "net_total", "net_amount", "net", "amount_net", "total_net", "subtotal", "monto_neto",
  ]);
  const grossTotal = executiveFirst(totalContainers, [
    "total", "total_amount", "gross_total", "gross_amount", "grand_total", "monto_total",
  ]);

  return {
    ...compactExecutivePayload(source, executiveDocumentFields),
    ...(customerName !== undefined ? { customer_name: customerName } : {}),
    ...(customerTaxId !== undefined ? { customer_tax_id: customerTaxId } : {}),
    ...(documentNumber !== undefined ? { document_number: documentNumber } : {}),
    ...(documentType !== undefined ? { document_type: documentType } : {}),
    ...(issueDate !== undefined ? { issue_date: issueDate } : {}),
    ...(netTotal !== undefined ? { net_total: netTotal } : {}),
    ...(grossTotal !== undefined ? { total: grossTotal } : {}),
  };
}

function executiveArray(containers: Record<string, unknown>[], keys: string[]) {
  for (const container of containers) {
    for (const key of keys) {
      if (Array.isArray(container[key])) return container[key] as unknown[];
    }
  }
  return [];
}

function executiveNumber(value: unknown) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const raw = String(value ?? "").trim().replace(/\s/g, "").replace(/\$/g, "");
  if (!raw) return 0;
  const normalized = raw.includes(",")
    ? raw.replace(/\./g, "").replace(",", ".")
    : raw.replace(/(?<=\d)\.(?=\d{3}(?:\D|$))/g, "");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function executiveProductSummary(payload: Record<string, unknown>) {
  const document = executiveNestedObject(payload, "document", "data");
  const source = Object.keys(document).length ? document : payload;
  const lines = executiveArray([source, payload], [
    "details", "items", "lines", "line_items", "products", "detalle", "detalles",
  ]);
  const products = lines.map((raw) => {
    const line = executiveObject(raw);
    const product = executiveNestedObject(line, "product", "item", "article", "articulo");
    const containers = [product, line];
    const name = String(executiveFirst(containers, [
      "product_name", "product_description", "line_description", "item_name", "name",
      "description", "descripcion", "label", "detail",
    ]) ?? "").trim();
    const sku = String(executiveFirst(containers, ["sku", "code", "product_code", "item_code", "codigo"]) ?? "").trim();
    const quantity = executiveNumber(executiveFirst(containers, ["quantity", "qty", "units", "cantidad"]));
    return { name: name || sku, sku, quantity };
  }).filter((item) => item.name);
  const unique = [...new Map(products.map((item) => [`${item.name.toLowerCase()}|${item.sku.toLowerCase()}`, item])).values()];
  if (!unique.length) return "Producto no informado por Facto";
  const visible = unique.slice(0, 3).map((item) => `${item.name}${item.quantity ? ` (${item.quantity.toLocaleString("es-CL")} un.)` : ""}`);
  return `Productos: ${visible.join(", ")}${unique.length > 3 ? ` y ${unique.length - 3} más` : ""}`;
}

function executiveDocumentDate(payload: Record<string, unknown>) {
  const compact = compactExecutiveDocument(payload);
  const raw = compact.issue_date;
  if (!raw) return null;
  const text = String(raw).trim();
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(text) ? new Date(`${text}T12:00:00-04:00`) : new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function executiveChileParts(date: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Santiago", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value || 0);
  return { year: read("year"), month: read("month"), day: read("day") };
}

function executiveIsRecentDocument(payload: Record<string, unknown>) {
  const date = executiveDocumentDate(payload);
  if (!date) return false;
  const current = executiveChileParts(new Date());
  const observed = executiveChileParts(date);
  const days = Math.round((Date.UTC(current.year, current.month - 1, current.day) - Date.UTC(observed.year, observed.month - 1, observed.day)) / 86_400_000);
  return days >= 0 && days <= 1;
}

function executiveFormatCurrency(value: number) {
  return new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 }).format(value);
}

function executiveDocumentNet(payload: Record<string, unknown>) {
  const compact = compactExecutiveDocument(payload);
  const amount = executiveNumber(compact.net_total ?? compact.total);
  const type = String(compact.document_type ?? "").toLowerCase();
  return type === "61" || type.includes("nota de credito") || type.includes("nota de crédito")
    ? -Math.abs(amount)
    : amount;
}

function executiveSaleItem(row: IntegrationPayloadRecord) {
  const compact = compactExecutiveDocument(row.payload);
  const customer = String(compact.customer_name ?? "Cliente sin identificar").trim();
  const folio = compact.document_number ? `Documento N° ${String(compact.document_number)}` : "Documento Facto";
  const net = executiveDocumentNet(row.payload);
  return {
    external_id: row.external_id,
    observed_at: row.updated_at,
    ...compact,
    title: customer,
    detail: `${executiveProductSummary(row.payload)} · ${folio}${net ? ` · Neto ${executiveFormatCurrency(net)}` : ""}`,
  };
}

function executiveStockItem(row: IntegrationPayloadRecord) {
  const rawStock = row.payload.available_units ?? row.payload.stock ?? row.payload.quantity ?? row.payload.existence;
  const title = String(row.payload.name ?? row.payload.product_name ?? row.payload.sku ?? "Producto sin identificar").trim();
  return {
    external_id: row.external_id,
    observed_at: row.updated_at,
    ...compactExecutivePayload(row.payload, executiveInventoryFields),
    title,
    detail: `Stock actual: ${executiveNumber(rawStock).toLocaleString("es-CL")} un.${row.payload.sku ? ` · SKU ${String(row.payload.sku)}` : ""}`,
  };
}

function executiveAgentUpdates(rows: Array<Record<string, unknown>>) {
  const seenActions = new Set<string>();
  const seenSummaries = new Set<string>();
  return rows.flatMap((item) => {
    const completed = new Date(String(item.completed_at ?? ""));
    if (Number.isNaN(completed.getTime()) || Date.now() - completed.getTime() > 30 * 60 * 60 * 1000) return [];
    const agentType = String(item.agent_type ?? "").trim();
    if (!agentType || agentType === "finance") return [];
    const action = String(item.action ?? "analysis").trim();
    const result = executiveObject(item.result);
    const summary = String(result.summary ?? "").trim();
    const actionKey = `${agentType}:${action}`.toLowerCase();
    const summaryKey = normalizeSearchText(summary).replace(/\s+/g, " ");
    if (!summary || seenActions.has(actionKey) || seenSummaries.has(summaryKey)) return [];
    seenActions.add(actionKey);
    seenSummaries.add(summaryKey);
    const labels: Record<string, string> = {
      commercial: "comercial", marketing: "de marketing", logistics: "logístico",
      foreign_trade: "de comercio exterior", collections: "de cobranza", accounting: "contable",
    };
    return [{
      id: item.id,
      agent_type: agentType,
      action,
      completed_at: item.completed_at,
      title: `Agente ${labels[agentType] ?? agentType.replace(/_/g, " ")}`,
      detail: summary,
      summary,
      metrics: result.metrics ?? {},
      warnings: Array.isArray(result.warnings) ? result.warnings.slice(0, 3) : [],
    }];
  });
}

function executiveMonthFinance(sales: IntegrationPayloadRecord[], purchases: IntegrationPayloadRecord[]) {
  const current = executiveChileParts(new Date());
  const currentMonth = (row: IntegrationPayloadRecord) => {
    const date = executiveDocumentDate(row.payload);
    if (!date) return false;
    const parts = executiveChileParts(date);
    return parts.year === current.year && parts.month === current.month;
  };
  const monthSales = sales.filter(currentMonth);
  const monthPurchases = purchases.filter(currentMonth);
  const salesNet = monthSales.reduce((total, row) => total + executiveDocumentNet(row.payload), 0);
  const purchasesNet = monthPurchases.reduce((total, row) => total + executiveDocumentNet(row.payload), 0);
  const month = new Intl.DateTimeFormat("es-CL", { timeZone: "America/Santiago", month: "long", year: "numeric" }).format(new Date());
  return {
    id: `finance-current-month-${current.year}-${current.month}`,
    agent_type: "finance",
    title: `Finanzas de ${month}`,
    detail: `Ventas netas del mes: ${executiveFormatCurrency(salesNet)} (${monthSales.length} documentos) · Compras netas del mes: ${executiveFormatCurrency(purchasesNet)} (${monthPurchases.length} documentos)`,
    summary: `Ventas y compras netas correspondientes exclusivamente al mes en curso (${month}).`,
  };
}

const executiveInventoryFields = [
  "sku", "name", "product_name", "available_units", "stock", "quantity", "existence",
  "reorder_point", "warehouse", "unit_cost", "unit_price",
];

function compactExecutiveSnapshot(payload: Record<string, unknown> | null | undefined, updatedAt?: string | null) {
  return {
    available: Boolean(payload && Object.keys(payload).length),
    updated_at: updatedAt ?? null,
    ...compactExecutivePayload(payload, [
      "period", "period_start", "period_end", "sales_total", "net_sales", "gross_sales",
      "purchases_total", "inventory_value", "receivables", "cash_balance", "currency", "generated_at",
    ]),
  };
}

function normalizeSearchText(value: unknown) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function isAdCargasInvoice(row: IntegrationPayloadRecord) {
  const searchable = normalizeSearchText(JSON.stringify(row.payload));
  return [
    "ad cargas internacional",
    "ads cargas internacional",
    "ads internacional cargo",
    "adscargas",
  ].some((alias) => searchable.includes(alias));
}

function isAgencyRodriguezReference(row: IntegrationPayloadRecord) {
  const searchable = normalizeSearchText(JSON.stringify(row.payload));
  return (
    searchable.includes("agenciarodriguezpalma.cl") ||
    searchable.includes("j.rodriguez@agenciarodriguezpalma.cl")
  );
}

const agents: Array<{
  type: AgentType;
  title: string;
  description: string;
  icon: typeof Bot;
}> = [
  { type: "commercial", title: "Agente comercial", description: "Cartera unificada, recurrencia y segmentos HVAC.", icon: UserRoundSearch },
  { type: "marketing", title: "Agente marketing", description: "Audiencias, productos y campañas trazables para revisión.", icon: Megaphone },
  { type: "finance", title: "Agente finanzas", description: "Márgenes y anomalías.", icon: CircleDollarSign },
  { type: "collections", title: "Agente cobranza", description: "Cartera vencida y recordatorios.", icon: WalletCards },
  { type: "logistics", title: "Agente logistico", description: "Rotacion, margen, sobrestock y bodega.", icon: Truck },
  { type: "foreign_trade", title: "Comercio exterior", description: "Stock, compras e importaciones.", icon: PackageSearch },
  { type: "executive", title: "Agente gerente", description: "Resumen y alertas prioritarias.", icon: Sparkles },
];

const defaultAction: Record<AgentType, string> = {
  commercial: "review_pipeline",
  marketing: "prepare_marketing_plan",
  finance: "review_margin",
  collections: "review_aging",
  logistics: "review_logistics",
  foreign_trade: "review_import_plan",
  executive: "prepare_brief",
};

const proposalDestinations: Record<string, { label: string; detail: string; path: string }> = {
  campaign_draft: {
    label: "Borrador en Campañas",
    detail: "crea la campaña y agrega las empresas CRM disponibles; no la envía",
    path: "/campanas",
  },
  purchase_order: {
    label: "Compra en Comercio Exterior",
    detail: "formaliza un borrador para revisión; no emite la orden al proveedor",
    path: "/agentes/foreign_trade/dashboard",
  },
  collection_reminder: {
    label: "Tarea de Cobranza",
    detail: "crea un seguimiento interno; no contacta al cliente",
    path: "/agentes/collections/dashboard",
  },
  commercial_follow_up: {
    label: "Tarea Comercial",
    detail: "deja el seguimiento pendiente en el agente comercial",
    path: "/agentes/commercial/dashboard",
  },
  executive_alert: {
    label: "Tarea Gerencial",
    detail: "registra la decisión prioritaria para seguimiento",
    path: "/agentes/executive/dashboard",
  },
};

function proposalDestination(kind: string) {
  return proposalDestinations[kind] ?? {
    label: "Acción trazable",
    detail: "queda registrada para revisión humana",
    path: "/agentes",
  };
}

function approvedActionPath(item: AgentActionItem) {
  const destination = item.destination_path || proposalDestination(item.kind).path;
  const taskDestinations = new Set(["collections", "commercial", "executive"]);

  if (!item.destination_record_id || !taskDestinations.has(item.destination_module)) {
    return destination;
  }

  const separator = destination.includes("?") ? "&" : "?";
  return `${destination}${separator}task=${encodeURIComponent(item.destination_record_id)}#approved-task`;
}

export function AgentsPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { companies } = useCompanyStore();
  const canManage = user?.role === "administrador";
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [actionItems, setActionItems] = useState<AgentActionItem[]>([]);
  const [alerts, setAlerts] = useState<RiskAlert[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase || !user) return;
    const [taskResult, proposalResult, alertResult, connectionResult, actionItemResult] = await Promise.all([
      supabase.from("business_agent_tasks").select("id,agent_type,action,status,created_at,result,error_code").order("created_at", { ascending: false }).limit(30),
      supabase.from("action_proposals").select("id,kind,title,summary,risk_level,status,created_at").order("created_at", { ascending: false }).limit(30),
      supabase.from("inventory_risk_alerts").select("id,sku,severity,title,detail,status").eq("status", "open").order("created_at", { ascending: false }).limit(30),
      supabase.from("integration_connections").select("provider,status,read_only,message,last_success_at").order("provider"),
      supabase.from("agent_action_items").select("id,proposal_id,kind,destination_module,destination_path,destination_record_id,title,summary,status,created_at").order("created_at", { ascending: false }).limit(20),
    ]);
    const firstError = taskResult.error || proposalResult.error || alertResult.error || connectionResult.error;
    if (firstError) {
      setNotice("Falta ejecutar supabase/agent_hub.sql en Supabase.");
      return;
    }
    setTasks((taskResult.data ?? []) as AgentTask[]);
    setProposals((proposalResult.data ?? []) as Proposal[]);
    setAlerts((alertResult.data ?? []) as RiskAlert[]);
    setConnections((connectionResult.data ?? []) as Connection[]);
    if (actionItemResult.error) {
      setActionItems([]);
      setNotice("Falta ejecutar supabase/agent_action_dispatch.sql en Supabase para activar los destinos de aprobación.");
    } else {
      setActionItems((actionItemResult.data ?? []) as AgentActionItem[]);
    }
  }, [user]);

  useEffect(() => {
    void load();
  }, [load]);

  async function requestAgent(type: AgentType) {
    if (!supabase || !user) return;
    setBusy(type);
    setNotice("");
    let error: { message: string } | null = null;
    let dashboardTaskId = "";
    let successMessage = "Tarea agregada. El Agent Hub la procesara con lease seguro.";
    if (type === "commercial") {
      const [commercialResult, financialResult] = await Promise.all([
        supabase
          .from("integration_records")
          .select("payload")
          .eq("provider", "facto")
          .eq("resource", "commercial_snapshots")
          .order("updated_at", { ascending: false })
          .limit(1),
        supabase
          .from("integration_records")
          .select("payload")
          .eq("provider", "facto")
          .eq("resource", "financial_snapshots")
          .order("updated_at", { ascending: false })
          .limit(1),
      ]);
      const inventorySnapshot: InventorySnapshotRecord["payload"][] = [];
      error = commercialResult.error || financialResult.error;
      if (!error) {
        for (let from = 0; ; from += 1000) {
          const { data, error: snapshotError } = await supabase
            .from("integration_records")
            .select("payload")
            .eq("provider", "facto")
            .eq("resource", "inventory_snapshots")
            .range(from, from + 999);
          if (snapshotError) {
            error = snapshotError;
            break;
          }
          const page = ((data ?? []) as InventorySnapshotRecord[])
            .map((row) => row.payload)
            .filter((item) => item.sku);
          inventorySnapshot.push(...page);
          if ((data ?? []).length < 1000) break;
        }
      }
      if (!error) {
        const commercialSnapshot = commercialResult.data?.[0]?.payload as
          | { customers?: Array<Record<string, unknown>>; sources?: Record<string, number> }
          | undefined;
        const financialSnapshot = financialResult.data?.[0]?.payload as
          | Record<string, unknown>
          | undefined;
        if (!commercialSnapshot?.customers?.length && !companies.length) {
          setBusy("");
          setNotice("Facto y Tiendanube aun estan preparando la cartera unificada. Espera la siguiente sincronizacion.");
          await load();
          return;
        }
        const crmCompanies = companies.map((company) => ({
          id: company.id,
          name: company.name,
          legal_name: company.legalName,
          rut: company.rut,
          email: company.email,
          phone: company.phone,
          whatsapp: company.whatsapp,
          whatsapp_number: company.whatsappNumber,
          type: company.type,
          status: company.status,
          priority: company.priority,
          region: company.region,
          city: company.city,
          source: company.source,
        }));
        const { data: insertedTask, error: insertError } = await supabase
          .from("business_agent_tasks")
          .insert({
            agent_type: "commercial",
            action: "review_customer_portfolio",
            requested_by: user.id,
            payload: {
              commercial_snapshot: commercialSnapshot?.customers ?? [],
              crm_companies: crmCompanies,
              source_counts: commercialSnapshot?.sources ?? {},
              financial_snapshot: financialSnapshot ?? {},
              inventory_snapshot: inventorySnapshot,
              as_of: new Date().toISOString().slice(0, 10),
            },
          })
          .select("id")
          .single();
        error = insertError;
        dashboardTaskId = insertedTask?.id ?? "";
        successMessage =
          `Analisis comercial enviado con ${commercialSnapshot?.customers?.length ?? 0} ` +
          `identidades de Facto/Tiendanube, ${crmCompanies.length} empresas CRM y ` +
          `${inventorySnapshot.length} SKU para detectar oportunidades cliente-producto.`;
      }
    } else if (type === "marketing") {
      const [commercialResult, financialResult] = await Promise.all([
        supabase
          .from("integration_records")
          .select("payload")
          .eq("provider", "facto")
          .eq("resource", "commercial_snapshots")
          .order("updated_at", { ascending: false })
          .limit(1),
        supabase
          .from("integration_records")
          .select("payload")
          .eq("provider", "facto")
          .eq("resource", "financial_snapshots")
          .order("updated_at", { ascending: false })
          .limit(1),
      ]);
      if (commercialResult.error || financialResult.error) {
        error = commercialResult.error || financialResult.error;
      } else {
        const commercialSnapshot = commercialResult.data?.[0]?.payload as
          | { customers?: Array<Record<string, unknown>>; sources?: Record<string, number> }
          | undefined;
        const financialSnapshot = financialResult.data?.[0]?.payload as
          | Record<string, unknown>
          | undefined;
        const inventorySnapshot: InventorySnapshotRecord["payload"][] = [];
        for (let from = 0; ; from += 1000) {
          const { data, error: snapshotError } = await supabase
            .from("integration_records")
            .select("payload")
            .eq("provider", "facto")
            .eq("resource", "inventory_snapshots")
            .range(from, from + 999);
          if (snapshotError) {
            error = snapshotError;
            break;
          }
          const page = ((data ?? []) as InventorySnapshotRecord[])
            .map((row) => row.payload)
            .filter((item) => item.sku);
          inventorySnapshot.push(...page);
          if ((data ?? []).length < 1000) break;
        }
        if (!error) {
          if (!commercialSnapshot?.customers?.length && !companies.length) {
            setBusy("");
            setNotice("Aún no existe una cartera sincronizada para preparar campañas.");
            await load();
            return;
          }
          const crmCompanies = companies.map((company) => ({
            id: company.id,
            name: company.name,
            legal_name: company.legalName,
            rut: company.rut,
            email: company.email,
            phone: company.phone,
            whatsapp: company.whatsapp,
            whatsapp_number: company.whatsappNumber,
            type: company.type,
            status: company.status,
            priority: company.priority,
            region: company.region,
            city: company.city,
            source: company.source,
          }));
          const { data: insertedTask, error: insertError } = await supabase
            .from("business_agent_tasks")
            .insert({
              agent_type: "marketing",
              action: defaultAction.marketing,
              requested_by: user.id,
              payload: {
                commercial_snapshot: commercialSnapshot?.customers ?? [],
                crm_companies: crmCompanies,
                source_counts: commercialSnapshot?.sources ?? {},
                financial_snapshot: financialSnapshot ?? {},
                inventory_snapshot: inventorySnapshot,
                as_of: new Date().toISOString().slice(0, 10),
                business_context: {
                  high_season_months: [11, 12, 1, 2],
                  automatic_sending: false,
                  approved_benefits: {},
                  meta_whatsapp_pending_approval: true,
                },
              },
            })
            .select("id")
            .single();
          error = insertError;
          dashboardTaskId = insertedTask?.id ?? "";
          successMessage = `Plan de marketing enviado con ${commercialSnapshot?.customers?.length ?? 0} identidades, ${crmCompanies.length} empresas CRM y ${inventorySnapshot.length} SKU. Todo quedará en borrador para revisión humana.`;
        }
      }
    } else if (type === "foreign_trade" || type === "logistics") {
      const snapshots: InventorySnapshotRecord["payload"][] = [];
      for (let from = 0; ; from += 1000) {
        const { data, error: snapshotError } = await supabase
          .from("integration_records")
          .select("payload")
          .eq("provider", "facto")
          .eq("resource", "inventory_snapshots")
          .range(from, from + 999);
        if (snapshotError) {
          error = snapshotError;
          break;
        }
        const page = ((data ?? []) as InventorySnapshotRecord[])
          .map((row) => row.payload)
          .filter((item) => item.sku);
        snapshots.push(...page);
        if ((data ?? []).length < 1000) break;
      }
      if (!error) {
        if (!snapshots.length) {
          setBusy("");
          setNotice("Facto aun no entrego productos para el analisis. Espera la siguiente sincronizacion.");
          await load();
          return;
        }
        if (type === "logistics") {
          const { data: insertedTask, error: insertError } = await supabase
            .from("business_agent_tasks")
            .insert({
              agent_type: "logistics",
              action: defaultAction.logistics,
              requested_by: user.id,
              payload: { products: snapshots },
            })
            .select("id")
            .single();
          error = insertError;
          dashboardTaskId = insertedTask?.id ?? "";
          successMessage = `Analisis logistico enviado con ${snapshots.length} SKU sincronizados desde Facto. Los hallazgos se transformaran en propuestas revisables.`;
        } else {
          const today = new Date().toISOString().slice(0, 10);
          const freightRecords: IntegrationPayloadRecord[] = [];
          for (let from = 0; ; from += 1000) {
            const { data: freightPage, error: freightError } = await supabase
              .from("integration_records")
              .select("external_id,resource,payload,updated_at")
              .eq("provider", "facto")
              .in("resource", ["purchase_documents", "purchase_document_details"])
              .range(from, from + 999);
            if (freightError) {
              error = freightError;
              break;
            }
            freightRecords.push(...((freightPage ?? []) as IntegrationPayloadRecord[]));
            if ((freightPage ?? []).length < 1000) break;
          }
          let gmailReferenceSyncNote = "";
          try {
            const gmailSync = await syncGmailCustomsReferences();
            gmailReferenceSyncNote = `Gmail reviso ${gmailSync.checked} correo(s) y dejo ${gmailSync.synced} referencia(s) trazables.`;
          } catch (gmailSyncError) {
            const message = gmailSyncError instanceof Error ? gmailSyncError.message : "No se pudo actualizar Gmail.";
            gmailReferenceSyncNote = `No se pudo refrescar Gmail en esta ejecucion (${message}); se conservaron las referencias historicas ya verificadas.`;
          }
          const customsReferenceRecords: IntegrationPayloadRecord[] = [];
          for (let from = 0; ; from += 1000) {
            const { data: gmailPage, error: gmailError } = await supabase
              .from("integration_records")
              .select("external_id,resource,payload,updated_at")
              .eq("provider", "gmail")
              .eq("resource", "customs_cost_references")
              .range(from, from + 999);
            if (gmailError) {
              error = gmailError;
              break;
            }
            customsReferenceRecords.push(...((gmailPage ?? []) as IntegrationPayloadRecord[]));
            if ((gmailPage ?? []).length < 1000) break;
          }
          if (error) {
            setBusy("");
            setNotice(`No se pudieron consultar las evidencias de costos en el CRM: ${error.message}`);
            await load();
            return;
          }
          const freightByDocument = new Map<string, Record<string, unknown>>();
          freightRecords
            .filter(isAdCargasInvoice)
            .sort((left, right) =>
              left.resource === right.resource
                ? 0
                : left.resource === "purchase_documents"
                  ? -1
                  : 1,
            )
            .forEach((row, index) => {
              const key = row.external_id || String(row.payload.document_id ?? row.payload.id ?? index);
              freightByDocument.set(key, {
                ...row.payload,
                crm_external_id: row.external_id,
                crm_resource: row.resource,
                crm_updated_at: row.updated_at,
              });
            });
          const freightInvoices = Array.from(freightByDocument.values());
          const customsCostReferences = customsReferenceRecords
            .filter(isAgencyRodriguezReference)
            .map((row) => ({
              ...row.payload,
              crm_external_id: row.external_id,
              crm_resource: row.resource,
              crm_updated_at: row.updated_at,
            }));
          const { data: insertedTask, error: insertError } = await supabase
            .from("business_agent_tasks")
            .insert({
              agent_type: "foreign_trade",
              action: defaultAction.foreign_trade,
              requested_by: user.id,
              payload: {
                products: snapshots,
                as_of: today,
                freight_invoices: freightInvoices,
                customs_cost_references: customsCostReferences,
                sources: [
                  "facto_read_only",
                  "crm/facto/purchase_documents/ad_cargas_internacional",
                  "gmail/agenciarodriguezpalma.cl/j.rodriguez",
                  "google_drive/agente comercio exterior/chinafore proveedor",
                  "google_drive/agente comercio exterior/agencia",
                ],
              },
            })
            .select("id")
            .single();
          error = insertError;
          dashboardTaskId = insertedTask?.id ?? "";
          successMessage = `Analisis de comercio exterior enviado con ${snapshots.length} SKU, ${freightInvoices.length} factura(s) AD/ADS Cargas y ${customsCostReferences.length} referencia(s) sincronizada(s) de Agencia Rodriguez Palma. ${gmailReferenceSyncNote} Los importes historicos son referencias variables, no tarifas fijas.`;
        }
      }
    } else if (type === "finance") {
      const { data: financialRows, error: financialError } = await supabase
        .from("integration_records")
        .select("payload")
        .eq("provider", "facto")
        .eq("resource", "financial_snapshots")
        .order("updated_at", { ascending: false })
        .limit(1);
      if (financialError) {
        error = financialError;
      } else {
        const financialSnapshot = financialRows?.[0]?.payload;
        if (!financialSnapshot) {
          setBusy("");
          setNotice("Facto aun esta preparando el resumen financiero. Espera la siguiente sincronizacion y vuelve a intentarlo.");
          await load();
          return;
        }
        const { data: insertedTask, error: insertError } = await supabase
          .from("business_agent_tasks")
          .insert({
            agent_type: "finance",
            action: defaultAction.finance,
            requested_by: user.id,
            payload: { financial_snapshot: financialSnapshot },
          })
          .select("id")
          .single();
        error = insertError;
        dashboardTaskId = insertedTask?.id ?? "";
        successMessage = `Analisis financiero enviado con ${Number(financialSnapshot.document_count ?? 0)} documentos reales de Facto.`;
      }
    } else if (type === "collections") {
      const { data: financialRows, error: financialError } = await supabase
        .from("integration_records")
        .select("payload")
        .eq("provider", "facto")
        .eq("resource", "financial_snapshots")
        .order("updated_at", { ascending: false })
        .limit(1);
      if (financialError) {
        error = financialError;
      } else {
        const financialSnapshot = financialRows?.[0]?.payload as
          | {
              collections?: {
                mode?: string;
                authoritative?: boolean;
                overdue_amount?: number;
                documents_detail?: Array<{
                  document_id?: string;
                  document_number?: string;
                  customer?: string;
                  tax_id?: string;
                  observed_amount?: number;
                  days_overdue?: number;
                }>;
              };
            }
          | undefined;
        const collections = financialSnapshot?.collections;
        const verifiedCollections = (
          ["facto_receivables", "facto_document_pdf"].includes(collections?.mode ?? "")
          && collections?.authoritative === true
        );
        const documents = verifiedCollections
          ? (collections?.documents_detail ?? []).filter((item) => Number(item.observed_amount ?? 0) > 0)
          : [];
        const { data: insertedTask, error: insertError } = await supabase
          .from("business_agent_tasks")
          .insert({
            agent_type: "collections",
            action: defaultAction.collections,
            requested_by: user.id,
            payload: {
              source: verifiedCollections ? collections?.mode : "unavailable",
              authoritative: verifiedCollections,
              overdue_amount: verifiedCollections ? Number(collections?.overdue_amount ?? 0) : 0,
              invoice_ids: documents
                .map((item) => item.document_id)
                .filter((item): item is string => Boolean(item)),
              documents,
            },
          })
          .select("id")
          .single();
        error = insertError;
        dashboardTaskId = insertedTask?.id ?? "";
        successMessage = verifiedCollections
          ? `Cobranza verificada enviada con ${documents.length} documentos y saldo exacto informado por Facto.`
          : "Facto aun no entrega la ruta oficial Cobranza -> Documentos impagos ni saldos exactos en sus PDF. No se calculo deuda desde totales de facturas ni pagos.";
      }
    } else if (type === "executive") {
      const [
        documentsResult,
        purchasesResult,
        inventoryResult,
        proposalsResult,
        emailRepliesResult,
        whatsappRepliesResult,
        agentUpdatesResult,
        integrationsResult,
        financeResult,
        commercialResult,
      ] = await Promise.all([
        supabase
          .from("integration_records")
          .select("external_id,payload,updated_at")
          .eq("provider", "facto")
          .eq("resource", "document_details")
          .order("updated_at", { ascending: false })
          .limit(500),
        supabase
          .from("integration_records")
          .select("external_id,payload,updated_at")
          .eq("provider", "facto")
          .eq("resource", "purchase_document_details")
          .order("updated_at", { ascending: false })
          .limit(500),
        supabase
          .from("integration_records")
          .select("external_id,payload,updated_at")
          .eq("provider", "facto")
          .eq("resource", "inventory_snapshots")
          .order("updated_at", { ascending: false })
          .limit(500),
        supabase
          .from("action_proposals")
          .select("id,kind,title,summary,risk_level,created_at")
          .eq("status", "pending")
          .order("created_at", { ascending: false })
          .limit(30),
        supabase
          .from("email_campaign_recipients")
          .select("id,campaign_id,company_id,reply_from_email,reply_subject,reply_snippet,replied_at")
          .not("replied_at", "is", null)
          .order("replied_at", { ascending: false })
          .limit(20),
        supabase
          .from("whatsapp_messages")
          .select("id,company_id,phone_number,body,occurred_at,created_at")
          .eq("direction", "incoming")
          .order("occurred_at", { ascending: false, nullsFirst: false })
          .limit(20),
        supabase
          .from("business_agent_tasks")
          .select("id,agent_type,action,result,completed_at")
          .eq("status", "completed")
          .neq("agent_type", "executive")
          .order("completed_at", { ascending: false })
          .limit(80),
        supabase
          .from("integration_connections")
          .select("provider,status,message,last_checked_at")
          .in("status", ["error", "degraded"]),
        supabase
          .from("integration_records")
          .select("payload,updated_at")
          .eq("provider", "facto")
          .eq("resource", "financial_snapshots")
          .order("updated_at", { ascending: false })
          .limit(1),
        supabase
          .from("integration_records")
          .select("payload,updated_at")
          .eq("provider", "facto")
          .eq("resource", "commercial_snapshots")
          .order("updated_at", { ascending: false })
          .limit(1),
      ]);
      const queryError = [
        documentsResult.error,
        purchasesResult.error,
        inventoryResult.error,
        proposalsResult.error,
        emailRepliesResult.error,
        whatsappRepliesResult.error,
        agentUpdatesResult.error,
        integrationsResult.error,
        financeResult.error,
        commercialResult.error,
      ].find(Boolean) ?? null;
      if (queryError) {
        error = queryError;
      } else {
        const stockouts = ((inventoryResult.data ?? []) as IntegrationPayloadRecord[])
          .filter((row) => {
            const payload = row.payload ?? {};
            const raw = payload.available_units ?? payload.stock ?? payload.quantity ?? payload.existence;
            return raw !== null && raw !== undefined && Number(raw) <= 0;
          })
          .slice(0, 30);
        const emailReplies = (emailRepliesResult.data ?? []).map((item) => ({ ...item, channel: "email" }));
        const whatsappReplies = (whatsappRepliesResult.data ?? []).map((item) => ({ ...item, channel: "whatsapp" }));
        const documentRows = (documentsResult.data ?? []) as IntegrationPayloadRecord[];
        const purchaseRows = (purchasesResult.data ?? []) as IntegrationPayloadRecord[];
        const sales = documentRows
          .filter((row) => executiveIsRecentDocument(row.payload))
          .map(executiveSaleItem)
          .slice(0, 20);
        const compactStockouts = stockouts.map(executiveStockItem);
        const agentUpdates = [
          executiveMonthFinance(documentRows, purchaseRows),
          ...executiveAgentUpdates((agentUpdatesResult.data ?? []) as Array<Record<string, unknown>>),
        ].slice(0, 20);
        const { data: insertedTask, error: insertError } = await supabase
          .from("business_agent_tasks")
          .insert({
            agent_type: "executive",
            action: "analyze_company",
            requested_by: user.id,
            priority: 100,
            payload: {
              mode: "manual",
              generated_at: new Date().toISOString(),
              delivery: {
                auto_send: false,
                email: true,
                email_to: "msanhueza237@gmail.com",
                whatsapp: false,
                whatsapp_status: "pending_meta_approval",
              },
              signals: {
                sales,
                stockouts: compactStockouts,
                opportunities: proposalsResult.data ?? [],
                campaign_replies: [...emailReplies, ...whatsappReplies],
                agent_updates: agentUpdates,
                integration_errors: integrationsResult.data ?? [],
              },
              context: {
                financial_snapshot: compactExecutiveSnapshot(
                  financeResult.data?.[0]?.payload ?? {},
                  financeResult.data?.[0]?.updated_at,
                ),
                commercial_snapshot: compactExecutiveSnapshot(
                  commercialResult.data?.[0]?.payload ?? {},
                  commercialResult.data?.[0]?.updated_at,
                ),
              },
            },
          })
          .select("id")
          .single();
        error = insertError;
        dashboardTaskId = insertedTask?.id ?? "";
        successMessage = `Análisis gerencial solicitado con ${sales.length} ventas de ayer/hoy, ${stockouts.length} quiebres observados, ${proposalsResult.data?.length ?? 0} propuestas y ${emailReplies.length + whatsappReplies.length} respuestas de clientes. Esta consulta manual no envía correo.`;
      }
    } else {
      const response = await supabase.from("business_agent_tasks").insert({
        agent_type: type,
        action: defaultAction[type],
        payload: {},
        requested_by: user.id,
      });
      error = response.error;
    }
    setBusy("");
    setNotice(error ? error.message : successMessage);
    await load();
    if (!error) {
      const taskQuery = dashboardTaskId ? `?task=${dashboardTaskId}` : "";
      navigate(`/agentes/${type}/dashboard${taskQuery}`);
    }
  }

  async function decideProposal(id: string, decision: "approved" | "rejected") {
    if (!supabase) return;
    setBusy(id);
    const { data, error } = await supabase.rpc("decide_action_proposal", {
      p_proposal_id: id,
      p_decision: decision,
      p_note: decision === "approved" ? "Aprobado desde el centro de agentes" : "Rechazado desde el centro de agentes",
    });
    const result = data as ProposalDecisionResult | null;
    setBusy("");
    setNotice(
      error
        ? error.message
        : result?.message ?? (decision === "approved" ? "Propuesta aprobada y materializada." : "Propuesta rechazada."),
    );
    await load();
  }

  return (
    <section className="agents-page">
      <div className="page-heading agent-heading">
        <div>
          <span className="eyebrow">CENTRO OPERACIONAL</span>
          <h1>Agentes Climactiva</h1>
          <p>Analizan información y preparan propuestas. Ningún agente compra, cobra ni envía campañas sin aprobación.</p>
        </div>
        <button className="ghost-button" type="button" onClick={() => void load()}>
          <RefreshCw size={18} /> Actualizar
        </button>
      </div>

      {notice ? <div className="notice-banner info">{notice}</div> : null}
      {!canManage ? <div className="notice-banner info">Vista de solo lectura. Solo un administrador puede solicitar análisis o decidir propuestas.</div> : null}

      <section className="agent-command-card">
        <div>
          <span className="eyebrow">REGLAS DEL CENTRO</span>
          <h2>El CRM decide; los agentes preparan evidencia</h2>
          <p>
            Facto es la fuente principal para stock, ventas y documentos. Tiendanube complementa productos,
            pedidos web y clientes online. Los agentes solo preparan analisis y propuestas: ninguna compra,
            cobranza o campana sale sin revision humana.
          </p>
        </div>
        <div className="agent-policy-grid">
          <article>
            <strong>95 dias</strong>
            <span>45 produccion · 45 viaje · 5 aduana</span>
          </article>
          <article>
            <strong>USD 50k-70k</strong>
            <span>rango objetivo por orden china</span>
          </article>
          <article>
            <strong>Nov-Feb</strong>
            <span>temporada alta; febrero baja produccion china</span>
          </article>
        </div>
      </section>

      <div className="agent-grid">
        {agents.map((agent) => {
          const latest = tasks.find((task) => task.agent_type === agent.type);
          return (
            <article className="agent-card" key={agent.type}>
              <agent.icon size={26} />
              <div>
                <h2>{agent.title}</h2>
                <p>{agent.description}</p>
                <small>Última tarea: {latest ? `${latest.status} · ${new Date(latest.created_at).toLocaleString("es-CL")}` : "sin ejecutar"}</small>
                {latest?.result?.summary ? <p className="agent-result-summary">{latest.result.summary}</p> : null}
                {latest?.result?.warnings?.map((warning) => (
                  <small className="agent-result-warning" key={warning}>{warning}</small>
                ))}
                {latest?.status === "failed" ? (
                  <p className="agent-result-warning">El análisis falló{latest.error_code ? ` (${latest.error_code})` : ""}. Puedes solicitarlo nuevamente.</p>
                ) : null}
              </div>
              <button className="primary-button" type="button" disabled={!canManage || busy === agent.type} onClick={() => void requestAgent(agent.type)}>
                {busy === agent.type ? "Solicitando..." : "Solicitar análisis"}
              </button>
              <Link className="ghost-button agent-dashboard-link" to={`/agentes/${agent.type}/dashboard`}>
                Ver dashboard
              </Link>
            </article>
          );
        })}
      </div>

      <div className="agent-columns">
        <section className="data-card">
          <div className="section-title">
            <div><h2>Propuestas pendientes</h2><p>Revisión humana obligatoria.</p></div>
            <span className="count-pill">{proposals.filter((item) => item.status === "pending").length}</span>
          </div>
          <div className="agent-list">
            {proposals.filter((item) => item.status === "pending").map((proposal) => (
              <article key={proposal.id}>
                <div>
                  <strong>{proposal.title}</strong>
                  <p>{proposal.summary}</p>
                  <small>Riesgo: {proposal.risk_level}</small>
                  <small className="proposal-destination">
                    Al aprobar: <strong>{proposalDestination(proposal.kind).label}</strong>. {proposalDestination(proposal.kind).detail}.
                  </small>
                </div>
                {canManage ? <div className="proposal-actions">
                  <button className="ghost-button" type="button" disabled={busy === proposal.id} onClick={() => void decideProposal(proposal.id, "rejected")}><XCircle size={16} /> Rechazar</button>
                  <button className="primary-button" type="button" disabled={busy === proposal.id} onClick={() => void decideProposal(proposal.id, "approved")}><CheckCircle2 size={16} /> Aprobar</button>
                </div> : null}
              </article>
            ))}
            {!proposals.some((item) => item.status === "pending") ? <p>No hay propuestas pendientes.</p> : null}
          </div>
        </section>

        <section className="data-card">
          <div className="section-title"><div><h2>Riesgo de inventario</h2><p>Quiebres y compras sugeridas.</p></div><AlertTriangle size={22} /></div>
          <div className="agent-list">
            {alerts.map((alert) => <article key={alert.id}><div><strong>{alert.sku} · {alert.title}</strong><p>{alert.detail}</p><small>Severidad: {alert.severity}</small></div></article>)}
            {!alerts.length ? <p>No hay alertas abiertas.</p> : null}
          </div>
        </section>
      </div>

      <section className="data-card approved-actions-card">
        <div className="section-title">
          <div>
            <h2>Acciones aprobadas</h2>
            <p>Cada aprobación muestra qué creó y dónde debes continuar.</p>
          </div>
          <span className="count-pill">{actionItems.length}</span>
        </div>
        <div className="approved-actions-list">
          {actionItems.map((item) => (
            <article key={item.id}>
              <div>
                <span className={`status-chip ${item.status === "draft" ? "pending" : "success"}`}>
                  {item.status === "draft" ? "Borrador" : "Pendiente de revisión"}
                </span>
                <strong>{item.title}</strong>
                <p>{item.summary || proposalDestination(item.kind).detail}</p>
                <small>{new Date(item.created_at).toLocaleString("es-CL")}</small>
              </div>
              <Link className="ghost-button approved-action-link" to={approvedActionPath(item)}>
                Abrir {proposalDestination(item.kind).label}
              </Link>
            </article>
          ))}
          {!actionItems.length ? <p>Aún no hay propuestas aprobadas con destino materializado.</p> : null}
        </div>
      </section>

      <section className="data-card">
        <div className="section-title"><div><h2>Conexiones del centro</h2><p>Los secretos permanecen en Dokploy.</p></div></div>
        <div className="connection-grid">
          {connections.map((connection) => (
            <article key={connection.provider}>
              <strong>{connection.provider}</strong>
              <span className={`status-chip ${connection.status === "connected" ? "success" : "pending"}`}>{connection.status}</span>
              <small>{connection.read_only ? "Solo lectura" : "Operacional controlada"} · {connection.message || "Sin detalle"}</small>
            </article>
          ))}
        </div>
      </section>
    </section>
  );
}
