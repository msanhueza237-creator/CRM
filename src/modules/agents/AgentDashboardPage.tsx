import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  BarChart3,
  Boxes,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleDollarSign,
  Database,
  PackageCheck,
  RefreshCw,
  Search,
  TrendingUp,
} from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { isSupabaseConfigured, supabase } from "../../lib/supabase";

type AgentTask = {
  id: string;
  agent_type: string;
  status: string;
  created_at: string;
  completed_at?: string | null;
  result?: {
    summary?: string;
    metrics?: Record<string, string | number | boolean | null>;
    warnings?: string[];
    evidence?: Array<Record<string, unknown>>;
  } | null;
  error_code?: string | null;
};

type Snapshot = {
  sku?: string;
  name?: string;
  available_units?: number;
  stock_known?: boolean;
  unit_cost_source?: number;
  cost_available_in_source?: boolean;
  cost_requires_usd_conversion?: boolean;
  unit_price?: number;
  unit_price_source?: number;
  unit_price_is_net?: boolean;
  source_price_includes_tax?: boolean;
  price_known?: boolean;
  margin_percent?: number | null;
  average_daily_demand?: number;
  demand_available?: boolean;
  sales_history_available?: boolean;
  units_sold_observed?: number;
  sales_revenue_observed?: number;
  sales_document_count?: number;
  last_sale_at?: string | null;
  has_observed_sales?: boolean;
  sales_history_start?: string | null;
  sales_history_end?: string | null;
  demand_observation_days?: number;
  source?: string;
};

type FinancialMonth = {
  month: string;
  net_sales: number;
  tax: number;
  gross_sales: number;
  documents: number;
};

type FinancialPurchaseMonth = {
  month: string;
  net_purchases: number;
  documents: number;
};

type FinancialRanking = {
  name?: string;
  tax_id?: string;
  sku?: string;
  net_sales?: number;
  net_sales_observed?: number;
  documents?: number;
  units?: number;
};

type SupplierRanking = {
  name?: string;
  tax_id?: string;
  net_purchases?: number;
  documents?: number;
  years?: Record<string, { net_purchases: number; documents: number }>;
};

type FinancialYearMonthComparison = {
  month: number;
  label: string;
  current_net_sales: number;
  previous_net_sales: number;
  current_net_purchases?: number;
  previous_net_purchases?: number;
};

type FinancialYearComparison = {
  current_year: number;
  previous_year: number;
  cutoff_date: string;
  previous_cutoff_date: string;
  current_ytd_net_sales: number;
  previous_ytd_net_sales: number;
  previous_full_year_net_sales: number;
  growth_amount: number;
  growth_percent?: number | null;
  current_ytd_documents: number;
  previous_ytd_documents: number;
  current_ytd_net_purchases?: number;
  previous_ytd_net_purchases?: number;
  previous_full_year_net_purchases?: number;
  purchase_growth_amount?: number;
  purchase_growth_percent?: number | null;
  current_ytd_purchase_documents?: number;
  previous_ytd_purchase_documents?: number;
  months: FinancialYearMonthComparison[];
};

type CollectionAging = {
  bucket: string;
  amount: number;
  documents: number;
};

type CollectionCustomer = {
  name?: string;
  tax_id?: string;
  amount: number;
  overdue: number;
  due_next_30: number;
  documents: number;
  max_days_overdue: number;
  oldest_due_date?: string | null;
};

type CollectionReport = {
  mode: "registered_payments" | "documentary_credit";
  payments_available: boolean;
  as_of: string;
  reviewed_documents?: number;
  reviewed_amount?: number;
  credit_documents?: number;
  credit_amount?: number;
  cash_documents?: number;
  cash_amount?: number;
  unclassified_documents?: number;
  unclassified_amount?: number;
  classification_status?: "complete" | "partial" | "missing";
  observed_amount: number;
  overdue_amount: number;
  due_next_30: number;
  documents: number;
  overdue_documents: number;
  payments_registered: number;
  payment_count: number;
  aging: CollectionAging[];
  customers: CollectionCustomer[];
  payments_by_month: Array<{ month: string; amount: number; payments: number }>;
  disclaimer: string;
};

type DocumentaryCashFlow = {
  net_sales: number;
  net_purchases: number;
  documentary_difference: number;
  payments_registered: number;
  payment_count: number;
  cash_balance_available: boolean;
  bank_balance_available: boolean;
  disclaimer: string;
};

type FinancialReport = {
  period_start?: string | null;
  period_end?: string | null;
  document_count: number;
  net_sales: number;
  tax: number;
  gross_sales: number;
  net_purchases?: number;
  purchase_document_count?: number;
  average_net_ticket: number;
  reference_gross_margin: number;
  reference_margin_available: boolean;
  sales_by_month: FinancialMonth[];
  purchases_by_month?: FinancialPurchaseMonth[];
  year_comparison?: FinancialYearComparison;
  top_customers: FinancialRanking[];
  customer_count?: number;
  top_suppliers?: SupplierRanking[];
  supplier_count?: number;
  purchases_available?: boolean;
  top_products: FinancialRanking[];
  collections?: CollectionReport;
  credit_exposure_available?: boolean;
  documentary_cash_flow?: DocumentaryCashFlow;
  receivables_available: boolean;
  expenses_available: boolean;
  cash_balance_available: boolean;
};

const agentNames: Record<string, string> = {
  commercial: "Comercial",
  marketing: "Marketing",
  finance: "Finanzas",
  collections: "Cobranza",
  logistics: "Logística",
  foreign_trade: "Comercio exterior",
  executive: "Gerencia",
};

const formatNumber = new Intl.NumberFormat("es-CL", { maximumFractionDigits: 1 });
const formatCurrency = new Intl.NumberFormat("es-CL", {
  style: "currency",
  currency: "CLP",
  maximumFractionDigits: 0,
});
const CHILE_VAT_FACTOR = 1.19;

function netUnitPrice(item: Snapshot) {
  const normalizedPrice = Number(item.unit_price ?? 0);
  const hasSourcePrice = Number(item.unit_price_source ?? 0) > 0;
  const sourcePrice = Number(item.unit_price_source ?? normalizedPrice);

  // Regla comercial de Clima Activa: el precio original del catálogo Facto
  // corresponde al valor final con IVA, incluso cuando el proveedor lo etiqueta
  // como unit_net. El dashboard siempre trabaja con el precio neto sin IVA.
  if (hasSourcePrice) return sourcePrice / CHILE_VAT_FACTOR;

  // Compatibilidad con snapshots antiguos que no conservaron el precio original.
  if (item.unit_price_is_net === true) return normalizedPrice;
  return normalizedPrice / CHILE_VAT_FACTOR;
}

async function loadAllSnapshots(): Promise<Snapshot[]> {
  if (!supabase) return [];
  const result: Snapshot[] = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from("integration_records")
      .select("payload")
      .eq("provider", "facto")
      .eq("resource", "inventory_snapshots")
      .range(from, from + pageSize - 1);
    if (error) throw error;
    const rows = (data ?? []) as Array<{ payload: Snapshot }>;
    result.push(...rows.map((row) => row.payload).filter((row) => row?.sku));
    if (rows.length < pageSize) break;
  }
  return result;
}

function GenericAgentDashboard({ agentType, tasks }: { agentType: string; tasks: AgentTask[] }) {
  const latest = tasks[0];
  const metrics = Object.entries(latest?.result?.metrics ?? {});
  return (
    <>
      <section className="agent-dashboard-kpis">
        <article>
          <Database size={22} />
          <span>Estado del último análisis</span>
          <strong>{latest?.status ?? "Sin ejecutar"}</strong>
        </article>
        <article>
          <CheckCircle2 size={22} />
          <span>Análisis registrados</span>
          <strong>{tasks.length}</strong>
        </article>
        {metrics.slice(0, 4).map(([key, value]) => (
          <article key={key}>
            <BarChart3 size={22} />
            <span>{key.replace(/_/g, " ")}</span>
            <strong>{String(value ?? "Sin dato")}</strong>
          </article>
        ))}
      </section>
      <section className="data-card agent-dashboard-summary">
        <span className="eyebrow">ÚLTIMO INFORME</span>
        <h2>{agentNames[agentType] ?? agentType}</h2>
        <p>{latest?.result?.summary ?? "Este agente todavía no tiene un análisis terminado."}</p>
        {latest?.result?.warnings?.map((warning) => (
          <div className="dashboard-warning" key={warning}>
            <AlertTriangle size={18} /> {warning}
          </div>
        ))}
      </section>
    </>
  );
}

type DonutSlice = {
  label: string;
  value: number;
  color: string;
};

function DonutChart({
  title,
  subtitle,
  slices,
  centerValue,
  centerLabel,
  formatter = (value: number) => formatNumber.format(value),
}: {
  title: string;
  subtitle: string;
  slices: DonutSlice[];
  centerValue: string;
  centerLabel: string;
  formatter?: (value: number) => string;
}) {
  const total = slices.reduce((sum, slice) => sum + Math.max(0, slice.value), 0);
  let cursor = 0;
  const stops = slices.map((slice) => {
    const start = cursor;
    cursor += total ? (Math.max(0, slice.value) / total) * 100 : 0;
    return `${slice.color} ${start}% ${cursor}%`;
  });
  const background = total ? `conic-gradient(${stops.join(", ")})` : "#e8eff0";

  return (
    <article className="data-card logistics-donut-card">
      <div className="section-title">
        <div>
          <h2>{title}</h2>
          <p>{subtitle}</p>
        </div>
      </div>
      <div className="donut-chart-layout">
        <div aria-label={`${title}: ${centerValue}`} className="donut-ring" role="img" style={{ background }}>
          <div className="donut-center">
            <strong>{centerValue}</strong>
            <span>{centerLabel}</span>
          </div>
        </div>
        <div className="donut-legend">
          {slices.map((slice) => (
            <article key={slice.label}>
              <span className="donut-legend-color" style={{ background: slice.color }} />
              <div>
                <span>{slice.label}</span>
                <strong>{formatter(slice.value)}</strong>
              </div>
            </article>
          ))}
        </div>
      </div>
    </article>
  );
}

function financialReportFromTask(task?: AgentTask): FinancialReport | null {
  for (const entry of task?.result?.evidence ?? []) {
    const report = entry.financial_report;
    if (report && typeof report === "object") return report as FinancialReport;
  }
  return null;
}

function monthLabel(value: string) {
  if (value === "sin_fecha") return "Sin fecha";
  const [year, month] = value.split("-").map(Number);
  if (!year || !month) return value;
  return new Intl.DateTimeFormat("es-CL", { month: "short", year: "2-digit" })
    .format(new Date(year, month - 1, 1))
    .replace(".", "");
}

function normalizeCustomerSearch(value: string | undefined) {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toLocaleLowerCase("es-CL");
}

function financialDateLabel(value: string | undefined) {
  if (!value) return "sin fecha";
  const parsed = new Date(`${value}T12:00:00`);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("es-CL", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(parsed);
}

function FinanceDashboard({ tasks }: { tasks: AgentTask[] }) {
  const latest = tasks[0];
  const report = financialReportFromTask(latest);
  const [selectedMonth, setSelectedMonth] = useState("all");
  const [customerQuery, setCustomerQuery] = useState("");
  const [customerSort, setCustomerSort] = useState("amount_desc");
  const [supplierQuery, setSupplierQuery] = useState("");
  const [supplierYear, setSupplierYear] = useState("all");
  const [collectionQuery, setCollectionQuery] = useState("");
  const [collectionSort, setCollectionSort] = useState("amount_desc");
  const filteredCustomers = useMemo(() => {
    const query = normalizeCustomerSearch(customerQuery);
    const rows = (report?.top_customers ?? []).filter((item) => {
      if (!query) return true;
      return (
        normalizeCustomerSearch(item.name).includes(query) ||
        normalizeCustomerSearch(item.tax_id).includes(query)
      );
    });

    return [...rows].sort((left, right) => {
      if (customerSort === "amount_asc") {
        return Number(left.net_sales ?? 0) - Number(right.net_sales ?? 0);
      }
      if (customerSort === "name_asc") {
        return (left.name ?? "").localeCompare(right.name ?? "", "es-CL");
      }
      if (customerSort === "documents_desc") {
        return Number(right.documents ?? 0) - Number(left.documents ?? 0);
      }
      return Number(right.net_sales ?? 0) - Number(left.net_sales ?? 0);
    });
  }, [customerQuery, customerSort, report?.top_customers]);
  const filteredSuppliers = useMemo(() => {
    const query = normalizeCustomerSearch(supplierQuery);
    return (report?.top_suppliers ?? [])
      .map((item) => {
        const selectedYear = supplierYear === "all" ? null : item.years?.[supplierYear];
        return {
          ...item,
          displayed_purchases: selectedYear
            ? Number(selectedYear.net_purchases ?? 0)
            : Number(item.net_purchases ?? 0),
          displayed_documents: selectedYear
            ? Number(selectedYear.documents ?? 0)
            : Number(item.documents ?? 0),
        };
      })
      .filter((item) => {
        if (item.displayed_documents <= 0 && item.displayed_purchases === 0) return false;
        if (!query) return true;
        return (
          normalizeCustomerSearch(item.name).includes(query) ||
          normalizeCustomerSearch(item.tax_id).includes(query)
        );
      })
      .sort((left, right) => right.displayed_purchases - left.displayed_purchases);
  }, [report?.top_suppliers, supplierQuery, supplierYear]);
  const filteredCollectionCustomers = useMemo(() => {
    const query = normalizeCustomerSearch(collectionQuery);
    const rows = (report?.collections?.customers ?? []).filter((item) => {
      if (!query) return true;
      return (
        normalizeCustomerSearch(item.name).includes(query) ||
        normalizeCustomerSearch(item.tax_id).includes(query)
      );
    });

    return [...rows].sort((left, right) => {
      if (collectionSort === "overdue_desc") {
        return Number(right.overdue ?? 0) - Number(left.overdue ?? 0);
      }
      if (collectionSort === "days_desc") {
        return Number(right.max_days_overdue ?? 0) - Number(left.max_days_overdue ?? 0);
      }
      if (collectionSort === "name_asc") {
        return (left.name ?? "").localeCompare(right.name ?? "", "es-CL");
      }
      return Number(right.amount ?? 0) - Number(left.amount ?? 0);
    });
  }, [collectionQuery, collectionSort, report?.collections?.customers]);

  if (!report) {
    return (
      <section className="data-card agent-dashboard-summary">
        <span className="eyebrow">FINANZAS TRAZABLES</span>
        <h2>{latest?.status === "pending" || latest?.status === "in_progress" ? "Análisis en proceso" : "Sin informe financiero"}</h2>
        <p>{latest?.result?.summary ?? "Solicita el análisis desde el Centro de agentes. Facto debe completar primero su sincronización de documentos."}</p>
      </section>
    );
  }

  const months = report.sales_by_month ?? [];
  const selected = selectedMonth === "all" ? null : months.find((item) => item.month === selectedMonth) ?? null;
  const purchaseMonths = report.purchases_by_month ?? [];
  const selectedPurchases = selectedMonth === "all"
    ? null
    : purchaseMonths.find((item) => item.month === selectedMonth) ?? null;
  const netSales = selected?.net_sales ?? report.net_sales;
  const netPurchases = selectedPurchases?.net_purchases ?? Number(report.net_purchases ?? 0);
  const tax = selected?.tax ?? report.tax;
  const grossSales = selected?.gross_sales ?? report.gross_sales;
  const documents = selected?.documents ?? report.document_count;
  const averageTicket = documents ? netSales / documents : 0;
  const maximumMonth = Math.max(...months.map((item) => Number(item.net_sales ?? 0)), 1);
  const comparison = report.year_comparison;
  const comparisonMonths = comparison?.months ?? [];
  const comparisonMaximum = Math.max(
    ...comparisonMonths.flatMap((item) => [
      Number(item.current_net_sales ?? 0),
      Number(item.previous_net_sales ?? 0),
      Number(item.current_net_purchases ?? 0),
      Number(item.previous_net_purchases ?? 0),
    ]),
    1,
  );
  const comparisonCutoffMonth = comparison
    ? Number(comparison.cutoff_date.slice(5, 7))
    : 12;
  const growthPercent = comparison?.growth_percent;
  const purchaseGrowthPercent = comparison?.purchase_growth_percent;
  const growthClass = Number(growthPercent ?? 0) > 0
    ? "positive"
    : Number(growthPercent ?? 0) < 0
      ? "negative"
      : "neutral";
  const purchaseGrowthClass = Number(purchaseGrowthPercent ?? 0) > 0
    ? "positive"
    : Number(purchaseGrowthPercent ?? 0) < 0
      ? "negative"
      : "neutral";
  const customerMaximum = Math.max(...filteredCustomers.map((item) => Number(item.net_sales ?? 0)), 1);
  const supplierMaximum = Math.max(
    ...filteredSuppliers.map((item) => item.displayed_purchases),
    1,
  );
  const supplierTotal = filteredSuppliers.reduce(
    (total, item) => total + item.displayed_purchases,
    0,
  );
  const productMaximum = Math.max(...(report.top_products ?? []).map((item) => Number(item.net_sales_observed ?? 0)), 1);
  const collections = report.collections;
  const reviewedCollectionDocuments = Number(
    collections?.reviewed_documents ?? collections?.documents ?? 0,
  );
  const reviewedCollectionAmount = Number(
    collections?.reviewed_amount ?? collections?.observed_amount ?? 0,
  );
  const cashCollectionDocuments = Number(collections?.cash_documents ?? 0);
  const unclassifiedCollectionDocuments = Number(collections?.unclassified_documents ?? 0);
  const showCollectionClassification =
    !collections?.payments_available &&
    Number(collections?.observed_amount ?? 0) <= 0 &&
    reviewedCollectionDocuments > 0;
  const collectionChartSlices = showCollectionClassification
    ? [
        {
          label: `Declaradas a crédito · ${collections?.credit_documents ?? 0} doc.`,
          value: Number(collections?.credit_amount ?? 0),
          color: "#27ad83",
        },
        {
          label: `Declaradas al contado · ${cashCollectionDocuments} doc.`,
          value: Number(collections?.cash_amount ?? 0),
          color: "#e3a12a",
        },
        {
          label: `Sin clasificación · ${unclassifiedCollectionDocuments} doc.`,
          value: Number(collections?.unclassified_amount ?? 0),
          color: "#8fa5aa",
        },
      ].filter((item) => item.value > 0)
    : (collections?.aging ?? []).map((item, index) => ({
        label: `${item.bucket} · ${item.documents} doc.`,
        value: Number(item.amount ?? 0),
        color: ["#27ad83", "#e3a12a", "#e17e31", "#d4563d", "#9f3547", "#8fa5aa"][index % 6],
      }));
  const collectionMaximum = Math.max(
    ...filteredCollectionCustomers.map((item) => Number(item.amount ?? 0)),
    1,
  );
  const cashFlow = report.documentary_cash_flow;

  return (
    <>
      {latest?.status === "pending" || latest?.status === "in_progress" ? (
        <div className="notice-banner info">El informe financiero se está actualizando con la evidencia más reciente.</div>
      ) : null}

      <section className="finance-toolbar data-card">
        <div>
          <span className="eyebrow">PERÍODO OBSERVADO EN FACTO</span>
          <strong>{report.period_start ?? "Sin fecha"} al {report.period_end ?? "Sin fecha"}</strong>
        </div>
        <label>
          Ver período
          <select value={selectedMonth} onChange={(event) => setSelectedMonth(event.target.value)}>
            <option value="all">Todo el período</option>
            {[...months].reverse().map((item) => <option key={item.month} value={item.month}>{monthLabel(item.month)}</option>)}
          </select>
        </label>
      </section>

      <section className="agent-dashboard-kpis finance-kpis">
        <article><CircleDollarSign size={22} /><span>Ventas netas sin IVA</span><strong>{formatCurrency.format(netSales)}</strong><small>Ingreso comercial antes de IVA</small></article>
        <article className={!report.purchases_available ? "risk" : ""}>
          <PackageCheck size={22} /><span>Compras netas</span>
          <strong>{report.purchases_available ? formatCurrency.format(netPurchases) : "Pendiente"}</strong>
          <small>{report.purchases_available ? `${selectedPurchases?.documents ?? report.purchase_document_count ?? 0} documentos recibidos` : "Facto aún no entrega compras"}</small>
        </article>
        <article><Database size={22} /><span>IVA de documentos</span><strong>{formatCurrency.format(tax)}</strong><small>No se considera ingreso</small></article>
        <article><BarChart3 size={22} /><span>Documentos emitidos</span><strong>{formatNumber.format(documents)}</strong><small>Facturas, exentas y boletas válidas</small></article>
        <article><TrendingUp size={22} /><span>Ticket neto promedio</span><strong>{formatCurrency.format(averageTicket)}</strong><small>Venta neta ÷ documentos</small></article>
        <article><CircleDollarSign size={22} /><span>Venta total con IVA</span><strong>{formatCurrency.format(grossSales)}</strong><small>Total documentado a clientes</small></article>
        <article className={!report.reference_margin_available ? "risk" : ""}>
          <TrendingUp size={22} /><span>Margen bruto referencial</span>
          <strong>{report.reference_margin_available ? formatCurrency.format(report.reference_gross_margin) : "Pendiente"}</strong>
          <small>Costo actual relacionado; no reemplaza contabilidad</small>
        </article>
      </section>

      <section className="finance-main-grid">
        <article className="data-card finance-monthly-card">
          {comparison ? (
            <>
              <div className="section-title">
                <div>
                  <h2>Crecimiento {comparison.current_year} vs {comparison.previous_year}</h2>
                  <p>
                    Ventas netas sin IVA comparadas hasta el mismo día:
                    {" "}{financialDateLabel(comparison.cutoff_date)}.
                  </p>
                </div>
              </div>
              <div className="finance-growth-kpis">
                <article>
                  <span>Acumulado {comparison.current_year}</span>
                  <strong>{formatCurrency.format(comparison.current_ytd_net_sales)}</strong>
                  <small>{comparison.current_ytd_documents} documentos</small>
                </article>
                <article>
                  <span>Mismo período {comparison.previous_year}</span>
                  <strong>{formatCurrency.format(comparison.previous_ytd_net_sales)}</strong>
                  <small>{comparison.previous_ytd_documents} documentos</small>
                </article>
                <article className={growthClass}>
                  <span>Variación interanual</span>
                  <strong>
                    {growthPercent == null
                      ? "Sin base"
                      : `${growthPercent >= 0 ? "+" : ""}${formatNumber.format(growthPercent)}%`}
                  </strong>
                  <small>{formatCurrency.format(comparison.growth_amount)}</small>
                </article>
                <article>
                  <span>Total completo {comparison.previous_year}</span>
                  <strong>{formatCurrency.format(comparison.previous_full_year_net_sales)}</strong>
                  <small>Ventas · referencia de 12 meses</small>
                </article>
                <article>
                  <span>Compras {comparison.current_year}</span>
                  <strong>{formatCurrency.format(Number(comparison.current_ytd_net_purchases ?? 0))}</strong>
                  <small>{comparison.current_ytd_purchase_documents ?? 0} documentos recibidos</small>
                </article>
                <article>
                  <span>Compras mismo período {comparison.previous_year}</span>
                  <strong>{formatCurrency.format(Number(comparison.previous_ytd_net_purchases ?? 0))}</strong>
                  <small>{comparison.previous_ytd_purchase_documents ?? 0} documentos recibidos</small>
                </article>
                <article className={purchaseGrowthClass}>
                  <span>Variación de compras</span>
                  <strong>
                    {purchaseGrowthPercent == null
                      ? "Sin base"
                      : `${purchaseGrowthPercent >= 0 ? "+" : ""}${formatNumber.format(purchaseGrowthPercent)}%`}
                  </strong>
                  <small>{formatCurrency.format(Number(comparison.purchase_growth_amount ?? 0))}</small>
                </article>
                <article>
                  <span>Compras completas {comparison.previous_year}</span>
                  <strong>{formatCurrency.format(Number(comparison.previous_full_year_net_purchases ?? 0))}</strong>
                  <small>Referencia de 12 meses</small>
                </article>
              </div>
              <div className="finance-year-legend" aria-label="Leyenda del gráfico">
                <span><i className="previous" />Ventas {comparison.previous_year}</span>
                <span><i className="previous-purchase" />Compras {comparison.previous_year}</span>
                <span><i className="current" />Ventas {comparison.current_year}</span>
                <span><i className="current-purchase" />Compras {comparison.current_year}</span>
              </div>
              <div className="finance-year-bars">
                {comparisonMonths.map((item) => {
                  const futureCurrentMonth = item.month > comparisonCutoffMonth;
                  const previousHeight = (item.previous_net_sales / comparisonMaximum) * 100;
                  const currentHeight = (item.current_net_sales / comparisonMaximum) * 100;
                  const previousNetPurchases = Number(item.previous_net_purchases ?? 0);
                  const currentNetPurchases = Number(item.current_net_purchases ?? 0);
                  const previousPurchaseHeight = (previousNetPurchases / comparisonMaximum) * 100;
                  const currentPurchaseHeight = (currentNetPurchases / comparisonMaximum) * 100;
                  return (
                    <article key={item.month}>
                      <div className="finance-year-pair">
                        <span
                          className="previous"
                          style={{ height: `${item.previous_net_sales ? Math.max(3, previousHeight) : 0}%` }}
                          title={`${item.label} ${comparison.previous_year}: ${formatCurrency.format(item.previous_net_sales)}`}
                        />
                        <span
                          className="previous-purchase"
                          style={{ height: `${previousNetPurchases ? Math.max(3, previousPurchaseHeight) : 0}%` }}
                          title={`${item.label} compras ${comparison.previous_year}: ${formatCurrency.format(previousNetPurchases)}`}
                        />
                        <span
                          className={`current${futureCurrentMonth ? " future" : ""}`}
                          style={{ height: `${item.current_net_sales ? Math.max(3, currentHeight) : 0}%` }}
                          title={futureCurrentMonth
                            ? `${item.label} ${comparison.current_year}: período aún no transcurrido`
                            : `${item.label} ${comparison.current_year}: ${formatCurrency.format(item.current_net_sales)}`}
                        />
                        <span
                          className={`current-purchase${futureCurrentMonth ? " future" : ""}`}
                          style={{ height: `${currentNetPurchases ? Math.max(3, currentPurchaseHeight) : 0}%` }}
                          title={futureCurrentMonth
                            ? `${item.label} compras ${comparison.current_year}: período aún no transcurrido`
                            : `${item.label} compras ${comparison.current_year}: ${formatCurrency.format(currentNetPurchases)}`}
                        />
                      </div>
                      <strong>{item.label}</strong>
                    </article>
                  );
                })}
              </div>
              <p className="finance-year-note">
                Las barras posteriores a {financialDateLabel(comparison.cutoff_date)} no se consideran
                como ventas o compras cero; corresponden a meses aún no transcurridos.
              </p>
              <p className="finance-import-context">
                <strong>Lectura operativa:</strong> Clima Activa observa que los meses de mayor venta
                suelen seguir a llegadas de mercadería desde China. Aquí se comparan compras contables
                y ventas; el cruce con la fecha real de arribo se incorporará desde Comercio Exterior
                considerando el ciclo objetivo de 95 días.
              </p>
            </>
          ) : (
            <>
              <div className="section-title"><div><h2>Ventas netas por mes</h2><p>Evolución real de documentos emitidos, siempre sin IVA.</p></div></div>
              <div className="finance-month-bars">
                {months.map((item) => (
                  <article key={item.month}>
                    <div className="finance-month-value">{formatCurrency.format(item.net_sales)}</div>
                    <div className="finance-column-track"><span style={{ height: `${Math.max(4, (item.net_sales / maximumMonth) * 100)}%` }} /></div>
                    <strong>{monthLabel(item.month)}</strong><small>{item.documents} doc.</small>
                  </article>
                ))}
              </div>
            </>
          )}
        </article>
        <DonutChart
          centerLabel="total con IVA"
          centerValue={formatCurrency.format(report.gross_sales)}
          formatter={(value) => formatCurrency.format(value)}
          slices={[{ label: "Venta neta", value: report.net_sales, color: "#07869a" }, { label: "IVA", value: report.tax, color: "#e39a27" }]}
          subtitle="Separa el ingreso neto del impuesto incluido en los documentos."
          title="Composición de la venta"
        />
      </section>

      <section className="data-card finance-supplier-card">
        <div className="section-title">
          <div>
            <h2>Proveedores con mayores compras</h2>
            <p>Compras netas recibidas en Facto, descontando notas de crédito.</p>
          </div>
          <strong className="finance-customer-count">
            {filteredSuppliers.length} de {report.supplier_count ?? report.top_suppliers?.length ?? 0}
          </strong>
        </div>
        <div className="finance-customer-tools">
          <label className="finance-customer-search">
            <Search aria-hidden="true" size={18} />
            <span className="sr-only">Buscar proveedor</span>
            <input
              onChange={(event) => setSupplierQuery(event.target.value)}
              placeholder="Buscar por RUT o razón social"
              type="search"
              value={supplierQuery}
            />
          </label>
          <label>
            <span className="sr-only">Filtrar año de compras</span>
            <select onChange={(event) => setSupplierYear(event.target.value)} value={supplierYear}>
              <option value="all">Todo 2025–2026</option>
              {comparison ? (
                <>
                  <option value={String(comparison.current_year)}>{comparison.current_year}</option>
                  <option value={String(comparison.previous_year)}>{comparison.previous_year}</option>
                </>
              ) : null}
            </select>
          </label>
        </div>
        <div className="stock-bars product-ranking-list finance-ranking-scroll finance-supplier-ranking">
          {filteredSuppliers.map((item, index) => {
            const share = supplierTotal > 0 ? (item.displayed_purchases / supplierTotal) * 100 : 0;
            return (
              <article key={`${item.tax_id || item.name}-${index}`}>
                <div>
                  <strong title={item.name}>{item.name || "Proveedor no identificado"}</strong>
                  <span>{formatCurrency.format(item.displayed_purchases)}</span>
                </div>
                <small>
                  {item.displayed_documents} documentos
                  {item.tax_id ? ` · ${item.tax_id}` : ""}
                  {supplierTotal > 0 ? ` · ${formatNumber.format(share)}% del total filtrado` : ""}
                </small>
                <div className="stock-bar-track">
                  <span style={{ width: `${Math.max(3, (item.displayed_purchases / supplierMaximum) * 100)}%` }} />
                </div>
              </article>
            );
          })}
          {!filteredSuppliers.length ? (
            <div className="finance-customer-empty">
              <Search size={22} />
              <strong>Sin compras para este filtro</strong>
              <span>Prueba con otro año, RUT o razón social.</span>
            </div>
          ) : null}
        </div>
      </section>

      <section className="finance-rankings">
        <article className="data-card">
          <div className="section-title">
            <div>
              <h2>Ranking de clientes</h2>
              <p>Busca por RUT o razón social y ordena los montos netos documentados.</p>
            </div>
            <strong className="finance-customer-count">{filteredCustomers.length} de {report.customer_count ?? report.top_customers?.length ?? 0}</strong>
          </div>
          <div className="finance-customer-tools">
            <label className="finance-customer-search">
              <Search aria-hidden="true" size={18} />
              <span className="sr-only">Buscar cliente</span>
              <input
                onChange={(event) => setCustomerQuery(event.target.value)}
                placeholder="Buscar por RUT o razón social"
                type="search"
                value={customerQuery}
              />
            </label>
            <label>
              <span className="sr-only">Ordenar clientes</span>
              <select onChange={(event) => setCustomerSort(event.target.value)} value={customerSort}>
                <option value="amount_desc">Mayor monto</option>
                <option value="amount_asc">Menor monto</option>
                <option value="documents_desc">Más documentos</option>
                <option value="name_asc">Razón social A–Z</option>
              </select>
            </label>
          </div>
          <div className="stock-bars product-ranking-list finance-ranking-scroll">
            {filteredCustomers.map((item, index) => (
              <article key={`${item.tax_id || item.name}-${index}`}>
                <div><strong title={item.name}>{item.name || "Cliente no identificado"}</strong><span>{formatCurrency.format(Number(item.net_sales ?? 0))}</span></div>
                <small>{item.documents ?? 0} documentos{item.tax_id ? ` · ${item.tax_id}` : ""}</small>
                <div className="stock-bar-track"><span style={{ width: `${Math.max(3, (Number(item.net_sales ?? 0) / customerMaximum) * 100)}%` }} /></div>
              </article>
            ))}
            {!filteredCustomers.length ? (
              <div className="finance-customer-empty">
                <Search size={22} />
                <strong>Sin coincidencias</strong>
                <span>Prueba con otro RUT o razón social.</span>
              </div>
            ) : null}
          </div>
        </article>
        <article className="data-card">
          <div className="section-title"><div><h2>Productos que generan ventas</h2><p>Relación por SKU observada en Facto.</p></div></div>
          <div className="stock-bars product-ranking-list finance-ranking-scroll">
            {(report.top_products ?? []).map((item, index) => (
              <article key={`${item.sku || item.name}-${index}`}>
                <div><strong title={item.name}>{item.name || item.sku || "Producto sin nombre"}</strong><span>{formatCurrency.format(Number(item.net_sales_observed ?? 0))}</span></div>
                <small>{formatNumber.format(Number(item.units ?? 0))} unidades · SKU {item.sku || "sin dato"}</small>
                <div className="stock-bar-track"><span style={{ width: `${Math.max(3, (Number(item.net_sales_observed ?? 0) / productMaximum) * 100)}%` }} /></div>
              </article>
            ))}
          </div>
        </article>
      </section>

      <section className="data-card finance-collections-header">
        <div>
          <span className="eyebrow">COBRANZA TRAZABLE</span>
          <h2>Caja y cuentas por cobrar</h2>
          <p>
            {collections?.mode === "registered_payments"
              ? "Facturas menos pagos registrados en Facto. Los montos representan saldo observado por cobrar."
              : reviewedCollectionDocuments > 0
                ? `Facto entregó ${reviewedCollectionDocuments} facturas. El CRM separa las declaradas a crédito, al contado y sin condición de pago; no convierte ventas al contado en deuda.`
                : "Aún no hay facturas con una condición de pago utilizable en la última sincronización de Facto."}
          </p>
        </div>
        <span className={collections?.payments_available ? "ready" : "pending"}>
          {collections?.payments_available
            ? "Saldo respaldado por pagos"
            : reviewedCollectionDocuments > 0
              ? `${reviewedCollectionDocuments} facturas revisadas`
              : "Esperando clasificación"}
        </span>
      </section>

      <section className="agent-dashboard-kpis finance-collection-kpis">
        <article>
          <CircleDollarSign size={22} />
          <span>{collections?.payments_available ? "Cuentas por cobrar" : "Exposición facturada a crédito"}</span>
          <strong>{formatCurrency.format(Number(collections?.observed_amount ?? 0))}</strong>
          <small>
            {collections?.documents ?? 0} documentos de crédito
            {reviewedCollectionDocuments ? ` de ${reviewedCollectionDocuments} revisados` : ""}
          </small>
        </article>
        <article className={Number(collections?.overdue_amount ?? 0) > 0 ? "risk" : ""}>
          <AlertTriangle size={22} />
          <span>{collections?.payments_available ? "Cartera vencida" : "Exposición vencida"}</span>
          <strong>{formatCurrency.format(Number(collections?.overdue_amount ?? 0))}</strong>
          <small>{collections?.overdue_documents ?? 0} documentos fuera de plazo</small>
        </article>
        <article>
          <TrendingUp size={22} />
          <span>Vence en próximos 30 días</span>
          <strong>{formatCurrency.format(Number(collections?.due_next_30 ?? 0))}</strong>
          <small>Compromisos documentales próximos</small>
        </article>
        <article className={unclassifiedCollectionDocuments > 0 ? "risk" : ""}>
          <Database size={22} />
          <span>
            {collections?.payments_available
              ? "Cobros registrados por API"
              : "Facturación declarada al contado"}
          </span>
          <strong>
            {collections?.payments_available
              ? formatCurrency.format(Number(collections.payments_registered ?? 0))
              : formatCurrency.format(Number(collections?.cash_amount ?? 0))}
          </strong>
          <small>
            {collections?.payments_available
              ? `${collections.payment_count} pagos relacionados`
              : `${cashCollectionDocuments} documentos; no se consideran cuentas por cobrar`}
          </small>
        </article>
      </section>

      {unclassifiedCollectionDocuments > 0 ? (
        <div className="notice-banner warning finance-collection-warning">
          <strong>{unclassifiedCollectionDocuments} facturas no tienen una condición de pago reconocible.</strong>
          <span>
            Representan {formatCurrency.format(Number(collections?.unclassified_amount ?? 0))} y se
            mantienen fuera de la deuda hasta clasificarlas en Facto.
          </span>
        </div>
      ) : null}

      <section className="finance-collections-grid">
        <DonutChart
          centerLabel={
            showCollectionClassification
              ? "facturación revisada"
              : collections?.payments_available
                ? "saldo observado"
                : "exposición"
          }
          centerValue={formatCurrency.format(
            showCollectionClassification
              ? reviewedCollectionAmount
              : Number(collections?.observed_amount ?? 0),
          )}
          formatter={(value) => formatCurrency.format(value)}
          slices={collectionChartSlices}
          subtitle={
            showCollectionClassification
              ? "Distribución real según la condición de pago declarada en las facturas de Facto."
              : collections?.payments_available
              ? "Distribución del saldo por cobrar según su vencimiento."
              : "Distribución estimada de facturas a crédito; no confirma que sigan impagas."
          }
          title={
            showCollectionClassification
              ? "Condiciones de pago en Facto"
              : collections?.payments_available
                ? "Antigüedad de deuda"
                : "Vencimiento documental estimado"
          }
        />

        <article className="data-card finance-collection-card">
          <div className="section-title">
            <div>
              <h2>Clientes por cobrar</h2>
              <p>Busca por RUT o razón social y prioriza monto, atraso o antigüedad.</p>
            </div>
            <strong className="finance-customer-count">{filteredCollectionCustomers.length} clientes</strong>
          </div>
          <div className="finance-customer-tools">
            <label className="finance-customer-search">
              <Search aria-hidden="true" size={18} />
              <span className="sr-only">Buscar cliente por cobrar</span>
              <input
                onChange={(event) => setCollectionQuery(event.target.value)}
                placeholder="Buscar por RUT o razón social"
                type="search"
                value={collectionQuery}
              />
            </label>
            <label>
              <span className="sr-only">Ordenar cuentas por cobrar</span>
              <select onChange={(event) => setCollectionSort(event.target.value)} value={collectionSort}>
                <option value="amount_desc">Mayor saldo</option>
                <option value="overdue_desc">Mayor vencido</option>
                <option value="days_desc">Más días vencido</option>
                <option value="name_asc">Razón social A–Z</option>
              </select>
            </label>
          </div>
          <div className="stock-bars product-ranking-list finance-ranking-scroll finance-collection-ranking">
            {filteredCollectionCustomers.map((item, index) => (
              <article key={`${item.tax_id || item.name}-${index}`}>
                <div>
                  <strong title={item.name}>{item.name || "Cliente no identificado"}</strong>
                  <span>{formatCurrency.format(Number(item.amount ?? 0))}</span>
                </div>
                <small>
                  {item.documents} documentos
                  {item.tax_id ? ` · ${item.tax_id}` : ""}
                  {item.overdue > 0 ? ` · Vencido ${formatCurrency.format(item.overdue)}` : ""}
                  {item.max_days_overdue > 0 ? ` · ${item.max_days_overdue} días` : ""}
                </small>
                <div className="stock-bar-track">
                  <span style={{ width: `${Math.max(3, (Number(item.amount ?? 0) / collectionMaximum) * 100)}%` }} />
                </div>
              </article>
            ))}
            {!filteredCollectionCustomers.length ? (
              <div className="finance-customer-empty">
                <Search size={22} />
                <strong>
                  {reviewedCollectionDocuments > 0
                    ? "No hay facturas declaradas a crédito para este filtro"
                    : "Sin documentos de crédito para este filtro"}
                </strong>
                <span>
                  {cashCollectionDocuments > 0
                    ? `${cashCollectionDocuments} facturas están declaradas al contado en Facto y no se muestran como deuda.`
                    : "La sección se completará cuando Facto entregue facturas a crédito o pagos relacionados."}
                </span>
              </div>
            ) : null}
          </div>
        </article>
      </section>

      <section className="data-card finance-cash-section">
        <div className="section-title">
          <div>
            <span className="eyebrow">LIQUIDEZ SIN ESTIMACIONES INVENTADAS</span>
            <h2>Caja y flujo documental</h2>
            <p>Ventas menos compras ayuda a leer el movimiento comercial, pero no reemplaza el saldo real de caja ni bancos.</p>
          </div>
        </div>
        <div className="finance-cash-grid">
          <article>
            <span>Ventas netas documentadas</span>
            <strong>{formatCurrency.format(Number(cashFlow?.net_sales ?? report.net_sales))}</strong>
            <small>Antes de IVA</small>
          </article>
          <article>
            <span>Compras netas documentadas</span>
            <strong>{formatCurrency.format(Number(cashFlow?.net_purchases ?? report.net_purchases ?? 0))}</strong>
            <small>Documentos recibidos</small>
          </article>
          <article>
            <span>Diferencia documental</span>
            <strong>{formatCurrency.format(Number(cashFlow?.documentary_difference ?? 0))}</strong>
            <small>No equivale a efectivo disponible</small>
          </article>
          <article className="pending">
            <span>Saldo caja física</span>
            <strong>Pendiente</strong>
            <small>Requiere el módulo Caja o conciliación</small>
          </article>
          <article className="pending">
            <span>Saldo en bancos</span>
            <strong>Pendiente</strong>
            <small>Requiere integración bancaria o conciliación</small>
          </article>
        </div>
        <p className="finance-cash-note">{cashFlow?.disclaimer ?? collections?.disclaimer}</p>
      </section>

      <section className="data-card finance-next-data finance-next-data-hidden">
        <div><span className="eyebrow">SIGUIENTE AMPLIACIÓN</span><h2>Caja y cuentas por cobrar</h2><p>Compras y proveedores ya están integrados desde Facto. Los saldos de caja y cobranza aparecerán cuando se incorporen pagos, vencimientos y bancos, sin inventar valores.</p></div>
        <div>
          <span className={report.receivables_available ? "ready" : "pending"}>Cobranza {report.receivables_available ? "disponible" : "pendiente"}</span>
          <span className={report.purchases_available ? "ready" : "pending"}>Compras {report.purchases_available ? "disponibles" : "pendientes"}</span>
          <span className={report.cash_balance_available ? "ready" : "pending"}>Caja {report.cash_balance_available ? "disponible" : "pendiente"}</span>
        </div>
      </section>
    </>
  );
}

function LogisticsDashboard({ tasks, snapshots }: { tasks: AgentTask[]; snapshots: Snapshot[] }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [sort, setSort] = useState("stock");
  const [rankingMode, setRankingMode] = useState<"stock" | "cost_value" | "sale_value">("stock");
  const [salesRankingMode, setSalesRankingMode] = useState<"units" | "sale_value">("units");
  const [idleRankingMode, setIdleRankingMode] = useState<"stock" | "cost_value" | "sale_value">("cost_value");
  const [showInventory, setShowInventory] = useState(false);
  const [inventoryPage, setInventoryPage] = useState(1);
  const pageSize = 25;

  const metrics = useMemo(() => {
    const withStock = snapshots.filter((item) => item.stock_known);
    const inStock = withStock.filter((item) => Number(item.available_units ?? 0) > 0);
    const outOfStock = withStock.filter((item) => Number(item.available_units ?? 0) <= 0);
    const withoutStockEvidence = snapshots.filter((item) => !item.stock_known);
    const withCost = snapshots.filter((item) => item.cost_available_in_source);
    const withPrice = snapshots.filter((item) => item.price_known);
    const withSalesHistory = snapshots.filter((item) => item.sales_history_available);
    const withSales = snapshots.filter((item) => Number(item.units_sold_observed ?? 0) > 0);
    const withoutMovement = snapshots.filter(
      (item) =>
        item.sales_history_available &&
        item.stock_known &&
        Number(item.available_units ?? 0) > 0 &&
        Number(item.units_sold_observed ?? 0) === 0,
    );
    const valuedAtCost = withCost.filter((item) => item.stock_known);
    const valuedAtSalePrice = withPrice.filter((item) => item.stock_known);
    const valuedAtBoth = snapshots.filter(
      (item) => item.stock_known && item.cost_available_in_source && item.price_known,
    );
    return {
      withStock,
      inStock,
      outOfStock,
      withoutStockEvidence,
      withCost,
      withPrice,
      withSales,
      withSalesHistory,
      withoutMovement,
      totalUnits: withStock.reduce((sum, item) => sum + Number(item.available_units ?? 0), 0),
      costValue: valuedAtCost.reduce(
        (sum, item) => sum + Number(item.available_units ?? 0) * Number(item.unit_cost_source ?? 0),
        0,
      ),
      saleValue: valuedAtSalePrice.reduce(
        (sum, item) => sum + Number(item.available_units ?? 0) * netUnitPrice(item),
        0,
      ),
      potentialGrossMargin: valuedAtBoth.reduce(
        (sum, item) =>
          sum +
          Number(item.available_units ?? 0) *
            (netUnitPrice(item) - Number(item.unit_cost_source ?? 0)),
        0,
      ),
    };
  }, [snapshots]);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("es-CL");
    const rows = snapshots.filter((item) => {
      if (normalized && !`${item.sku ?? ""} ${item.name ?? ""}`.toLocaleLowerCase("es-CL").includes(normalized)) return false;
      if (filter === "in_stock") return Number(item.available_units ?? 0) > 0;
      if (filter === "out_of_stock") return item.stock_known && Number(item.available_units ?? 0) <= 0;
      if (filter === "with_sales") return Number(item.units_sold_observed ?? 0) > 0;
      if (filter === "without_movement") {
        return Boolean(item.sales_history_available) && Number(item.units_sold_observed ?? 0) === 0;
      }
      if (filter === "without_history") return !item.sales_history_available;
      return true;
    });
    return rows.sort((left, right) => {
      if (sort === "name") return String(left.name).localeCompare(String(right.name), "es");
      if (sort === "value") {
        return (
          Number(right.available_units ?? 0) * Number(right.unit_cost_source ?? 0) -
          Number(left.available_units ?? 0) * Number(left.unit_cost_source ?? 0)
        );
      }
      if (sort === "sale_value") {
        return (
          Number(right.available_units ?? 0) * netUnitPrice(right) -
          Number(left.available_units ?? 0) * netUnitPrice(left)
        );
      }
      return Number(right.available_units ?? 0) - Number(left.available_units ?? 0);
    });
  }, [filter, query, snapshots, sort]);

  useEffect(() => {
    setInventoryPage(1);
  }, [filter, query, sort]);

  const rankingValue = useCallback(
    (item: Snapshot) => {
      const stock = Number(item.available_units ?? 0);
      if (rankingMode === "cost_value") return stock * Number(item.unit_cost_source ?? 0);
      if (rankingMode === "sale_value") return stock * netUnitPrice(item);
      return stock;
    },
    [rankingMode],
  );
  const topInventory = useMemo(
    () => [...metrics.inStock].sort((a, b) => rankingValue(b) - rankingValue(a)).slice(0, 30),
    [metrics.inStock, rankingValue],
  );
  const maxRankingValue = Math.max(...topInventory.map(rankingValue), 1);
  const salesRankingValue = useCallback(
    (item: Snapshot) => {
      const units = Number(item.units_sold_observed ?? 0);
      return salesRankingMode === "sale_value" ? units * netUnitPrice(item) : units;
    },
    [salesRankingMode],
  );
  const bestSellers = useMemo(
    () =>
      [...metrics.withSales]
        .sort((a, b) => salesRankingValue(b) - salesRankingValue(a))
        .slice(0, 30),
    [metrics.withSales, salesRankingValue],
  );
  const maxSold = Math.max(...bestSellers.map(salesRankingValue), 1);
  const idleRankingValue = useCallback(
    (item: Snapshot) => {
      const stock = Number(item.available_units ?? 0);
      if (idleRankingMode === "cost_value") return stock * Number(item.unit_cost_source ?? 0);
      if (idleRankingMode === "sale_value") return stock * netUnitPrice(item);
      return stock;
    },
    [idleRankingMode],
  );
  const trappedStock = useMemo(
    () =>
      [...metrics.withoutMovement]
        .sort((a, b) => idleRankingValue(b) - idleRankingValue(a))
        .slice(0, 30),
    [idleRankingValue, metrics.withoutMovement],
  );
  const maxTrappedValue = Math.max(...trappedStock.map(idleRankingValue), 1);
  const salesHistoryWithoutSales = Math.max(
    0,
    metrics.withSalesHistory.length - metrics.withSales.length,
  );
  const grossMarginValue = Math.max(0, metrics.potentialGrossMargin);
  const filteredUnits = filtered.reduce(
    (sum, item) => sum + Number(item.available_units ?? 0),
    0,
  );
  const filteredCostValue = filtered.reduce(
    (sum, item) =>
      sum + Number(item.available_units ?? 0) * Number(item.unit_cost_source ?? 0),
    0,
  );
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const visibleInventory = filtered.slice(
    (inventoryPage - 1) * pageSize,
    inventoryPage * pageSize,
  );
  const latest = tasks[0];

  return (
    <>
      {latest?.status === "pending" || latest?.status === "in_progress" ? (
        <div className="notice-banner info">
          El análisis está {latest.status === "pending" ? "en cola" : "procesándose"}. Este panel se actualiza automáticamente.
        </div>
      ) : null}
      <section className="agent-dashboard-kpis">
        <article>
          <Boxes size={22} />
          <span>Catálogo Facto sincronizado</span>
          <strong>{formatNumber.format(snapshots.length)}</strong>
          <small>No está limitado a 25</small>
        </article>
        <article>
          <PackageCheck size={22} />
          <span>Productos con existencia</span>
          <strong>{formatNumber.format(metrics.inStock.length)}</strong>
          <small>{formatNumber.format(metrics.totalUnits)} unidades disponibles</small>
        </article>
        <article className={metrics.outOfStock.length ? "risk" : ""}>
          <AlertTriangle size={22} />
          <span>Sin stock confirmado</span>
          <strong>{formatNumber.format(metrics.outOfStock.length)}</strong>
          <small>Existencia comprobada en cero</small>
        </article>
        <article className={metrics.withoutStockEvidence.length ? "risk" : ""}>
          <Database size={22} />
          <span>Sin dato de bodega</span>
          <strong>{formatNumber.format(metrics.withoutStockEvidence.length)}</strong>
          <small>No se clasifica como stock cero</small>
        </article>
        <article>
          <CircleDollarSign size={22} />
          <span>Valor del inventario a costo</span>
          <strong>{formatCurrency.format(metrics.costValue)}</strong>
          <small>Stock × costo informado por Facto</small>
        </article>
        <article>
          <CircleDollarSign size={22} />
          <span>Valor potencial de venta</span>
          <strong>{formatCurrency.format(metrics.saleValue)}</strong>
          <small>Stock × precio neto sin IVA</small>
        </article>
        <article>
          <TrendingUp size={22} />
          <span>Margen bruto potencial</span>
          <strong>{formatCurrency.format(metrics.potentialGrossMargin)}</strong>
          <small>Antes de impuestos y otros gastos</small>
        </article>
        <article>
          <TrendingUp size={22} />
          <span>Productos con ventas</span>
          <strong>{formatNumber.format(metrics.withSales.length)}</strong>
          <small>Ventas reales relacionadas con el catálogo</small>
        </article>
      </section>

      <section className="data-card logistics-chart logistics-primary-ranking">
        <div className="section-title logistics-chart-title">
          <div><h2>Mayor existencia y valorización</h2><p>Compara unidades, capital a costo o valor potencial de venta neto.</p></div>
          <select
            aria-label="Métrica del ranking de inventario"
            onChange={(event) => setRankingMode(event.target.value as "stock" | "cost_value" | "sale_value")}
            value={rankingMode}
          >
            <option value="stock">Por unidades</option>
            <option value="cost_value">Por dinero a costo</option>
            <option value="sale_value">Por valor neto de venta</option>
          </select>
        </div>
        <div className="stock-bars product-ranking-list product-ranking-scroll">
          {topInventory.map((item) => (
            <article key={item.sku}>
              <div>
                <strong title={item.name || item.sku}>{item.name || item.sku}</strong>
                <span>{rankingMode === "stock" ? `${formatNumber.format(rankingValue(item))} un.` : formatCurrency.format(rankingValue(item))}</span>
              </div>
              <div className="stock-bar-track"><span style={{ width: `${Math.max(3, (rankingValue(item) / maxRankingValue) * 100)}%` }} /></div>
            </article>
          ))}
          {!topInventory.length ? <p>No hay existencias positivas confirmadas en la última sincronización de Bodega Facto.</p> : null}
        </div>
      </section>

      <section className="logistics-donut-grid">
        <DonutChart
          centerLabel="productos"
          centerValue={formatNumber.format(snapshots.length)}
          slices={[
            { label: "Con existencia", value: metrics.inStock.length, color: "#07869a" },
            { label: "Sin stock", value: metrics.outOfStock.length, color: "#e07832" },
            { label: "Sin dato de bodega", value: metrics.withoutStockEvidence.length, color: "#b6c5c8" },
          ]}
          subtitle="Distribución real según la última sincronización de Facto."
          title="Estado del catálogo"
        />
        <DonutChart
          centerLabel="venta potencial"
          centerValue={formatCurrency.format(metrics.saleValue)}
          formatter={(value) => formatCurrency.format(value)}
          slices={[
            { label: "Costo del inventario", value: metrics.costValue, color: "#075968" },
            { label: "Margen bruto potencial", value: grossMarginValue, color: "#27af86" },
          ]}
          subtitle="Compara capital invertido y margen bruto usando precios netos sin IVA."
          title="Composición del valor"
        />
        <DonutChart
          centerLabel="SKU"
          centerValue={formatNumber.format(snapshots.length)}
          slices={[
            { label: "Con ventas observadas", value: metrics.withSales.length, color: "#2b78c5" },
            { label: "Con historial, sin ventas", value: salesHistoryWithoutSales, color: "#e39a27" },
            {
              label: "Sin historial disponible",
              value: Math.max(0, snapshots.length - metrics.withSalesHistory.length),
              color: "#c5ced1",
            },
          ]}
          subtitle="Cobertura disponible para rotación y decisiones de compra."
          title="Evidencia de ventas"
        />
      </section>

      <section className="logistics-insights-grid">
        <article className="data-card">
          <div className="section-title logistics-chart-title">
            <div><h2>Productos más vendidos</h2><p>Unidades observadas en documentos emitidos de Facto.</p></div>
            <select
              aria-label="Métrica de productos más vendidos"
              onChange={(event) => setSalesRankingMode(event.target.value as "units" | "sale_value")}
              value={salesRankingMode}
            >
              <option value="units">Por unidades vendidas</option>
              <option value="sale_value">Por venta neta sin IVA</option>
            </select>
          </div>
          <div className="stock-bars sales-bars product-ranking-list">
            {bestSellers.map((item) => (
              <article key={item.sku}>
                <div>
                  <strong title={item.name || item.sku}>{item.name || item.sku}</strong>
                  <span>
                    {salesRankingMode === "units"
                      ? `${formatNumber.format(salesRankingValue(item))} un.`
                      : formatCurrency.format(salesRankingValue(item))}
                  </span>
                </div>
                <div className="stock-bar-track"><span style={{ width: `${Math.max(3, (salesRankingValue(item) / maxSold) * 100)}%` }} /></div>
              </article>
            ))}
            {!bestSellers.length ? <p>Sin ventas relacionadas todavía. La sincronización anual puede tardar unos minutos.</p> : null}
          </div>
        </article>

        <article className="data-card">
          <div className="section-title logistics-chart-title">
            <div><h2>Stock sin movimiento</h2><p>Existencia con cero ventas en el período observado.</p></div>
            <select
              aria-label="Métrica de stock sin movimiento"
              onChange={(event) => setIdleRankingMode(event.target.value as "stock" | "cost_value" | "sale_value")}
              value={idleRankingMode}
            >
              <option value="stock">Por unidades</option>
              <option value="cost_value">Por dinero a costo</option>
              <option value="sale_value">Por valor neto sin IVA</option>
            </select>
          </div>
          <div className="stock-bars idle-bars product-ranking-list">
            {trappedStock.map((item) => {
              const value = idleRankingValue(item);
              return (
                <article key={item.sku}>
                  <div>
                    <strong title={item.name || item.sku}>{item.name || item.sku}</strong>
                    <span>
                      {idleRankingMode === "stock"
                        ? `${formatNumber.format(value)} un.`
                        : formatCurrency.format(value)}
                    </span>
                  </div>
                  <div className="stock-bar-track"><span style={{ width: `${Math.max(3, (value / maxTrappedValue) * 100)}%` }} /></div>
                </article>
              );
            })}
            {!metrics.withSalesHistory.length ? <p>Pendiente de historial de ventas.</p> : null}
            {metrics.withSalesHistory.length && !trappedStock.length ? <p>No hay productos sin movimiento dentro del historial disponible.</p> : null}
          </div>
        </article>
      </section>

      <section className="data-card logistics-catalog">
        <div className="section-title">
          <div><h2>Inventario completo</h2><p>Filtra y resume el catálogo sin desplegar cientos de filas.</p></div>
        </div>
        <div className="logistics-controls">
          <label><Search size={18} /><input aria-label="Buscar producto" onChange={(event) => setQuery(event.target.value)} placeholder="Buscar por SKU o nombre" value={query} /></label>
          <select aria-label="Filtrar inventario" onChange={(event) => setFilter(event.target.value)} value={filter}>
            <option value="all">Todos</option><option value="in_stock">Con stock</option><option value="out_of_stock">Sin stock confirmado</option><option value="with_sales">Con ventas observadas</option><option value="without_movement">Sin movimiento</option><option value="without_history">Sin historial disponible</option>
          </select>
          <select aria-label="Ordenar inventario" onChange={(event) => setSort(event.target.value)} value={sort}>
            <option value="stock">Mayor stock</option><option value="value">Mayor valor a costo</option><option value="sale_value">Mayor valor potencial de venta</option><option value="name">Nombre A-Z</option>
          </select>
        </div>
        <div className="inventory-filter-summary">
          <article><span>Productos</span><strong>{formatNumber.format(filtered.length)}</strong></article>
          <article><span>Unidades</span><strong>{formatNumber.format(filteredUnits)}</strong></article>
          <article><span>Valor a costo</span><strong>{formatCurrency.format(filteredCostValue)}</strong></article>
        </div>
        <button className="inventory-disclosure" type="button" onClick={() => setShowInventory((current) => !current)}>
          {showInventory ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
          {showInventory ? "Ocultar detalle" : `Ver inventario filtrado (${filtered.length})`}
        </button>
        {showInventory ? (
          <>
            <div className="inventory-product-list">
              {visibleInventory.map((item) => {
                const stock = Number(item.available_units ?? 0);
                const unitCost = Number(item.unit_cost_source ?? 0);
                const unitPrice = netUnitPrice(item);
                return (
                  <article className="inventory-product-row" key={item.sku}>
                    <div className="inventory-product-identity">
                      <strong>{item.name || "Sin nombre"}</strong>
                      <span>SKU: {item.sku || "Sin SKU"}</span>
                    </div>
                    <div className="inventory-product-metric">
                      <span>Existencia</span>
                      <strong className={`inventory-status ${stock > 0 ? "ok" : "empty"}`}>
                        {item.stock_known ? formatNumber.format(stock) : "Sin dato"}
                      </strong>
                    </div>
                    <div className="inventory-product-metric">
                      <span>Costo / precio neto sin IVA</span>
                      <strong>
                        {item.cost_available_in_source ? formatCurrency.format(unitCost) : "Sin costo"}
                        {" · "}
                        {item.price_known ? formatCurrency.format(unitPrice) : "Sin precio"}
                      </strong>
                    </div>
                    <div className="inventory-product-metric">
                      <span>Valor costo / venta</span>
                      <strong>
                        {item.stock_known && item.cost_available_in_source
                          ? formatCurrency.format(stock * unitCost)
                          : "Sin dato"}
                        {" · "}
                        {item.stock_known && item.price_known
                          ? formatCurrency.format(stock * unitPrice)
                          : "Sin dato"}
                      </strong>
                    </div>
                    <div className="inventory-product-metric">
                      <span>Ventas / demanda diaria</span>
                      <strong>
                        {item.sales_history_available
                          ? `${formatNumber.format(Number(item.units_sold_observed ?? 0))} un. · ${formatNumber.format(Number(item.average_daily_demand ?? 0))}/día`
                          : "Pendiente de historial"}
                      </strong>
                    </div>
                  </article>
                );
              })}
            </div>
            <nav aria-label="Paginación de inventario" className="inventory-pagination">
              <button disabled={inventoryPage <= 1} type="button" onClick={() => setInventoryPage((page) => Math.max(1, page - 1))}><ChevronLeft size={17} /> Anterior</button>
              <span>Página {inventoryPage} de {totalPages}</span>
              <button disabled={inventoryPage >= totalPages} type="button" onClick={() => setInventoryPage((page) => Math.min(totalPages, page + 1))}>Siguiente <ChevronRight size={17} /></button>
            </nav>
          </>
        ) : null}
      </section>
    </>
  );
}

export function AgentDashboardPage() {
  const { agentType = "logistics" } = useParams();
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) {
      setTasks([]);
      setSnapshots([]);
      setLoading(false);
      return;
    }
    setNotice("");
    try {
      const { data, error } = await supabase.from("business_agent_tasks").select("id,agent_type,status,created_at,completed_at,result,error_code").eq("agent_type", agentType).order("created_at", { ascending: false }).limit(20);
      if (error) throw error;
      setTasks((data ?? []) as AgentTask[]);
      if (agentType === "logistics") setSnapshots(await loadAllSnapshots());
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "No fue posible cargar el dashboard.");
    } finally {
      setLoading(false);
    }
  }, [agentType]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 8000);
    return () => window.clearInterval(timer);
  }, [load]);

  return (
    <section className="agents-page agent-dashboard-page">
      <div className="page-heading agent-heading">
        <div>
          <Link className="back-link" to="/agentes"><ArrowLeft size={17} /> Centro de agentes</Link>
          <span className="eyebrow">DASHBOARD INTERACTIVO</span>
          <h1>{agentNames[agentType] ?? agentType}</h1>
          <p>Indicadores trazables construidos con la información disponible en los sistemas conectados.</p>
        </div>
        <button className="ghost-button" type="button" onClick={() => void load()}><RefreshCw size={18} /> Actualizar</button>
      </div>
      {notice ? <div className="notice-banner error">{notice}</div> : null}
      {loading ? <div className="data-card">Cargando información real de la empresa…</div> : null}
      {!loading && agentType === "logistics" ? <LogisticsDashboard snapshots={snapshots} tasks={tasks} /> : null}
      {!loading && agentType === "finance" ? <FinanceDashboard tasks={tasks} /> : null}
      {!loading && agentType !== "logistics" && agentType !== "finance" ? <GenericAgentDashboard agentType={agentType} tasks={tasks} /> : null}
    </section>
  );
}
