import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  BarChart3,
  Boxes,
  Building2,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleDollarSign,
  Database,
  Download,
  FileSpreadsheet,
  Landmark,
  PackageCheck,
  RefreshCw,
  Search,
  ShieldCheck,
  TrendingUp,
  UserPlus,
} from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { isSupabaseConfigured, supabase } from "../../lib/supabase";
import type { Company } from "../../types/crm";
import { useCompanyStore } from "../companies/CompanyStore";

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

type ForeignTradeProduct = {
  sku: string;
  name?: string;
  supplier?: string;
  available_units: number;
  confirmed_inbound_units?: number;
  active_import_inbound_units?: number;
  active_import_orders?: string[];
  average_daily_demand: number;
  coverage_days?: number | null;
  recommended_units: number;
  order_multiple: number;
  unit_fob_usd: number;
  unit_cbm: number;
  severity: string;
  projected_stockout_date?: string | null;
  required_order_date?: string | null;
  projected_arrival_date?: string | null;
  match_score: number;
  match_method: string;
  source_document?: string;
  volume_evidence?: string;
  costs: {
    fob_usd: number;
    freight_usd: number;
    insurance_usd: number;
    customs_duty_usd: number;
    local_and_agency_usd: number;
    landed_cost_usd: number;
    recoverable_import_vat_cash_usd: number;
    total_cbm: number;
  };
};

type ForeignTradeReport = {
  generated_at: string;
  policy: {
    production_days: number;
    sea_travel_days: number;
    customs_delay_days: number;
    lead_time_days: number;
    safety_stock_days: number;
    review_period_days: number;
    target_coverage_days: number;
    high_season_months: number[];
    factory_shutdown_months: number[];
    purchase_range_usd: [number, number];
    human_approval_required: boolean;
  };
  catalog: {
    products: number;
    with_sku: number;
    with_fob: number;
    with_cbm: number;
    matched_inventory_products: number;
    matched_with_cbm: number;
    source_documents?: Array<{ file: string; kind: string }>;
    items?: Array<{
      sku?: string | null;
      name?: string | null;
      supplier?: string | null;
      unit_fob_usd?: number | null;
      unit_cbm?: number | null;
      order_multiple?: number | null;
      cartons?: number | null;
      gross_weight_kg?: number | null;
      source_document?: string | null;
      source_row?: number | null;
      volume_evidence?: string | null;
    }>;
  };
  historical_cost_reference: {
    reference?: Record<string, number | string>;
    derived_rates?: Record<string, number>;
    vat_policy?: string;
    sources?: Array<{ file?: string; purpose?: string }>;
  };
  active_imports?: Array<{
    order_number: string;
    reference?: string;
    supplier: string;
    proforma_date: string;
    production_start_date: string;
    production_start_basis?: string;
    status: string;
    inventory_status: string;
    stock_policy: string;
    container: string;
    incoterm: string;
    payment_terms?: string;
    timeline: {
      production_days: number;
      sea_travel_days: number;
      customs_days: number;
      production_end_date: string;
      estimated_port_arrival_date: string;
      estimated_warehouse_date: string;
      elapsed_production_days: number;
      remaining_total_days: number;
      production_progress_percent: number;
    };
    totals: {
      fob_usd: number;
      cartons: number;
      gross_weight_kg: number;
      total_cbm: number;
    };
    estimated_costs?: ForeignTradeProduct["costs"];
    items: Array<{
      line_number: number;
      name: string;
      sku?: string | null;
      quantity: number;
      unit: string;
      unit_fob_usd: number;
      total_fob_usd: number;
      cartons: number;
      gross_weight_kg: number;
      total_cbm: number;
      unit_cbm?: number | null;
      volume_evidence: string;
      status: string;
      source_page: number;
    }>;
    source: { file: string; pages: number; kind: string };
  }>;
  demand_multiplier: number;
  projected_arrival_date: string;
  products: ForeignTradeProduct[];
  purchase_proposal: {
    status: string;
    items: ForeignTradeProduct[];
    totals: ForeignTradeProduct["costs"];
    container_reference_cbm: number;
    container_utilization_percent: number;
    required_order_date?: string | null;
    projected_arrival_date: string;
    warnings: string[];
  };
  methodology: string;
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
  tax?: number;
  gross_purchases?: number;
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
  folios?: string[];
};

type CollectionReport = {
  mode: "facto_receivables" | "facto_document_pdf" | "manual_facto_verification" | "registered_payments" | "unavailable";
  source?: string;
  authoritative?: boolean;
  receivables_available?: boolean;
  portfolio_complete?: boolean;
  pdf_coverage?: {
    documents_examined?: number;
    documents_with_pdf: number;
    documents_with_balance: number;
    percent: number;
    complete: boolean;
  };
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

const FACTO_MANUAL_RECEIVABLES_VERIFICATION: CollectionReport = {
  mode: "manual_facto_verification",
  source: "Facto web - Cobranza - Documentos impagos",
  authoritative: true,
  receivables_available: true,
  portfolio_complete: false,
  payments_available: false,
  as_of: "2026-07-31T12:00:00-04:00",
  reviewed_documents: 18,
  reviewed_amount: 30_756_397,
  observed_amount: 30_756_397,
  overdue_amount: 0,
  due_next_30: 0,
  documents: 18,
  overdue_documents: 0,
  payments_registered: 0,
  payment_count: 0,
  aging: [],
  customers: [
    { name: "ANDREA DE LA LUZ GARAY MUNOZ", tax_id: "12.899.411-4", amount: 10_819_287, overdue: 0, due_next_30: 0, documents: 1, max_days_overdue: 0, folios: ["1.534"] },
    { name: "MARIA ANGELICA ROJAS SANDOVAL", tax_id: "8.455.967-9", amount: 6_595_772, overdue: 0, due_next_30: 0, documents: 3, max_days_overdue: 0, folios: ["1.422", "1.508", "1.523"] },
    { name: "MEGAFRIO SUR SPA", tax_id: "77.073.845-8", amount: 3_900_687, overdue: 0, due_next_30: 0, documents: 4, max_days_overdue: 0, folios: ["1.429", "1.444", "1.519", "1.520"] },
    { name: "ACONDIPARTS CENTER SPA", tax_id: "76.792.857-2", amount: 3_396_759, overdue: 0, due_next_30: 0, documents: 2, max_days_overdue: 0, folios: ["1.512", "1.522"] },
    { name: "MARBA - REFRIGERACION, AIRE ACONDICIONADO, CLIMATIZACION SPA", tax_id: "76.919.986-1", amount: 2_902_930, overdue: 0, due_next_30: 0, documents: 2, max_days_overdue: 0, folios: ["1.510", "1.535"] },
    { name: "AIRE ACONDICIONADO LUIS SEBASTIAN VERGARA MARQUEZ E.I.R.L.", tax_id: "76.705.500-5", amount: 2_875_351, overdue: 0, due_next_30: 0, documents: 1, max_days_overdue: 0, folios: ["1.517"] },
    { name: "MORETO CLIMA LIMITADA", tax_id: "76.344.054-0", amount: 225_624, overdue: 0, due_next_30: 0, documents: 1, max_days_overdue: 0, folios: ["1.513"] },
    { name: "CLIMATIZA MYM SPA", tax_id: "77.956.938-1", amount: 20_150, overdue: 0, due_next_30: 0, documents: 3, max_days_overdue: 0, folios: ["1.353", "1.367", "1.447"] },
    { name: "ELECTRONICOS ARCO SPA", tax_id: "77.339.672-8", amount: 19_837, overdue: 0, due_next_30: 0, documents: 1, max_days_overdue: 0, folios: ["1.420"] },
  ],
  payments_by_month: [],
  disclaimer: "Corte verificado manualmente en Facto el 31-07-2026. No se actualiza automaticamente y sera reemplazado por la ruta API oficial de documentos impagos.",
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
  purchase_tax?: number;
  gross_purchases?: number;
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

type AccountingPrebalanceRow = {
  account_code: string;
  account_name: string;
  sum_debit: number;
  sum_credit: number;
  balance_debtor: number;
  balance_creditor: number;
  inventory_asset: number;
  inventory_liability: number;
  result_loss: number;
  result_gain: number;
  nature: string;
};

type AccountingBankSummary = {
  account_code: string;
  name: string;
  balance_clp: number;
};

type AccountingPayrollPeriod = {
  period: string;
  taxable_salary: number;
  net_payable: number;
  employer_contributions: number;
  total_employer_cost: number;
  health_certified: boolean;
  status: string;
};

type AccountingSnapshot = {
  id: string;
  fiscal_year: number;
  version: number;
  period_start: string;
  period_end: string;
  status: "provisional" | "reviewed" | "closed";
  basis: string;
  source_coverage: {
    accounts?: Record<string, {
      transactions?: number;
      from?: string;
      to?: string;
      clp_valued?: number;
      pending_fx?: number;
    }>;
    missing_sources?: string[];
    verified_zero_activity?: string[];
    payroll_periods?: number;
    payroll_estimated_health_periods?: string[];
    facto?: {
      source?: string;
      sales_documents?: number;
      purchase_documents?: number;
      net_sales?: number;
      sales_tax?: number;
      gross_sales?: number;
      net_purchases?: number;
      purchase_tax?: number;
      gross_purchases?: number;
      period_start?: string | null;
      period_end?: string | null;
    };
    tax_folder?: {
      source?: string;
      generated_at?: string;
      period_start?: string;
      period_end?: string;
      f29_taxable_sales?: number;
      f29_debit_vat?: number;
      f29_domestic_credit_vat?: number;
      f29_import_credit_vat?: number;
      f29_determined_vat?: number;
      f29_ppm?: number;
      import_customs_base_reference?: number;
      prior_year_taxable_base?: number;
      prior_year_business_income?: number;
    };
  };
  bank_summary: AccountingBankSummary[];
  payroll_summary: {
    employee_count?: number;
    periods?: AccountingPayrollPeriod[];
    total_taxable_salary?: number;
    total_net_payable?: number;
    total_employer_contributions?: number;
    total_employer_cost?: number;
    estimated_health_periods?: string[];
    identity_redacted?: boolean;
  };
  prebalance_rows: AccountingPrebalanceRow[];
  controls: {
    journal_debit?: number;
    journal_credit?: number;
    journal_balanced?: boolean;
    balance_sheet_balanced?: boolean;
    bank_balance_clp?: number;
    unclassified_debits?: number;
    unidentified_credits?: number;
    reconciliation_assets?: number;
    movements_total?: number;
    movements_pending_fx?: number;
    facto_net_sales?: number;
    facto_net_purchases?: number;
    facto_sales_tax?: number;
    facto_purchase_tax?: number;
    facto_gross_sales?: number;
    facto_gross_purchases?: number;
    documentary_result_before_inventory?: number;
    f29_sales_variance?: number;
    profit_certifiable?: boolean;
    current_inventory_cost?: number;
    current_inventory_net_sale_value?: number;
  };
  findings: Array<{ severity?: string; title?: string; detail?: string }>;
  artifact_metadata?: { workbook_name?: string; generated_at?: string };
  updated_at?: string;
};

type CommercialCustomer = {
  customer_key: string;
  name?: string;
  legal_name?: string;
  tax_id?: string;
  email?: string;
  phone?: string;
  whatsapp?: string;
  region?: string;
  city?: string;
  address?: string;
  location_source?: string;
  location_verified_at?: string | null;
  sources?: string[];
  source_channel?: "facto_only" | "tiendanube_only" | "both" | "crm_only";
  lifecycle?: "new" | "active" | "at_risk" | "dormant" | "no_purchase";
  contactable?: boolean;
  facto_net_sales?: number;
  facto_documents?: number;
  tiendanube_gross_sales?: number;
  tiendanube_orders?: number;
  first_purchase_at?: string | null;
  last_purchase_at?: string | null;
  days_since_purchase?: number | null;
  crm_company_id?: string;
  crm_type?: string;
  crm_status?: string;
  crm_priority?: string;
  email_ready?: boolean;
  whatsapp_ready?: boolean;
  purchase_events?: number;
  average_net_ticket?: number;
  commercial_value?: number;
  commercial_score?: number;
  value_tier?: "A" | "B" | "C" | "D";
  recommended_action?: string;
  recommended_action_label?: string;
  opportunity_priority?: "urgent" | "high" | "medium" | "normal";
  top_products?: Array<{ name: string; units: number }>;
  product_families?: Array<{ name: string; units: number }>;
};

type CommercialRanking = CommercialCustomer & {
  documents?: number;
  gross_sales?: number;
  net_sales?: number;
};

type CommercialSalesProduct = {
  name?: string;
  sku?: string;
  units?: number;
  net_sales?: number;
};

type CommercialSegment = {
  id: string;
  name: string;
  reason: string;
  channel: string;
  count: number;
  customer_keys?: string[];
  company_ids?: string[];
  priority?: "urgent" | "high" | "medium" | "normal";
  email_count?: number;
  whatsapp_count?: number;
  filters?: Record<string, string | number | boolean | string[]>;
};

type CommercialReport = {
  generated_at: string;
  customers: CommercialCustomer[];
  metrics: {
    customers: number;
    contactable: number;
    facto_net_sales: number;
    facto_customers: number;
    tiendanube_customers: number;
    crm_companies: number;
    email_ready?: number;
    whatsapp_ready?: number;
    active_customers?: number;
    customers_at_risk?: number;
    omnichannel_customers?: number;
    high_value_customers?: number;
    campaign_ready?: number;
  };
  source_counts: Record<string, number>;
  lifecycle_counts: Record<string, number>;
  type_counts: Record<string, number>;
  region_counts: Record<string, number>;
  acquisition_by_month: Array<{
    month: string;
    new_customers: number;
    returning_customers: number;
  }>;
  segments: CommercialSegment[];
  opportunity_counts?: Record<string, number>;
  top_opportunities?: CommercialCustomer[];
  facto_ranking?: CommercialRanking[];
  tiendanube_ranking?: CommercialRanking[];
  sales_products?: CommercialSalesProduct[];
  methodology: string;
};

type CommercialSnapshot = {
  generated_at?: string;
  customers: CommercialCustomer[];
  sources?: Record<string, number>;
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
const formatUsd = new Intl.NumberFormat("es-CL", {
  style: "currency",
  currency: "USD",
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

function foreignTradeReportFromTasks(tasks: AgentTask[]): ForeignTradeReport | null {
  for (const task of tasks) {
    for (const entry of task.result?.evidence ?? []) {
      const report = entry.foreign_trade_report;
      if (report && typeof report === "object") return report as ForeignTradeReport;
    }
  }
  return null;
}

function shortDate(value?: string | null) {
  if (!value) return "Sin fecha";
  return new Intl.DateTimeFormat("es-CL", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(new Date(`${value}T12:00:00`));
}

function ForeignTradeDashboard({ tasks }: { tasks: AgentTask[] }) {
  const report = useMemo(() => foreignTradeReportFromTasks(tasks), [tasks]);
  const [catalogSearch, setCatalogSearch] = useState("");
  const [volumeFilter, setVolumeFilter] = useState("all");
  const [activeImportSearch, setActiveImportSearch] = useState("");
  const latest = tasks[0];

  const catalogItems = useMemo(() => {
    if (!report) return [];
    const normalized = catalogSearch.trim().toLocaleLowerCase("es-CL");
    return (report.catalog.items ?? [])
      .filter((item) => {
        if (volumeFilter === "with_cbm" && !Number(item.unit_cbm ?? 0)) return false;
        if (volumeFilter === "missing_cbm" && Number(item.unit_cbm ?? 0)) return false;
        if (!normalized) return true;
        return `${item.sku ?? ""} ${item.name ?? ""}`.toLocaleLowerCase("es-CL").includes(normalized);
      })
      .sort((a, b) => String(a.sku ?? a.name ?? "").localeCompare(String(b.sku ?? b.name ?? ""), "es"));
  }, [catalogSearch, report, volumeFilter]);

  const activeImportItems = useMemo(() => {
    const activeImport = report?.active_imports?.[0];
    if (!activeImport) return [];
    const normalized = activeImportSearch.trim().toLocaleLowerCase("es-CL");
    if (!normalized) return activeImport.items;
    return activeImport.items.filter((item) =>
      `${item.line_number} ${item.sku ?? ""} ${item.name}`
        .toLocaleLowerCase("es-CL")
        .includes(normalized),
    );
  }, [activeImportSearch, report]);

  if (!report) {
    return (
      <section className="data-card agent-dashboard-summary">
        <span className="eyebrow">PLAN MAESTRO DE IMPORTACIÓN</span>
        <h2>Análisis consolidado pendiente</h2>
        <p>
          {latest?.status === "pending" || latest?.status === "in_progress"
            ? "El agente está cruzando stock y ventas de Facto con los documentos Chinafore y los costos históricos de aduana."
            : "Solicita un análisis desde el Centro de agentes para generar la tabla de m³ y la propuesta de compra."}
        </p>
      </section>
    );
  }

  const proposal = report.purchase_proposal;
  const activeImport = report.active_imports?.[0];
  const totals = proposal.totals;
  const highRisk = report.products.filter((item) => item.severity === "critical" || item.severity === "high").length;
  const costSlices: DonutSlice[] = [
    { label: "Mercadería FOB", value: totals.fob_usd, color: "#0b8793" },
    { label: "Flete internacional", value: totals.freight_usd, color: "#2f7ec8" },
    { label: "Seguro", value: totals.insurance_usd, color: "#7c6bc4" },
    { label: "Derechos aduaneros", value: totals.customs_duty_usd, color: "#e69b1f" },
    { label: "Gastos locales y agencia", value: totals.local_and_agency_usd, color: "#d97732" },
  ];

  return (
    <>
      <section className="agent-dashboard-kpis foreign-trade-kpis">
        <article>
          <Database size={22} />
          <span>Catálogo Chinafore</span>
          <strong>{formatNumber.format(report.catalog.products)}</strong>
          <small>{report.catalog.with_cbm} con m³ respaldado</small>
        </article>
        <article>
          <PackageCheck size={22} />
          <span>Cruce con Facto</span>
          <strong>{formatNumber.format(report.catalog.matched_inventory_products)}</strong>
          <small>SKU o nombre coincidente</small>
        </article>
        <article className={highRisk ? "risk" : ""}>
          <AlertTriangle size={22} />
          <span>Riesgo de quiebre</span>
          <strong>{formatNumber.format(highRisk)}</strong>
          <small>Crítico o alto</small>
        </article>
        <article>
          <FileSpreadsheet size={22} />
          <span>Productos propuestos</span>
          <strong>{formatNumber.format(proposal.items.length)}</strong>
          <small>Siempre con revisión humana</small>
        </article>
        <article>
          <CircleDollarSign size={22} />
          <span>Orden FOB sugerida</span>
          <strong>{formatUsd.format(totals.fob_usd)}</strong>
          <small>Rango objetivo USD 50–70 mil</small>
        </article>
        <article>
          <Boxes size={22} />
          <span>Volumen sugerido</span>
          <strong>{formatNumber.format(totals.total_cbm)} m³</strong>
          <small>{formatNumber.format(proposal.container_utilization_percent)}% del contenedor histórico</small>
        </article>
        <article className={activeImport ? "active-import" : ""}>
          <PackageCheck size={22} />
          <span>Mercadería en producción</span>
          <strong>{formatNumber.format(activeImport?.items.length ?? 0)}</strong>
          <small>{activeImport ? `Orden ${activeImport.order_number} · entrada confirmada` : "Sin órdenes activas"}</small>
        </article>
      </section>

      {activeImport ? (
        <section className="data-card active-import-card">
          <div className="section-title active-import-heading">
            <div>
              <span className="eyebrow">IMPORTACIÓN EN CURSO</span>
              <h2>Orden {activeImport.order_number} · Chinafore</h2>
              <p>
                Mercadería confirmada en producción. Se considera en la planificación de reposición,
                pero no aumenta el stock disponible hasta su recepción en bodega.
              </p>
            </div>
            <span className="status-chip partial">En producción</span>
          </div>

          <div className="active-import-progress-head">
            <strong>
              Día {activeImport.timeline.elapsed_production_days} de {activeImport.timeline.production_days} de producción
            </strong>
            <span>{formatNumber.format(activeImport.timeline.production_progress_percent)}%</span>
          </div>
          <div className="active-import-progress" aria-label="Avance de producción">
            <span style={{ width: `${Math.min(100, activeImport.timeline.production_progress_percent)}%` }} />
          </div>

          <div className="active-import-milestones">
            <article><span>Inicio producción</span><strong>{shortDate(activeImport.production_start_date)}</strong></article>
            <article><span>Fin producción</span><strong>{shortDate(activeImport.timeline.production_end_date)}</strong></article>
            <article><span>Llegada a puerto</span><strong>{shortDate(activeImport.timeline.estimated_port_arrival_date)}</strong></article>
            <article><span>Ingreso a bodega</span><strong>{shortDate(activeImport.timeline.estimated_warehouse_date)}</strong></article>
          </div>

          <div className="active-import-stats">
            <article><span>FOB confirmado</span><strong>{formatUsd.format(activeImport.totals.fob_usd)}</strong></article>
            <article><span>Volumen</span><strong>{formatNumber.format(activeImport.totals.total_cbm)} m³</strong></article>
            <article><span>Cajas</span><strong>{formatNumber.format(activeImport.totals.cartons)}</strong></article>
            <article><span>Peso bruto</span><strong>{formatNumber.format(activeImport.totals.gross_weight_kg)} kg</strong></article>
            <article><span>Contenedor</span><strong>{activeImport.container}</strong></article>
            <article><span>Costo puesto estimado</span><strong>{formatUsd.format(activeImport.estimated_costs?.landed_cost_usd ?? 0)}</strong></article>
          </div>

          <div className="active-import-alert">
            <AlertTriangle size={18} />
            <span>
              Llegada estimada el <strong>{shortDate(activeImport.timeline.estimated_warehouse_date)}</strong>,
              antes de la temporada alta noviembre–febrero. Faltan {activeImport.timeline.remaining_total_days} días.
            </span>
          </div>

          <div className="active-import-products-title">
            <div>
              <h3>Partidas de la proforma</h3>
              <p>{activeImportItems.length} de {activeImport.items.length} productos visibles.</p>
            </div>
            <label><Search size={18} /><input value={activeImportSearch} onChange={(event) => setActiveImportSearch(event.target.value)} placeholder="Buscar producto o SKU" /></label>
          </div>
          <div className="active-import-table-wrap">
            <table className="foreign-trade-table active-import-table">
              <thead><tr><th>Línea</th><th>Producto</th><th>Cantidad</th><th>FOB unitario</th><th>FOB total</th><th>m³</th></tr></thead>
              <tbody>
                {activeImportItems.map((item) => (
                  <tr key={item.line_number}>
                    <td data-label="Línea"><strong>{item.line_number}</strong></td>
                    <td data-label="Producto"><strong>{item.name}</strong><span>{item.sku || "SKU por homologar"}</span></td>
                    <td data-label="Cantidad"><strong>{formatNumber.format(item.quantity)} {item.unit}</strong><span>{formatNumber.format(item.cartons)} cajas</span></td>
                    <td data-label="FOB unitario"><strong>{formatUsd.format(item.unit_fob_usd)}</strong></td>
                    <td data-label="FOB total"><strong>{formatUsd.format(item.total_fob_usd)}</strong></td>
                    <td data-label="m³"><strong>{item.total_cbm ? formatNumber.format(item.total_cbm) : "Pendiente"}</strong><span>Página {item.source_page}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <small className="active-import-source">Fuente: {activeImport.source.file}, {activeImport.source.pages} páginas · {activeImport.incoterm}</small>
        </section>
      ) : null}

      <section className="foreign-trade-overview-grid">
        <article className="data-card foreign-trade-timeline">
          <div className="section-title">
            <div>
              <span className="eyebrow">CICLO DE ABASTECIMIENTO</span>
              <h2>{report.policy.lead_time_days} días hasta bodega</h2>
              <p>Política maestra configurable y aplicada a cada sugerencia.</p>
            </div>
          </div>
          <div className="import-timeline">
            <article><strong>{report.policy.production_days}</strong><span>días de producción</span></article>
            <article><strong>{report.policy.sea_travel_days}</strong><span>días de viaje</span></article>
            <article><strong>{report.policy.customs_delay_days}</strong><span>días de aduana</span></article>
          </div>
          <div className="foreign-trade-policy-grid">
            <div><span>Stock de seguridad</span><strong>{report.policy.safety_stock_days} días</strong></div>
            <div><span>Revisión de compra</span><strong>{report.policy.review_period_days} días</strong></div>
            <div><span>Cobertura objetivo</span><strong>{report.policy.target_coverage_days} días</strong></div>
            <div><span>Llegada proyectada</span><strong>{shortDate(report.projected_arrival_date)}</strong></div>
          </div>
          <div className="dashboard-warning"><AlertTriangle size={18} /> Temporada alta: noviembre a febrero. Pausa de fábrica china: febrero.</div>
        </article>

        <DonutChart
          centerLabel="COSTO PUESTO"
          centerValue={formatUsd.format(totals.landed_cost_usd)}
          formatter={(value) => formatUsd.format(value)}
          slices={costSlices}
          subtitle="Estimación basada en el despacho real 49194. El IVA se informa aparte."
          title="Composición del costo de importación"
        />
      </section>

      <section className="data-card foreign-trade-cash-card">
        <div>
          <span className="eyebrow">NECESIDAD DE CAJA</span>
          <h2>IVA de importación recuperable</h2>
          <p>No se suma al costo del inventario; sí debe financiarse durante la internación.</p>
        </div>
        <strong>{formatUsd.format(totals.recoverable_import_vat_cash_usd)}</strong>
      </section>

      <section className="data-card foreign-trade-proposal">
        <div className="section-title">
          <div>
            <span className="eyebrow">PROPUESTA CONSOLIDADA</span>
            <h2>Compra sugerida a Chinafore</h2>
            <p>
              Ordenar antes de {shortDate(proposal.required_order_date)} para una llegada estimada el {shortDate(proposal.projected_arrival_date)}.
            </p>
          </div>
          <span className={`status-chip ${proposal.items.length ? "partial" : "pending"}`}>
            {proposal.items.length ? "Pendiente de aprobación" : "Sin compra necesaria"}
          </span>
        </div>
        {proposal.items.length ? (
          <div className="foreign-trade-table-wrap">
            <table className="foreign-trade-table">
              <thead>
                <tr>
                  <th>Producto</th><th>Stock / demanda</th><th>Cobertura</th><th>Compra sugerida</th><th>m³</th><th>FOB</th><th>Costo puesto</th>
                </tr>
              </thead>
              <tbody>
                {proposal.items.map((item) => (
                  <tr key={`${item.sku}-${item.source_document}`}>
                    <td data-label="Producto"><strong>{item.name || item.sku}</strong><span>{item.sku}</span></td>
                    <td data-label="Stock / demanda"><strong>{formatNumber.format(item.available_units)} un.</strong><span>{formatNumber.format(item.average_daily_demand)} por día · {formatNumber.format(item.confirmed_inbound_units ?? 0)} en tránsito</span></td>
                    <td data-label="Cobertura"><strong>{item.coverage_days == null ? "Sin demanda" : `${formatNumber.format(item.coverage_days)} días`}</strong><span>{item.severity}</span></td>
                    <td data-label="Compra sugerida"><strong>{formatNumber.format(item.recommended_units)} un.</strong><span>Múltiplo {formatNumber.format(item.order_multiple)}</span></td>
                    <td data-label="m³"><strong>{formatNumber.format(item.costs.total_cbm)}</strong><span>{item.unit_cbm ? `${item.unit_cbm.toFixed(5)} por unidad` : "Sin volumen"}</span></td>
                    <td data-label="FOB"><strong>{formatUsd.format(item.costs.fob_usd)}</strong><span>{formatUsd.format(item.unit_fob_usd)} / un.</span></td>
                    <td data-label="Costo puesto"><strong>{formatUsd.format(item.costs.landed_cost_usd)}</strong><span>IVA aparte</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <div className="empty-state">La demanda y el stock observados no activan una reposición en este corte.</div>}
        {proposal.warnings.map((warning) => <div className="dashboard-warning" key={warning}><AlertTriangle size={18} /> {warning}</div>)}
      </section>

      <section className="data-card foreign-trade-catalog">
        <div className="section-title">
          <div>
            <span className="eyebrow">CATÁLOGO DE IMPORTACIÓN</span>
            <h2>Productos, FOB y metro cúbico</h2>
            <p>{catalogItems.length} referencias coinciden con los filtros. Cada dato conserva documento y fila de origen.</p>
          </div>
        </div>
        <div className="foreign-trade-catalog-controls">
          <label><Search size={18} /><input value={catalogSearch} onChange={(event) => setCatalogSearch(event.target.value)} placeholder="Buscar SKU o producto" /></label>
          <select value={volumeFilter} onChange={(event) => setVolumeFilter(event.target.value)}>
            <option value="all">Todos los productos</option>
            <option value="with_cbm">Con m³ documentado</option>
            <option value="missing_cbm">Pendiente de m³</option>
          </select>
        </div>
        <div className="foreign-trade-catalog-list">
          {catalogItems.map((item, index) => (
            <article key={`${item.sku}-${item.source_document}-${item.source_row}-${index}`}>
              <div><strong>{item.name || item.sku || "Sin nombre"}</strong><span>SKU: {item.sku || "Pendiente"}</span></div>
              <div><span>FOB unitario</span><strong>{item.unit_fob_usd ? formatUsd.format(item.unit_fob_usd) : "Pendiente"}</strong></div>
              <div><span>m³ unitario</span><strong>{item.unit_cbm ? item.unit_cbm.toFixed(6) : "Pendiente"}</strong></div>
              <div><span>Origen</span><strong>{item.source_document || "Sin documento"}</strong><small>Fila {item.source_row ?? "—"}</small></div>
            </article>
          ))}
        </div>
      </section>

      <section className="data-card agent-dashboard-summary">
        <span className="eyebrow">TRAZABILIDAD Y CONTROL</span>
        <h2>Cómo se construyó este análisis</h2>
        <p>{report.methodology}</p>
        <div className="foreign-trade-source-list">
          {(report.catalog.source_documents ?? []).map((source) => <span key={source.file}><ShieldCheck size={16} /> {source.file}</span>)}
        </div>
      </section>
    </>
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

function commercialReportFromTasks(tasks: AgentTask[]): CommercialReport | null {
  let bestReport: CommercialReport | null = null;
  let bestExternalCustomers = -1;
  for (const task of tasks) {
    for (const entry of task.result?.evidence ?? []) {
      const report = entry.commercial_report;
      if (report && typeof report === "object") {
        const candidate = report as CommercialReport;
        const externalCustomers =
          Number(candidate.metrics?.facto_customers ?? 0) +
          Number(candidate.metrics?.tiendanube_customers ?? 0);
        if (!bestReport || externalCustomers > bestExternalCustomers) {
          bestReport = candidate;
          bestExternalCustomers = externalCustomers;
        }
      }
    }
  }
  return bestReport;
}

const commercialSourceLabels: Record<string, string> = {
  facto_only: "Sólo Facto",
  tiendanube_only: "Sólo Climactiva.cl",
  both: "Facto + Climactiva.cl",
  crm_only: "Sólo CRM",
};

const commercialLifecycleLabels: Record<string, string> = {
  new: "Nuevo",
  active: "Activo",
  at_risk: "En riesgo",
  dormant: "Inactivo",
  no_purchase: "Sin compra vinculada",
};

const commercialActionLabels: Record<string, string> = {
  rescue_priority: "Recuperar cliente valioso",
  convert_web_to_b2b: "Convertir comprador web a B2B",
  reactivate: "Reactivar relación comercial",
  onboard: "Acompañar primera recompra",
  loyalty_cross_sell: "Fidelizar y ofrecer venta cruzada",
  complete_contact: "Completar datos de contacto",
  qualify: "Calificar oportunidad",
  follow_up: "Realizar seguimiento",
};

const commercialPriorityLabels: Record<string, string> = {
  urgent: "Urgente",
  high: "Alta",
  medium: "Media",
  normal: "Normal",
};

function normalizeExactRut(value?: string) {
  return (value ?? "").replace(/[^0-9kK]/g, "").toUpperCase();
}

function normalizeExactEmail(value?: string) {
  return (value ?? "").trim().toLocaleLowerCase("es-CL");
}

function normalizeExactPhone(value?: string) {
  const digits = (value ?? "").replace(/\D/g, "");
  if (digits.length === 9 && digits.startsWith("9")) return `56${digits}`;
  return digits;
}

function findMatchingCompany(customer: CommercialCustomer, companies: Company[]) {
  if (customer.crm_company_id) {
    const linked = companies.find((company) => company.id === customer.crm_company_id);
    if (linked) return linked;
  }
  const rut = normalizeExactRut(customer.tax_id);
  const email = normalizeExactEmail(customer.email);
  const phones = new Set(
    [customer.whatsapp, customer.phone].map(normalizeExactPhone).filter(Boolean),
  );
  return companies.find((company) => {
    if (rut && normalizeExactRut(company.rut) === rut) return true;
    if (email && normalizeExactEmail(company.email) === email) return true;
    return [company.whatsapp, company.whatsappNumber, company.phone]
      .map(normalizeExactPhone)
      .some((phone) => phone && phones.has(phone));
  });
}

function customerImportKey(customer: CommercialCustomer) {
  const rut = normalizeExactRut(customer.tax_id);
  if (rut) return `rut:${rut}`;
  const email = normalizeExactEmail(customer.email);
  if (email) return `email:${email}`;
  const phone = normalizeExactPhone(customer.whatsapp || customer.phone);
  if (phone) return `phone:${phone}`;
  return "";
}

function companyDraftFromCustomer(customer: CommercialCustomer): Omit<Company, "id"> {
  const sourceLabel =
    commercialSourceLabels[customer.source_channel ?? ""] ||
    (customer.sources ?? []).join(" + ") ||
    "Agente Comercial";
  const normalizedPhone = normalizeExactPhone(customer.whatsapp || customer.phone);
  const whatsappNumber =
    normalizeExactPhone(customer.whatsapp) ||
    (normalizedPhone.startsWith("569") ? normalizedPhone : "");
  const whatsapp = whatsappNumber ? `+${whatsappNumber}` : "";
  const phone = normalizedPhone ? `+${normalizedPhone}` : "";
  const sourceTags = [
    ...(customer.sources?.includes("facto") ? ["facto"] : []),
    ...(customer.sources?.includes("tiendanube") ? ["tiendanube", "climactiva.cl"] : []),
  ];
  const priority =
    customer.value_tier === "A"
      ? "alta"
      : customer.value_tier === "B"
        ? "media"
        : "baja";

  return {
    name: customer.name || customer.legal_name || customer.tax_id || "Cliente por identificar",
    legalName: customer.legal_name || customer.name || "",
    description: `Cliente identificado por el Agente Comercial desde ${sourceLabel}.`,
    rut: customer.tax_id || "",
    businessLine: "Cliente HVAC por clasificar",
    type: "otro",
    city: customer.city || "",
    region: customer.region || "",
    address: customer.address || "",
    website: "",
    instagram: "",
    facebook: "",
    whatsapp,
    whatsappNumber: whatsapp,
    whatsappOptIn: false,
    whatsappStatus: "sin_consentimiento",
    phone,
    email: normalizeExactEmail(customer.email),
    contactName: "",
    contactRole: "",
    priority,
    source: sourceLabel,
    notes: [
      "Importado manualmente desde el dashboard del Agente Comercial.",
      `Identidad externa: ${customer.customer_key}.`,
      `Valor observado: ${formatCurrency.format(
        Number(customer.commercial_value ?? customer.facto_net_sales ?? 0),
      )}.`,
      "Requiere revisión humana de clasificación y consentimiento antes de campañas.",
    ].join(" "),
    status: Number(customer.purchase_events ?? 0) > 0 ? "cliente" : "prospecto",
    nextFollowUp: "",
    tags: ["cliente importado", "agente comercial", ...sourceTags],
  };
}

function mergeCommercialPortfolio(
  report: CommercialReport | null,
  synchronizedCustomers: CommercialCustomer[],
  synchronizedProducts: CommercialSalesProduct[],
): CommercialReport | null {
  if (!report && !synchronizedCustomers.length) return null;

  const base: CommercialReport = report ?? {
    generated_at: new Date().toISOString(),
    customers: [],
    metrics: {
      customers: 0,
      contactable: 0,
      facto_net_sales: 0,
      facto_customers: 0,
      tiendanube_customers: 0,
      crm_companies: 0,
    },
    source_counts: {},
    lifecycle_counts: {},
    type_counts: {},
    region_counts: {},
    acquisition_by_month: [],
    segments: [],
    methodology:
      "Cartera sincronizada directamente desde Facto y Climactiva.cl; requiere revisión humana.",
  };

  if (!synchronizedCustomers.length) {
    return synchronizedProducts.length && !base.sales_products?.length
      ? { ...base, sales_products: synchronizedProducts }
      : base;
  }

  const customers = [...base.customers];
  const identityIndex = new Map<string, number>();
  customers.forEach((customer, index) => {
    const key = customerImportKey(customer);
    if (key) identityIndex.set(key, index);
  });

  for (const synchronized of synchronizedCustomers) {
    const key = customerImportKey(synchronized);
    const existingIndex = key ? identityIndex.get(key) : undefined;
    if (existingIndex === undefined) {
      customers.push(synchronized);
      if (key) identityIndex.set(key, customers.length - 1);
      continue;
    }

    const existing = customers[existingIndex];
    const sources = Array.from(
      new Set([...(synchronized.sources ?? []), ...(existing.sources ?? [])]),
    );
    const externalSources = sources.filter((source) =>
      source === "facto" || source === "tiendanube",
    );
    customers[existingIndex] = {
      ...synchronized,
      ...existing,
      sources,
      source_channel:
        externalSources.includes("facto") && externalSources.includes("tiendanube")
          ? "both"
          : externalSources.includes("tiendanube")
            ? "tiendanube_only"
            : externalSources.includes("facto")
              ? "facto_only"
              : "crm_only",
      facto_net_sales: Number(synchronized.facto_net_sales ?? existing.facto_net_sales ?? 0),
      facto_documents: Number(synchronized.facto_documents ?? existing.facto_documents ?? 0),
      tiendanube_gross_sales: Number(
        synchronized.tiendanube_gross_sales ?? existing.tiendanube_gross_sales ?? 0,
      ),
      tiendanube_orders: Number(
        synchronized.tiendanube_orders ?? existing.tiendanube_orders ?? 0,
      ),
      first_purchase_at:
        synchronized.first_purchase_at ?? existing.first_purchase_at ?? null,
      last_purchase_at:
        synchronized.last_purchase_at ?? existing.last_purchase_at ?? null,
      region: synchronized.region || existing.region || "",
      city: synchronized.city || existing.city || "",
      address: synchronized.address || existing.address || "",
      location_source:
        synchronized.location_source || existing.location_source || "",
      location_verified_at:
        synchronized.location_verified_at ??
        existing.location_verified_at ??
        null,
      lifecycle: synchronized.lifecycle ?? existing.lifecycle,
      contactable: Boolean(
        existing.contactable ||
          synchronized.contactable ||
          existing.email ||
          existing.phone ||
          existing.whatsapp ||
          synchronized.email ||
          synchronized.phone ||
          synchronized.whatsapp,
      ),
    };
  }

  const sourceCounts: Record<string, number> = {};
  const lifecycleCounts: Record<string, number> = {};
  const factoRanking: CommercialRanking[] = [];
  const tiendanubeRanking: CommercialRanking[] = [];
  let contactable = 0;
  let factoNetSales = 0;
  let crmCompanies = 0;

  for (const customer of customers) {
    const channel = customer.source_channel ?? "crm_only";
    sourceCounts[channel] = (sourceCounts[channel] ?? 0) + 1;
    const lifecycle = customer.lifecycle ?? "no_purchase";
    lifecycleCounts[lifecycle] = (lifecycleCounts[lifecycle] ?? 0) + 1;
    if (
      customer.contactable ||
      customer.email ||
      customer.phone ||
      customer.whatsapp
    ) {
      contactable += 1;
    }
    if (customer.crm_company_id) crmCompanies += 1;
    if (customer.sources?.includes("facto")) {
      const netSales = Number(customer.facto_net_sales ?? 0);
      factoNetSales += netSales;
      factoRanking.push({
        ...customer,
        documents: Number(customer.facto_documents ?? 0),
        net_sales: netSales,
      });
    }
    if (customer.sources?.includes("tiendanube")) {
      const grossSales = Number(customer.tiendanube_gross_sales ?? 0);
      tiendanubeRanking.push({
        ...customer,
        documents: Number(customer.tiendanube_orders ?? 0),
        gross_sales: grossSales,
        net_sales: grossSales / CHILE_VAT_FACTOR,
      });
    }
  }

  factoRanking.sort((left, right) => Number(right.net_sales ?? 0) - Number(left.net_sales ?? 0));
  tiendanubeRanking.sort(
    (left, right) => Number(right.net_sales ?? 0) - Number(left.net_sales ?? 0),
  );

  return {
    ...base,
    customers,
    metrics: {
      ...base.metrics,
      customers: customers.length,
      contactable,
      facto_net_sales: factoNetSales,
      facto_customers: factoRanking.length,
      tiendanube_customers: tiendanubeRanking.length,
      crm_companies: crmCompanies,
      omnichannel_customers: sourceCounts.both ?? 0,
      campaign_ready: customers.filter(
        (customer) =>
          customer.email_ready ||
          customer.whatsapp_ready ||
          customer.email ||
          customer.whatsapp,
      ).length,
      email_ready: customers.filter(
        (customer) => customer.email_ready || customer.email,
      ).length,
      whatsapp_ready: customers.filter(
        (customer) => customer.whatsapp_ready || customer.whatsapp,
      ).length,
    },
    source_counts: sourceCounts,
    lifecycle_counts: lifecycleCounts,
    facto_ranking: factoRanking,
    tiendanube_ranking: tiendanubeRanking,
    sales_products:
      base.sales_products?.length ? base.sales_products : synchronizedProducts,
  };
}

function CommercialDashboard({
  tasks,
  synchronizedCustomers,
  synchronizedProducts,
}: {
  tasks: AgentTask[];
  synchronizedCustomers: CommercialCustomer[];
  synchronizedProducts: CommercialSalesProduct[];
}) {
  const { companies, createCompanies } = useCompanyStore();
  const taskReport = commercialReportFromTasks(tasks);
  const report = useMemo(
    () =>
      mergeCommercialPortfolio(
        taskReport,
        synchronizedCustomers,
        synchronizedProducts,
      ),
    [synchronizedCustomers, synchronizedProducts, taskReport],
  );
  const [query, setQuery] = useState("");
  const [source, setSource] = useState("all");
  const [lifecycle, setLifecycle] = useState("all");
  const [companyType, setCompanyType] = useState("all");
  const [region, setRegion] = useState("all");
  const [valueTier, setValueTier] = useState("all");
  const [recommendedAction, setRecommendedAction] = useState("all");
  const [sort, setSort] = useState("score_desc");
  const [rankingChannel, setRankingChannel] = useState<"facto" | "tiendanube">("facto");
  const [rankingQuery, setRankingQuery] = useState("");
  const [rankingSort, setRankingSort] = useState("amount_desc");
  const [importNotice, setImportNotice] = useState("");
  const [importBusy, setImportBusy] = useState(false);

  const companyTypes = useMemo(
    () =>
      Array.from(
        new Set(
          (report?.customers ?? [])
            .map((customer) => customer.crm_type)
            .filter((value): value is string => Boolean(value)),
        ),
      ).sort((left, right) => left.localeCompare(right, "es-CL")),
    [report?.customers],
  );
  const regions = useMemo(
    () =>
      Array.from(
        new Set(
          (report?.customers ?? [])
            .map((customer) => customer.region)
            .filter((value): value is string => Boolean(value)),
        ),
      ).sort((left, right) => left.localeCompare(right, "es-CL")),
    [report?.customers],
  );
  const commercialActions = useMemo(
    () =>
      Array.from(
        new Set(
          (report?.customers ?? [])
            .map((customer) => customer.recommended_action)
            .filter((value): value is string => Boolean(value)),
        ),
      ).sort((left, right) =>
        (commercialActionLabels[left] ?? left).localeCompare(
          commercialActionLabels[right] ?? right,
          "es-CL",
        ),
      ),
    [report?.customers],
  );
  const filteredCustomers = useMemo(() => {
    const normalizedQuery = normalizeCustomerSearch(query);
    return (report?.customers ?? [])
      .filter((customer) => {
        if (source !== "all" && customer.source_channel !== source) return false;
        if (lifecycle !== "all" && customer.lifecycle !== lifecycle) return false;
        if (companyType !== "all" && customer.crm_type !== companyType) return false;
        if (region !== "all" && customer.region !== region) return false;
        if (valueTier !== "all" && customer.value_tier !== valueTier) return false;
        if (
          recommendedAction !== "all" &&
          customer.recommended_action !== recommendedAction
        ) {
          return false;
        }
        if (!normalizedQuery) return true;
        return [
          customer.name,
          customer.legal_name,
          customer.tax_id,
          customer.email,
          customer.phone,
          customer.whatsapp,
          customer.city,
        ].some((value) => normalizeCustomerSearch(value).includes(normalizedQuery));
      })
      .sort((left, right) => {
        if (sort === "score_desc") {
          return Number(right.commercial_score ?? 0) - Number(left.commercial_score ?? 0);
        }
        if (sort === "orders_desc") {
          return (
            Number(right.facto_documents ?? 0) +
            Number(right.tiendanube_orders ?? 0) -
            Number(left.facto_documents ?? 0) -
            Number(left.tiendanube_orders ?? 0)
          );
        }
        if (sort === "recent_desc") {
          return String(right.last_purchase_at ?? "").localeCompare(
            String(left.last_purchase_at ?? ""),
          );
        }
        if (sort === "name_asc") {
          return (left.name ?? left.legal_name ?? "").localeCompare(
            right.name ?? right.legal_name ?? "",
            "es-CL",
          );
        }
        return Number(right.commercial_value ?? right.facto_net_sales ?? 0) -
          Number(left.commercial_value ?? left.facto_net_sales ?? 0);
      });
  }, [
    companyType,
    lifecycle,
    query,
    recommendedAction,
    region,
    report?.customers,
    sort,
    source,
    valueTier,
  ]);
  const factoRanking = useMemo<CommercialRanking[]>(() => {
    if (report?.facto_ranking?.length) return report.facto_ranking;
    return (report?.customers ?? [])
      .filter((customer) => customer.sources?.includes("facto"))
      .map((customer) => ({
        ...customer,
        documents: customer.facto_documents,
        net_sales: customer.facto_net_sales,
      }))
      .sort((left, right) => Number(right.net_sales ?? 0) - Number(left.net_sales ?? 0));
  }, [report]);
  const tiendanubeRanking = useMemo<CommercialRanking[]>(() => {
    if (report?.tiendanube_ranking?.length) return report.tiendanube_ranking;
    return (report?.customers ?? [])
      .filter((customer) => customer.sources?.includes("tiendanube"))
      .map((customer) => ({
        ...customer,
        documents: customer.tiendanube_orders,
        gross_sales: customer.tiendanube_gross_sales,
        net_sales: Number(customer.tiendanube_gross_sales ?? 0) / CHILE_VAT_FACTOR,
      }))
      .sort((left, right) => Number(right.net_sales ?? 0) - Number(left.net_sales ?? 0));
  }, [report]);
  const filteredRanking = useMemo(() => {
    const normalizedQuery = normalizeCustomerSearch(rankingQuery);
    const rows = rankingChannel === "facto" ? factoRanking : tiendanubeRanking;
    return rows
      .filter((customer) => {
        if (!normalizedQuery) return true;
        return [
          customer.name,
          customer.legal_name,
          customer.tax_id,
          customer.email,
          customer.phone,
          customer.whatsapp,
        ].some((value) => normalizeCustomerSearch(value).includes(normalizedQuery));
      })
      .sort((left, right) => {
        if (rankingSort === "amount_asc") {
          return Number(left.net_sales ?? 0) - Number(right.net_sales ?? 0);
        }
        if (rankingSort === "documents_desc") {
          return Number(right.documents ?? 0) - Number(left.documents ?? 0);
        }
        if (rankingSort === "name_asc") {
          return (left.name ?? left.legal_name ?? "").localeCompare(
            right.name ?? right.legal_name ?? "",
            "es-CL",
          );
        }
        return Number(right.net_sales ?? 0) - Number(left.net_sales ?? 0);
      });
  }, [factoRanking, rankingChannel, rankingQuery, rankingSort, tiendanubeRanking]);
  const importableRanking = useMemo(
    () =>
      filteredRanking.filter(
        (customer) => customerImportKey(customer) && !findMatchingCompany(customer, companies),
      ),
    [companies, filteredRanking],
  );

  async function importCustomers(customersToImport: CommercialCustomer[]) {
    const unique = new Map<string, CommercialCustomer>();
    for (const customer of customersToImport) {
      const key = customerImportKey(customer);
      if (!key || findMatchingCompany(customer, companies) || unique.has(key)) continue;
      unique.set(key, customer);
    }
    const candidates = [...unique.values()];
    if (!candidates.length) {
      setImportNotice("No hay clientes nuevos con RUT, email o teléfono verificable para importar.");
      return;
    }
    if (
      candidates.length > 1 &&
      !window.confirm(
        `Se agregarán ${candidates.length} clientes a Empresas. No se crearán campañas ni mensajes. ¿Continuar?`,
      )
    ) {
      return;
    }
    setImportBusy(true);
    setImportNotice("");
    try {
      await createCompanies(candidates.map(companyDraftFromCustomer));
      setImportNotice(
        `${candidates.length} ${
          candidates.length === 1 ? "cliente fue agregado" : "clientes fueron agregados"
        } a Empresas sin duplicar identidades exactas.`,
      );
    } catch (error) {
      setImportNotice(
        error instanceof Error ? error.message : "No se pudieron importar los clientes.",
      );
    } finally {
      setImportBusy(false);
    }
  }

  if (!report) {
    return (
      <section className="data-card agent-dashboard-summary">
        <span className="eyebrow">CARTERA COMERCIAL</span>
        <h2>El análisis todavía está en preparación</h2>
        <p>
          Solicita el análisis desde el Centro de agentes cuando termine la sincronización de
          Facto y Tiendanube.
        </p>
      </section>
    );
  }

  const months = report.acquisition_by_month ?? [];
  const maxMonthlyCustomers = Math.max(
    1,
    ...months.map((item) => item.new_customers + item.returning_customers),
  );
  const sourceSlices: DonutSlice[] = [
    { label: "Sólo Facto", value: report.source_counts.facto_only ?? 0, color: "#07869a" },
    {
      label: "Sólo Climactiva.cl",
      value: report.source_counts.tiendanube_only ?? 0,
      color: "#6b63c7",
    },
    { label: "Ambos canales", value: report.source_counts.both ?? 0, color: "#2eb28c" },
    { label: "Sólo CRM", value: report.source_counts.crm_only ?? 0, color: "#e39a27" },
  ];
  const lifecycleSlices: DonutSlice[] = [
    { label: "Activos", value: report.lifecycle_counts.active ?? 0, color: "#07869a" },
    { label: "Nuevos", value: report.lifecycle_counts.new ?? 0, color: "#2eb28c" },
    { label: "En riesgo", value: report.lifecycle_counts.at_risk ?? 0, color: "#e39a27" },
    { label: "Inactivos", value: report.lifecycle_counts.dormant ?? 0, color: "#c86b35" },
    {
      label: "Sin compra",
      value: report.lifecycle_counts.no_purchase ?? 0,
      color: "#b9c9cc",
    },
  ];
  const topOpportunities = (
    report.top_opportunities ??
    [...report.customers].sort(
      (left, right) =>
        Number(right.commercial_score ?? 0) - Number(left.commercial_score ?? 0),
    )
  ).slice(0, 12);

  return (
    <>
      <section className="agent-dashboard-kpis commercial-kpis">
        <article>
          <Database size={22} />
          <span>Clientes unificados</span>
          <strong>{formatNumber.format(report.metrics.customers)}</strong>
          <small>Facto + Climactiva.cl + CRM</small>
        </article>
        <article>
          <CheckCircle2 size={22} />
          <span>Clientes activos</span>
          <strong>{formatNumber.format(report.metrics.active_customers ?? 0)}</strong>
          <small>Compraron recientemente</small>
        </article>
        <article className="commercial-kpi-alert">
          <AlertTriangle size={22} />
          <span>Requieren recuperación</span>
          <strong>{formatNumber.format(report.metrics.customers_at_risk ?? 0)}</strong>
          <small>Clientes en riesgo o inactivos</small>
        </article>
        <article>
          <TrendingUp size={22} />
          <span>Clientes omnicanal</span>
          <strong>{formatNumber.format(report.metrics.omnichannel_customers ?? 0)}</strong>
          <small>Compran en Facto y Climactiva.cl</small>
        </article>
        <article>
          <CheckCircle2 size={22} />
          <span>Listos para campañas</span>
          <strong>{formatNumber.format(report.metrics.campaign_ready ?? 0)}</strong>
          <small>
            {formatNumber.format(report.metrics.email_ready ?? 0)} email ·{" "}
            {formatNumber.format(report.metrics.whatsapp_ready ?? 0)} WhatsApp
          </small>
        </article>
        <article>
          <CircleDollarSign size={22} />
          <span>Venta neta Facto</span>
          <strong>{formatCurrency.format(report.metrics.facto_net_sales)}</strong>
          <small>Fuente financiera única; sin duplicar Tiendanube</small>
        </article>
      </section>

      <section className="logistics-donut-grid commercial-donut-grid">
        <DonutChart
          centerLabel="clientes"
          centerValue={formatNumber.format(report.metrics.customers)}
          slices={sourceSlices}
          subtitle="Diferencia clientes contables, compradores web y empresas del CRM."
          title="Origen de la cartera"
        />
        <DonutChart
          centerLabel="clientes"
          centerValue={formatNumber.format(report.metrics.customers)}
          slices={lifecycleSlices}
          subtitle="Recencia real basada en la última compra disponible."
          title="Ciclo comercial"
        />
        <article className="data-card commercial-acquisition-card">
          <div className="section-title">
            <div>
              <h2>Adquisición y recurrencia</h2>
              <p>Clientes nuevos y compradores que regresaron por mes.</p>
            </div>
          </div>
          <div className="commercial-acquisition-bars">
            {months.map((item) => (
              <article key={item.month}>
                <div>
                  <span
                    className="returning"
                    style={{
                      height: `${Math.max(
                        item.returning_customers ? 4 : 0,
                        (item.returning_customers / maxMonthlyCustomers) * 100,
                      )}%`,
                    }}
                    title={`${item.returning_customers} recurrentes`}
                  />
                  <span
                    className="new"
                    style={{
                      height: `${Math.max(
                        item.new_customers ? 4 : 0,
                        (item.new_customers / maxMonthlyCustomers) * 100,
                      )}%`,
                    }}
                    title={`${item.new_customers} nuevos`}
                  />
                </div>
                <strong>{monthLabel(item.month)}</strong>
              </article>
            ))}
          </div>
          <div className="commercial-chart-legend">
            <span><i className="new" /> Nuevos</span>
            <span><i className="returning" /> Recurrentes</span>
          </div>
        </article>
      </section>

      <section className="data-card commercial-opportunities">
        <div className="section-title">
          <div>
            <span className="eyebrow">PRIORIDAD DIARIA</span>
            <h2>Oportunidades comerciales recomendadas</h2>
            <p>
              Ordenadas por valor, recencia, frecuencia, origen y disponibilidad de contacto.
            </p>
          </div>
          <strong className="commercial-priority-summary">
            {formatNumber.format(report.opportunity_counts?.urgent ?? 0)} urgentes ·{" "}
            {formatNumber.format(report.opportunity_counts?.high ?? 0)} altas
          </strong>
        </div>
        <div className="commercial-opportunity-list">
          {topOpportunities.map((customer) => {
            const customerName = customer.name || customer.legal_name || "Cliente sin nombre";
            const action =
              customer.recommended_action_label ||
              commercialActionLabels[customer.recommended_action ?? ""] ||
              "Realizar seguimiento";
            return (
              <article
                className={`priority-${customer.opportunity_priority ?? "normal"}`}
                key={`opportunity-${customer.customer_key}`}
              >
                <div className="commercial-score">
                  <strong>{formatNumber.format(customer.commercial_score ?? 0)}</strong>
                  <span>puntos</span>
                  <b>Tier {customer.value_tier ?? "D"}</b>
                </div>
                <div className="commercial-opportunity-identity">
                  {customer.crm_company_id ? (
                    <Link to={`/empresas/${customer.crm_company_id}`}>{customerName}</Link>
                  ) : (
                    <strong>{customerName}</strong>
                  )}
                  <span>{customer.tax_id || "RUT pendiente"}</span>
                  <small>
                    {commercialSourceLabels[customer.source_channel ?? ""] ??
                      customer.source_channel ??
                      "Origen pendiente"}
                  </small>
                </div>
                <div className="commercial-opportunity-action">
                  <span>
                    {commercialPriorityLabels[customer.opportunity_priority ?? "normal"] ??
                      "Normal"}
                  </span>
                  <strong>{action}</strong>
                  <small>
                    {customer.email_ready ? "Email" : ""}
                    {customer.email_ready && customer.whatsapp_ready ? " · " : ""}
                    {customer.whatsapp_ready ? "WhatsApp" : ""}
                    {!customer.email_ready && !customer.whatsapp_ready
                      ? "Completar contacto"
                      : ""}
                  </small>
                </div>
                <div className="commercial-opportunity-value">
                  <span>Valor observado</span>
                  <strong>
                    {formatCurrency.format(
                      Number(customer.commercial_value ?? customer.facto_net_sales ?? 0),
                    )}
                  </strong>
                  <small>
                    {formatNumber.format(customer.purchase_events ?? 0)} compras · ticket{" "}
                    {formatCurrency.format(Number(customer.average_net_ticket ?? 0))}
                  </small>
                </div>
              </article>
            );
          })}
          {!topOpportunities.length ? (
            <p>No hay oportunidades priorizadas con la información disponible.</p>
          ) : null}
        </div>
      </section>

      <section className="commercial-channel-grid">
        <article className="data-card commercial-channel-ranking">
          <div className="section-title">
            <div>
              <span className="eyebrow">CARTERA POR ORIGEN</span>
              <h2>Ranking de clientes</h2>
              <p>
                Facto conserva la venta neta contable; Climactiva.cl muestra el canal web
                sin mezclar ambos montos.
              </p>
            </div>
            <strong className="finance-customer-count">
              {filteredRanking.length} clientes
            </strong>
          </div>
          <div className="commercial-channel-tabs" role="group" aria-label="Origen del ranking">
            <button
              className={rankingChannel === "facto" ? "active" : ""}
              onClick={() => setRankingChannel("facto")}
              type="button"
            >
              Facto ({factoRanking.length})
            </button>
            <button
              className={rankingChannel === "tiendanube" ? "active" : ""}
              onClick={() => setRankingChannel("tiendanube")}
              type="button"
            >
              Climactiva.cl ({tiendanubeRanking.length})
            </button>
          </div>
          <div className="finance-customer-tools commercial-ranking-tools">
            <label className="finance-customer-search">
              <Search aria-hidden="true" size={18} />
              <span className="sr-only">Buscar cliente del canal</span>
              <input
                onChange={(event) => setRankingQuery(event.target.value)}
                placeholder="RUT, razón social, email o teléfono"
                type="search"
                value={rankingQuery}
              />
            </label>
            <label>
              <span className="sr-only">Ordenar ranking</span>
              <select
                onChange={(event) => setRankingSort(event.target.value)}
                value={rankingSort}
              >
                <option value="amount_desc">Mayor monto neto</option>
                <option value="amount_asc">Menor monto neto</option>
                <option value="documents_desc">Más compras</option>
                <option value="name_asc">Razón social A-Z</option>
              </select>
            </label>
          </div>
          <div className="commercial-import-toolbar">
            <div>
              <Building2 size={18} />
              <span>
                {importableRanking.length} identificados aún no están en Empresas
              </span>
            </div>
            <button
              className="primary-button"
              disabled={importBusy || !importableRanking.length}
              onClick={() => void importCustomers(importableRanking)}
              type="button"
            >
              <UserPlus size={17} />
              {importBusy ? "Importando…" : "Agregar visibles a Empresas"}
            </button>
          </div>
          {importNotice ? (
            <div
              className={
                importNotice.startsWith("No ") || importNotice.startsWith("No se")
                  ? "notice-banner warning"
                  : "notice-banner success"
              }
            >
              {importNotice}
            </div>
          ) : null}
          <div className="commercial-ranking-list">
            {filteredRanking.map((customer) => {
              const existing = findMatchingCompany(customer, companies);
              const canImport = Boolean(customerImportKey(customer));
              return (
                <article key={`${rankingChannel}-${customer.customer_key}`}>
                  <div className="commercial-ranking-identity">
                    <strong>{customer.name || customer.legal_name || "Cliente sin nombre"}</strong>
                    <span>{customer.tax_id || "RUT no informado"}</span>
                    <small>
                      {customer.email || customer.whatsapp || customer.phone || "Contacto pendiente"}
                    </small>
                  </div>
                  <div className="commercial-ranking-amount">
                    <strong>{formatCurrency.format(Number(customer.net_sales ?? 0))}</strong>
                    <span>
                      {customer.documents ?? 0}{" "}
                      {rankingChannel === "facto" ? "documentos" : "pedidos"}
                    </span>
                    {rankingChannel === "tiendanube" ? (
                      <small>Monto neto estimado sin IVA</small>
                    ) : (
                      <small>Venta neta Facto</small>
                    )}
                  </div>
                  <div className="commercial-ranking-action">
                    {existing ? (
                      <Link className="ghost-button" to={`/empresas/${existing.id}`}>
                        Ver en Empresas
                      </Link>
                    ) : (
                      <button
                        className="ghost-button"
                        disabled={importBusy || !canImport}
                        onClick={() => void importCustomers([customer])}
                        title={
                          canImport
                            ? "Agregar cliente a Empresas"
                            : "Se necesita RUT, email o teléfono para evitar duplicados"
                        }
                        type="button"
                      >
                        <UserPlus size={16} />
                        {canImport ? "Agregar a Empresas" : "Falta identidad"}
                      </button>
                    )}
                  </div>
                </article>
              );
            })}
            {!filteredRanking.length ? (
              <div className="finance-customer-empty">
                <Search size={22} />
                <strong>Sin clientes para este filtro</strong>
                <span>Prueba con otro RUT, nombre, email o teléfono.</span>
              </div>
            ) : null}
          </div>
          <p className="finance-year-note">
            La importación es manual y transaccional. No crea destinatarios ni envía
            campañas; primero deja el cliente disponible en Empresas para revisión.
          </p>
        </article>

        <article className="data-card commercial-sales-products">
          <div className="section-title">
            <div>
              <span className="eyebrow">DEMANDA COMERCIAL</span>
              <h2>Productos que generan ventas</h2>
              <p>Unidades y venta neta por SKU observadas en los documentos de Facto.</p>
            </div>
          </div>
          <div className="stock-bars product-ranking-list commercial-products-scroll">
            {(report.sales_products ?? []).map((item, index) => {
              const maximum = Math.max(
                ...(report.sales_products ?? []).map((product) =>
                  Number(product.net_sales ?? product.units ?? 0),
                ),
                1,
              );
              const observedValue = Number(item.net_sales ?? item.units ?? 0);
              return (
                <article key={`${item.sku || item.name}-${index}`}>
                  <div>
                    <strong title={item.name}>{item.name || item.sku || "Producto sin nombre"}</strong>
                    <span>
                      {Number(item.net_sales ?? 0) > 0
                        ? formatCurrency.format(Number(item.net_sales))
                        : `${formatNumber.format(Number(item.units ?? 0))} un.`}
                    </span>
                  </div>
                  <small>
                    {formatNumber.format(Number(item.units ?? 0))} unidades · SKU{" "}
                    {item.sku || "sin dato"}
                  </small>
                  <div className="stock-bar-track">
                    <span
                      style={{
                        width: `${Math.max(3, (observedValue / maximum) * 100)}%`,
                      }}
                    />
                  </div>
                </article>
              );
            })}
            {!report.sales_products?.length ? (
              <p>
                Solicita un nuevo análisis comercial para incorporar el historial de
                productos vendidos.
              </p>
            ) : null}
          </div>
        </article>
      </section>

      <section className="data-card">
        <div className="section-title">
          <div>
            <span className="eyebrow">CAMPAÑAS DIRIGIDAS</span>
            <h2>Segmentos sugeridos para revisión</h2>
            <p>Nunca se envían mensajes automáticamente; la selección pasa por Campañas.</p>
          </div>
          <Link
            className="ghost-button agent-dashboard-link"
            to="/campanas?view=suggestions&source=commercial-agent"
          >
            Ir a Campañas sugeridas
          </Link>
        </div>
        <div className="commercial-segment-grid">
          {report.segments.map((segment) => (
            <article
              className={`priority-${segment.priority ?? "normal"}`}
              key={segment.id}
            >
              <div className="commercial-segment-heading">
                <span>{segment.channel}</span>
                <b>{commercialPriorityLabels[segment.priority ?? "normal"] ?? "Normal"}</b>
              </div>
              <strong>{segment.name}</strong>
              <em>{formatNumber.format(segment.count)} clientes</em>
              <p>{segment.reason}</p>
              <div className="commercial-segment-channels">
                <span>{formatNumber.format(segment.email_count ?? 0)} con email</span>
                <span>{formatNumber.format(segment.whatsapp_count ?? 0)} con WhatsApp</span>
              </div>
              <Link
                className="agent-dashboard-link"
                to={`/campanas?view=suggestions&source=commercial-agent&segment=${encodeURIComponent(segment.id)}`}
              >
                Revisar y preparar campaña
              </Link>
            </article>
          ))}
          {!report.segments.length ? <p>No hay segmentos contactables con las reglas actuales.</p> : null}
        </div>
      </section>

      <section className="data-card commercial-portfolio">
        <div className="section-title">
          <div>
            <span className="eyebrow">CARTERA UNIFICADA</span>
            <h2>Clientes de Facto, Climactiva.cl y CRM</h2>
            <p>Busca por razón social, RUT, email o teléfono y combina filtros trazables.</p>
          </div>
          <strong className="finance-customer-count">
            {formatNumber.format(filteredCustomers.length)} de{" "}
            {formatNumber.format(report.customers.length)} clientes
          </strong>
        </div>
        <div className="commercial-portfolio-tools">
          <label>
            <Search size={18} />
            <input
              aria-label="Buscar cliente comercial"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Razón social, RUT, email o teléfono"
              value={query}
            />
          </label>
          <select aria-label="Filtrar por fuente" onChange={(event) => setSource(event.target.value)} value={source}>
            <option value="all">Todas las fuentes</option>
            {Object.entries(commercialSourceLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <select aria-label="Filtrar por ciclo" onChange={(event) => setLifecycle(event.target.value)} value={lifecycle}>
            <option value="all">Todos los ciclos</option>
            {Object.entries(commercialLifecycleLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <select aria-label="Filtrar por tipo" onChange={(event) => setCompanyType(event.target.value)} value={companyType}>
            <option value="all">Todos los tipos</option>
            {companyTypes.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
          <select aria-label="Filtrar por región" onChange={(event) => setRegion(event.target.value)} value={region}>
            <option value="all">Todas las regiones</option>
            {regions.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
          <select aria-label="Filtrar por valor" onChange={(event) => setValueTier(event.target.value)} value={valueTier}>
            <option value="all">Todos los niveles</option>
            <option value="A">Tier A · estratégico</option>
            <option value="B">Tier B · alto valor</option>
            <option value="C">Tier C · desarrollo</option>
            <option value="D">Tier D · calificación</option>
          </select>
          <select
            aria-label="Filtrar por acción sugerida"
            onChange={(event) => setRecommendedAction(event.target.value)}
            value={recommendedAction}
          >
            <option value="all">Todas las acciones</option>
            {commercialActions.map((value) => (
              <option key={value} value={value}>
                {commercialActionLabels[value] ?? value}
              </option>
            ))}
          </select>
          <select aria-label="Ordenar cartera" onChange={(event) => setSort(event.target.value)} value={sort}>
            <option value="score_desc">Mayor prioridad comercial</option>
            <option value="sales_desc">Mayor venta Facto</option>
            <option value="orders_desc">Mayor frecuencia</option>
            <option value="recent_desc">Compra más reciente</option>
            <option value="name_asc">Nombre A-Z</option>
          </select>
        </div>

        <div className="commercial-customer-list">
          {filteredCustomers.map((customer) => {
            const customerName = customer.name || customer.legal_name || "Cliente sin nombre";
            const contact = customer.email || customer.whatsapp || customer.phone || "Sin contacto";
            return (
              <article key={customer.customer_key}>
                <div className="commercial-customer-name">
                  {customer.crm_company_id ? (
                    <Link to={`/empresas/${customer.crm_company_id}`}>{customerName}</Link>
                  ) : (
                    <strong>{customerName}</strong>
                  )}
                  <span>{customer.tax_id || "RUT no identificado"}</span>
                  <small>{contact}</small>
                </div>
                <div>
                  <span>Prioridad comercial</span>
                  <strong>
                    {formatNumber.format(customer.commercial_score ?? 0)} puntos · Tier{" "}
                    {customer.value_tier ?? "D"}
                  </strong>
                  <small>
                    {customer.recommended_action_label ||
                      commercialActionLabels[customer.recommended_action ?? ""] ||
                      "Realizar seguimiento"}
                  </small>
                </div>
                <div>
                  <span>Origen y canales</span>
                  <strong>{commercialSourceLabels[customer.source_channel ?? ""] ?? customer.source_channel ?? "Sin fuente"}</strong>
                  <small>
                    {customer.email_ready ? "Email" : ""}
                    {customer.email_ready && customer.whatsapp_ready ? " · " : ""}
                    {customer.whatsapp_ready ? "WhatsApp" : ""}
                    {!customer.email_ready && !customer.whatsapp_ready
                      ? (customer.sources ?? []).join(" · ") || "Sin canal directo"
                      : ""}
                  </small>
                </div>
                <div>
                  <span>Perfil y actividad</span>
                  <strong>
                    {customer.crm_type || "Sin clasificar"} ·{" "}
                    {commercialLifecycleLabels[customer.lifecycle ?? ""] ??
                      customer.lifecycle ??
                      "Sin dato"}
                  </strong>
                  <small>
                    {[customer.region, customer.city].filter(Boolean).join(" · ") ||
                      "Territorio pendiente"}
                    {" · "}
                    {customer.last_purchase_at
                      ? `última: ${financialDateLabel(customer.last_purchase_at)}`
                      : "sin compra vinculada"}
                  </small>
                  {customer.address ? (
                    <small title={`Ubicación respaldada por ${customer.location_source ?? "fuente comercial"}`}>
                      {customer.address}
                    </small>
                  ) : null}
                </div>
                <div>
                  <span>Valor y preferencia</span>
                  <strong>
                    {formatCurrency.format(
                      Number(customer.commercial_value ?? customer.facto_net_sales ?? 0),
                    )}
                  </strong>
                  <small>
                    {formatNumber.format(customer.purchase_events ?? 0)} compras ·{" "}
                    {customer.product_families?.[0]?.name ||
                      customer.top_products?.[0]?.name ||
                      "Interés por identificar"}
                  </small>
                </div>
              </article>
            );
          })}
          {!filteredCustomers.length ? <p>No hay clientes que coincidan con estos filtros.</p> : null}
        </div>
        <p className="finance-year-note commercial-methodology">{report.methodology}</p>
      </section>
    </>
  );
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

const SII_F29_2026_CUT = {
  source: "Carpeta Tributaria SII · generada el 31-07-2026",
  generated_at: "2026-07-31T20:52:00-04:00",
  period_start: "2026-01",
  period_end: "2026-06",
  f29_taxable_sales: 89_214_222,
  f29_debit_vat: 16_950_702,
  f29_domestic_credit_vat: 1_343_921,
  f29_import_credit_vat: 18_207_512,
  f29_determined_vat: 3_820_703,
  f29_ppm: 111_517,
  import_customs_base_reference: 95_829_011,
  prior_year_taxable_base: 29_215_370,
  prior_year_business_income: 162_997_601,
};

function signedPost(row: AccountingPrebalanceRow, side: "debit" | "credit", rawAmount: number) {
  const amount = Number(rawAmount ?? 0);
  if (!amount) return;
  if (amount > 0) row[side === "debit" ? "sum_debit" : "sum_credit"] += amount;
  else row[side === "debit" ? "sum_credit" : "sum_debit"] += Math.abs(amount);
}

function reconcileAccountingSnapshot(
  sourceSnapshot: AccountingSnapshot,
  financial: FinancialReport | null,
  inventory: Snapshot[],
): AccountingSnapshot {
  const snapshot = structuredClone(sourceSnapshot);
  const rows = snapshot.prebalance_rows ?? [];
  const findOrCreate = (accountCode: string, accountName: string, nature: string) => {
    let row = rows.find((candidate) => candidate.account_code === accountCode);
    if (!row) {
      row = {
        account_code: accountCode,
        account_name: accountName,
        nature,
        sum_debit: 0,
        sum_credit: 0,
        balance_debtor: 0,
        balance_creditor: 0,
        inventory_asset: 0,
        inventory_liability: 0,
        result_loss: 0,
        result_gain: 0,
      };
      rows.push(row);
    }
    return row;
  };

  const fiscalPrefix = `${snapshot.fiscal_year}-`;
  const cutoffMonth = snapshot.period_end.slice(0, 7);
  const salesMonths = (financial?.sales_by_month ?? []).filter(
    (month) => month.month.startsWith(fiscalPrefix) && month.month <= cutoffMonth,
  );
  const purchaseMonths = (financial?.purchases_by_month ?? []).filter(
    (month) => month.month.startsWith(fiscalPrefix) && month.month <= cutoffMonth,
  );
  const netSales = salesMonths.reduce((sum, month) => sum + Number(month.net_sales ?? 0), 0);
  const salesTax = salesMonths.reduce((sum, month) => sum + Number(month.tax ?? 0), 0);
  const grossSales = salesMonths.reduce((sum, month) => sum + Number(month.gross_sales ?? 0), 0);
  const salesDocuments = salesMonths.reduce((sum, month) => sum + Number(month.documents ?? 0), 0);
  const netPurchases = purchaseMonths.reduce((sum, month) => sum + Number(month.net_purchases ?? 0), 0);
  const purchaseTax = purchaseMonths.reduce((sum, month) => sum + Number(month.tax ?? 0), 0);
  const reportedGrossPurchases = purchaseMonths.reduce((sum, month) => sum + Number(month.gross_purchases ?? 0), 0);
  const grossPurchases = reportedGrossPurchases || netPurchases + purchaseTax;
  const purchaseDocuments = purchaseMonths.reduce((sum, month) => sum + Number(month.documents ?? 0), 0);
  const hasFacto = Boolean(financial && (salesMonths.length || purchaseMonths.length));

  if (hasFacto) {
    signedPost(findOrCreate("110200", "Clientes Facto (pendientes de conciliacion de pagos)", "Activo"), "debit", grossSales);
    signedPost(findOrCreate("410100", "Ingresos por ventas documentadas", "Ganancia"), "credit", netSales);
    signedPost(findOrCreate("210110", "IVA debito fiscal documentado", "Pasivo"), "credit", salesTax);
    signedPost(findOrCreate("510100", "Compras documentadas (pendientes de ajuste por inventario)", "Perdida"), "debit", netPurchases);
    signedPost(findOrCreate("110510", "IVA credito fiscal documentado", "Activo"), "debit", purchaseTax);
    signedPost(findOrCreate("210100", "Proveedores Facto (pendientes de conciliacion de pagos)", "Pasivo"), "credit", grossPurchases);
  }

  rows.forEach((row) => {
    row.balance_debtor = Math.max(Number(row.sum_debit ?? 0) - Number(row.sum_credit ?? 0), 0);
    row.balance_creditor = Math.max(Number(row.sum_credit ?? 0) - Number(row.sum_debit ?? 0), 0);
    row.inventory_asset = row.nature === "Activo" ? row.balance_debtor : 0;
    row.inventory_liability = row.nature === "Pasivo" ? row.balance_creditor : 0;
    row.result_loss = row.nature === "Perdida" ? row.balance_debtor : 0;
    row.result_gain = row.nature === "Ganancia" ? row.balance_creditor : 0;
  });
  rows.sort((a, b) => a.account_code.localeCompare(b.account_code));

  const totals = rows.reduce(
    (result, row) => ({
      debit: result.debit + row.sum_debit,
      credit: result.credit + row.sum_credit,
      asset: result.asset + row.inventory_asset,
      liability: result.liability + row.inventory_liability,
      loss: result.loss + row.result_loss,
      gain: result.gain + row.result_gain,
    }),
    { debit: 0, credit: 0, asset: 0, liability: 0, loss: 0, gain: 0 },
  );
  const inventoryCost = inventory.reduce(
    (sum, item) => sum + Math.max(0, Number(item.available_units ?? 0)) * Math.max(0, Number(item.unit_cost_source ?? 0)),
    0,
  );
  const inventoryNetSaleValue = inventory.reduce(
    (sum, item) => sum + Math.max(0, Number(item.available_units ?? 0)) * Math.max(0, netUnitPrice(item)),
    0,
  );
  const f29FactoSales = salesMonths
    .filter((month) => month.month <= SII_F29_2026_CUT.period_end)
    .reduce((sum, month) => sum + Number(month.net_sales ?? 0), 0);
  const documentaryResult = netSales - netPurchases - Number(snapshot.payroll_summary?.total_employer_cost ?? 0);

  snapshot.prebalance_rows = rows;
  snapshot.controls = {
    ...(snapshot.controls ?? {}),
    journal_debit: totals.debit,
    journal_credit: totals.credit,
    journal_balanced: Math.abs(totals.debit - totals.credit) < 1,
    balance_sheet_balanced: Math.abs(totals.asset + totals.loss - totals.liability - totals.gain) < 1,
    facto_net_sales: netSales,
    facto_net_purchases: netPurchases,
    facto_sales_tax: salesTax,
    facto_purchase_tax: purchaseTax,
    facto_gross_sales: grossSales,
    facto_gross_purchases: grossPurchases,
    documentary_result_before_inventory: documentaryResult,
    f29_sales_variance: f29FactoSales - SII_F29_2026_CUT.f29_taxable_sales,
    profit_certifiable: false,
    current_inventory_cost: inventoryCost,
    current_inventory_net_sale_value: inventoryNetSaleValue,
  };
  const missing = (snapshot.source_coverage?.missing_sources ?? []).filter(
    (source) => !source.startsWith("Scotiabank USD: febrero y junio") && !(hasFacto && source.startsWith("Facto:")),
  );
  snapshot.source_coverage = {
    ...(snapshot.source_coverage ?? {}),
    missing_sources: missing,
    verified_zero_activity: [
      "Scotiabank USD · febrero 2026 sin movimientos confirmado",
      "Scotiabank USD · junio 2026 sin movimientos confirmado",
    ],
    facto: hasFacto
      ? {
          source: "Facto API · solo lectura",
          sales_documents: salesDocuments,
          purchase_documents: purchaseDocuments,
          net_sales: netSales,
          sales_tax: salesTax,
          gross_sales: grossSales,
          net_purchases: netPurchases,
          purchase_tax: purchaseTax,
          gross_purchases: grossPurchases,
          period_start: salesMonths[0]?.month ?? null,
          period_end: salesMonths.length ? salesMonths[salesMonths.length - 1].month : null,
        }
      : undefined,
    tax_folder: SII_F29_2026_CUT,
  };
  snapshot.basis = `${snapshot.basis} Facto se incorpora en base devengada documental y la Carpeta Tributaria SII controla IVA e importaciones; bancos conservan la lectura de liquidez.`;
  snapshot.findings = [
    ...(snapshot.findings ?? []).filter(
      (finding) => !finding.title?.toLowerCase().includes("scotiabank usd") && !(hasFacto && finding.title?.toLowerCase().includes("facto")),
    ),
    {
      severity: "info",
      title: "Scotiabank USD febrero y junio verificados",
      detail: "La ausencia de cartolas corresponde a meses sin movimientos y no a una fuente faltante.",
    },
    ...(hasFacto
      ? [{
          severity: "info",
          title: "Facto incorporado en solo lectura",
          detail: `${salesDocuments} documentos de venta y ${purchaseDocuments} documentos de compra alimentan el prebalance sin modificar Facto.`,
        }]
      : []),
  ];
  return snapshot;
}

function downloadPrebalanceCsv(snapshot: AccountingSnapshot) {
  const headers = [
    "Código",
    "Cuenta",
    "Débitos",
    "Créditos",
    "Saldo deudor",
    "Saldo acreedor",
    "Activo",
    "Pasivo",
    "Pérdida",
    "Ganancia",
  ];
  const escape = (value: string | number) => `"${String(value).replace(/"/g, '""')}"`;
  const rows = snapshot.prebalance_rows.map((row) => [
    row.account_code,
    row.account_name,
    row.sum_debit,
    row.sum_credit,
    row.balance_debtor,
    row.balance_creditor,
    row.inventory_asset,
    row.inventory_liability,
    row.result_loss,
    row.result_gain,
  ]);
  const csv = `\ufeff${[headers, ...rows].map((row) => row.map(escape).join(";")).join("\r\n")}`;
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `prebalance-${snapshot.fiscal_year}-v${snapshot.version}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function AccountingDashboard({
  snapshot,
  error,
}: {
  snapshot: AccountingSnapshot | null;
  error: string;
}) {
  if (!snapshot) {
    return (
      <section className="data-card accounting-empty">
        <FileSpreadsheet size={30} />
        <span className="eyebrow">CONTABILIDAD PROTEGIDA</span>
        <h2>Prebalance aún no publicado en el CRM</h2>
        <p>
          {error || "El archivo de trabajo está preparado, pero falta publicar el corte privado en Supabase."}
        </p>
        <small>El módulo financiero general continúa funcionando aunque esta tabla todavía no exista.</small>
      </section>
    );
  }

  const controls = snapshot.controls ?? {};
  const payroll = snapshot.payroll_summary ?? {};
  const periods = payroll.periods ?? [];
  const missingSources = snapshot.source_coverage?.missing_sources ?? [];
  const verifiedZeroActivity = snapshot.source_coverage?.verified_zero_activity ?? [];
  const factoCoverage = snapshot.source_coverage?.facto;
  const taxFolder = snapshot.source_coverage?.tax_folder;
  const documentaryResult = Number(controls.documentary_result_before_inventory ?? 0);
  const f29Variance = Number(controls.f29_sales_variance ?? 0);
  const inventoryCost = Number(controls.current_inventory_cost ?? 0);
  const receivablesVerified = Number(FACTO_MANUAL_RECEIVABLES_VERIFICATION.observed_amount ?? 0);
  const totals = snapshot.prebalance_rows.reduce(
    (result, row) => ({
      debit: result.debit + Number(row.sum_debit ?? 0),
      credit: result.credit + Number(row.sum_credit ?? 0),
      debtor: result.debtor + Number(row.balance_debtor ?? 0),
      creditor: result.creditor + Number(row.balance_creditor ?? 0),
      asset: result.asset + Number(row.inventory_asset ?? 0),
      liability: result.liability + Number(row.inventory_liability ?? 0),
      loss: result.loss + Number(row.result_loss ?? 0),
      gain: result.gain + Number(row.result_gain ?? 0),
    }),
    { debit: 0, credit: 0, debtor: 0, creditor: 0, asset: 0, liability: 0, loss: 0, gain: 0 },
  );

  return (
    <>
      <section className="data-card accounting-hero">
        <div>
          <span className="eyebrow">PREBALANCE DE 8 COLUMNAS · {snapshot.fiscal_year}</span>
          <h2>Contabilidad provisional y conciliable</h2>
          <p>{snapshot.basis}</p>
          <div className="accounting-status-line">
            <span className={`accounting-status ${snapshot.status}`}>{snapshot.status}</span>
            <span>Corte: {financialDateLabel(snapshot.period_end)}</span>
            <span>Versión {snapshot.version}</span>
          </div>
        </div>
        <button className="ghost-button" type="button" onClick={() => downloadPrebalanceCsv(snapshot)}>
          <Download size={18} /> Descargar CSV
        </button>
      </section>

      <section className="agent-dashboard-kpis accounting-kpis">
        <article>
          <FileSpreadsheet size={22} />
          <span>Movimientos bancarios</span>
          <strong>{formatNumber.format(Number(controls.movements_total ?? 0))}</strong>
          <small>{Number(controls.movements_pending_fx ?? 0)} pendientes de conversión</small>
        </article>
        <article>
          <Landmark size={22} />
          <span>Saldo bancario del corte</span>
          <strong>{formatCurrency.format(Number(controls.bank_balance_clp ?? 0))}</strong>
          <small>Saldo reconstruido con las cartolas disponibles</small>
        </article>
        <article>
          <CircleDollarSign size={22} />
          <span>Costo empleador acumulado</span>
          <strong>{formatCurrency.format(Number(payroll.total_employer_cost ?? 0))}</strong>
          <small>{periods.length} períodos incorporados</small>
        </article>
        <article className="risk">
          <AlertTriangle size={22} />
          <span>Movimientos por identificar</span>
          <strong>{formatCurrency.format(Number(controls.unclassified_debits ?? 0) + Number(controls.unidentified_credits ?? 0))}</strong>
          <small>Requieren conciliación, no son gastos ni ventas automáticos</small>
        </article>
        <article className={controls.journal_balanced && controls.balance_sheet_balanced ? "" : "risk"}>
          <ShieldCheck size={22} />
          <span>Control contable</span>
          <strong>{controls.journal_balanced && controls.balance_sheet_balanced ? "Cuadrado" : "Revisar"}</strong>
          <small>Debe = Haber · Activo + pérdida = Pasivo + ganancia</small>
        </article>
      </section>

      <section className="accounting-evidence-grid">
        <article className="data-card accounting-evidence-card">
          <div className="section-title"><div><span className="eyebrow">FACTO · SOLO LECTURA</span><h2>Ventas, compras e IVA documental</h2><p>Movimientos devengados incorporados al prebalance, sin registrar pagos ni modificar Facto.</p></div></div>
          <div className="accounting-metric-grid">
            <div><span>Ventas netas</span><strong>{formatCurrency.format(Number(controls.facto_net_sales ?? 0))}</strong><small>{factoCoverage?.sales_documents ?? 0} documentos</small></div>
            <div><span>IVA débito</span><strong>{formatCurrency.format(Number(controls.facto_sales_tax ?? 0))}</strong><small>Impuesto de ventas</small></div>
            <div><span>Compras netas</span><strong>{formatCurrency.format(Number(controls.facto_net_purchases ?? 0))}</strong><small>{factoCoverage?.purchase_documents ?? 0} documentos</small></div>
            <div><span>IVA crédito</span><strong>{formatCurrency.format(Number(controls.facto_purchase_tax ?? 0))}</strong><small>Informado por los documentos</small></div>
          </div>
        </article>

        <article className="data-card accounting-evidence-card tax">
          <div className="section-title"><div><span className="eyebrow">CARPETA TRIBUTARIA SII</span><h2>Control oficial de IVA e importaciones</h2><p>F29 de enero a junio de 2026; se usa para conciliar, no para duplicar asientos de Facto.</p></div></div>
          <div className="accounting-metric-grid">
            <div><span>Ventas afectas F29</span><strong>{formatCurrency.format(Number(taxFolder?.f29_taxable_sales ?? 0))}</strong><small>Base imponible declarada</small></div>
            <div><span>IVA determinado</span><strong>{formatCurrency.format(Number(taxFolder?.f29_determined_vat ?? 0))}</strong><small>Enero a junio</small></div>
            <div><span>IVA de importaciones</span><strong>{formatCurrency.format(Number(taxFolder?.f29_import_credit_vat ?? 0))}</strong><small>Crédito fiscal aduanero</small></div>
            <div><span>Base aduanera referencial</span><strong>{formatCurrency.format(Number(taxFolder?.import_customs_base_reference ?? 0))}</strong><small>No es costo final ni gasto</small></div>
          </div>
          <div className={`accounting-reconciliation ${Math.abs(f29Variance) <= 10 ? "ok" : "review"}`}>
            <strong>Conciliación Facto vs F29 hasta junio</strong>
            <span>{Math.abs(f29Variance) <= 10 ? "Coincidencia dentro del redondeo." : `Diferencia por revisar: ${formatCurrency.format(f29Variance)}.`}</span>
          </div>
        </article>
      </section>

      <section className="data-card accounting-profit-conclusion">
        <div>
          <span className="eyebrow">CONCLUSIÓN DE LA SITUACIÓN ACTUAL</span>
          <h2>El negocio crece, pero la utilidad real 2026 todavía no puede certificarse</h2>
          <p>
            La operación muestra ventas relevantes y activos de trabajo, pero una parte importante del dinero está comprometida en inventario, importaciones y cuentas por cobrar. El resultado documental antes del ajuste de inventario y otros gastos es <strong>{formatCurrency.format(documentaryResult)}</strong>; no corresponde todavía a utilidad contable ni efectivo disponible.
          </p>
        </div>
        <div className="accounting-profit-signals">
          <article><span>Resultado documental provisional</span><strong>{formatCurrency.format(documentaryResult)}</strong><small>Ventas menos compras documentadas y costo empleador</small></article>
          <article><span>Inventario actual a costo</span><strong>{formatCurrency.format(inventoryCost)}</strong><small>Capital inmovilizado; no es gasto mientras permanezca en stock</small></article>
          <article><span>Cuentas por cobrar verificadas</span><strong>{formatCurrency.format(receivablesVerified)}</strong><small>Corte manual Facto; pendiente de ruta API oficial</small></article>
          <article><span>Resultado tributario 2025</span><strong>{formatCurrency.format(Number(taxFolder?.prior_year_taxable_base ?? 0))}</strong><small>Referencia oficial del año anterior, no utilidad 2026</small></article>
        </div>
        <div className="notice-banner warning">
          Para obtener la utilidad real faltan inventario inicial, costo aduanero completo por importación, consumo/costo de ventas, depreciaciones, gastos devengados y conciliación bancaria final. Compras no equivale a costo de ventas y ventas no equivale a caja.
        </div>
      </section>

      <section className="accounting-bank-grid">
        <article className="data-card accounting-bank-card">
          <div className="section-title">
            <div><h2>Bancos y cobertura</h2><p>Saldo reconstruido y período realmente disponible por fuente.</p></div>
          </div>
          <div className="accounting-bank-list">
            {snapshot.bank_summary.map((bank) => {
              const sourceName = bank.name.replace(/ CLP$| convertido a CLP$/g, "");
              const source = snapshot.source_coverage?.accounts?.[sourceName];
              return (
                <article key={bank.account_code}>
                  <div><strong>{bank.name}</strong><small>{source?.transactions ?? 0} movimientos</small></div>
                  <div><strong>{formatCurrency.format(Number(bank.balance_clp ?? 0))}</strong><small>{source?.from ?? "sin inicio"} · {source?.to ?? "sin cierre"}</small></div>
                </article>
              );
            })}
          </div>
        </article>

        <article className="data-card accounting-findings">
          <div className="section-title"><div><h2>Alertas del corte</h2><p>Qué falta antes de usarlo como cierre definitivo.</p></div></div>
          {snapshot.findings.map((finding, index) => (
            <article className={finding.severity === "warning" ? "warning" : "info"} key={`${finding.title}-${index}`}>
              {finding.severity === "warning" ? <AlertTriangle size={18} /> : <ShieldCheck size={18} />}
              <div><strong>{finding.title}</strong><span>{finding.detail}</span></div>
            </article>
          ))}
        </article>
      </section>

      <section className="data-card accounting-prebalance-card">
        <div className="section-title accounting-prebalance-heading">
          <div>
            <span className="eyebrow">BALANCE TRIBUTARIO</span>
            <h2>Prebalance {snapshot.fiscal_year} de 8 columnas</h2>
            <p>Débitos, créditos, saldos, inventario y resultado por cuenta del mayor.</p>
          </div>
          <span className="accounting-control-pill">
            {formatCurrency.format(totals.debit)} en movimientos cuadrados
          </span>
        </div>
        <div className="accounting-table-wrap">
          <table className="accounting-table">
            <thead><tr><th>Cuenta</th><th>Débitos</th><th>Créditos</th><th>Saldo deudor</th><th>Saldo acreedor</th><th>Activo</th><th>Pasivo</th><th>Pérdida</th><th>Ganancia</th></tr></thead>
            <tbody>
              {snapshot.prebalance_rows.map((row) => (
                <tr key={row.account_code}>
                  <th><span>{row.account_code}</span>{row.account_name}<small>{row.nature}</small></th>
                  <td data-label="Débitos">{formatCurrency.format(row.sum_debit)}</td>
                  <td data-label="Créditos">{formatCurrency.format(row.sum_credit)}</td>
                  <td data-label="Saldo deudor">{formatCurrency.format(row.balance_debtor)}</td>
                  <td data-label="Saldo acreedor">{formatCurrency.format(row.balance_creditor)}</td>
                  <td data-label="Activo">{formatCurrency.format(row.inventory_asset)}</td>
                  <td data-label="Pasivo">{formatCurrency.format(row.inventory_liability)}</td>
                  <td data-label="Pérdida">{formatCurrency.format(row.result_loss)}</td>
                  <td data-label="Ganancia">{formatCurrency.format(row.result_gain)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr><th>Totales</th><td>{formatCurrency.format(totals.debit)}</td><td>{formatCurrency.format(totals.credit)}</td><td>{formatCurrency.format(totals.debtor)}</td><td>{formatCurrency.format(totals.creditor)}</td><td>{formatCurrency.format(totals.asset)}</td><td>{formatCurrency.format(totals.liability)}</td><td>{formatCurrency.format(totals.loss)}</td><td>{formatCurrency.format(totals.gain)}</td></tr></tfoot>
          </table>
        </div>
      </section>

      <section className="accounting-payroll-grid">
        <article className="data-card accounting-payroll-card">
          <div className="section-title"><div><h2>Remuneraciones 2026</h2><p>Totales mensuales sin datos personales en el CRM.</p></div></div>
          <div className="accounting-payroll-list">
            {periods.map((period) => (
              <article key={period.period}>
                <strong>{monthLabel(period.period)}</strong>
                <span>Imponible {formatCurrency.format(period.taxable_salary)}</span>
                <span>Líquido {formatCurrency.format(period.net_payable)}</span>
                <span>Costo empleador {formatCurrency.format(period.total_employer_cost)}</span>
                <small className={period.health_certified ? "verified" : "estimated"}>{period.health_certified ? "Documentado" : "Salud estimada · revisar"}</small>
              </article>
            ))}
          </div>
        </article>

        <article className="data-card accounting-facto-proposal">
          <span className="eyebrow">PROPUESTA PROTEGIDA</span>
          <h2>Alta laboral en Facto</h2>
          <p>La información está preparada para revisión, pero el CRM no escribirá automáticamente en Facto.</p>
          <ul>
            <li>Confirmar módulo y ruta oficial de Facto.</li>
            <li>Respaldar la configuración antes del alta.</li>
            <li>Validar ficha, cuenta contable, centro de costo y fecha de inicio.</li>
            <li>Aprobar manualmente cada efecto contable.</li>
          </ul>
          <div className="notice-banner info">Estado: pendiente de revisión humana. No se ha modificado Facto.</div>
        </article>
      </section>

      {missingSources.length ? (
        <section className="data-card accounting-missing">
          <div className="section-title"><div><h2>Fuentes pendientes</h2><p>El corte seguirá marcado como provisional hasta completar estos antecedentes.</p></div></div>
          <ul>{missingSources.map((source) => <li key={source}>{source}</li>)}</ul>
        </section>
      ) : null}
      {verifiedZeroActivity.length ? (
        <section className="data-card accounting-verified-zero">
          <div className="section-title"><div><h2>Períodos verificados sin movimiento</h2><p>No se consideran fuentes faltantes.</p></div></div>
          <ul>{verifiedZeroActivity.map((source) => <li key={source}>{source}</li>)}</ul>
        </section>
      ) : null}
    </>
  );
}

function FinanceWorkspace({
  tasks,
  accountingSnapshot,
  accountingError,
}: {
  tasks: AgentTask[];
  accountingSnapshot: AccountingSnapshot | null;
  accountingError: string;
}) {
  const [view, setView] = useState<"management" | "accounting">("management");
  return (
    <>
      <nav aria-label="Secciones de finanzas" className="finance-workspace-tabs">
        <button className={view === "management" ? "active" : ""} type="button" onClick={() => setView("management")}>
          <TrendingUp size={18} /> Gestión financiera
        </button>
        <button className={view === "accounting" ? "active" : ""} type="button" onClick={() => setView("accounting")}>
          <FileSpreadsheet size={18} /> Contabilidad 2026
          {accountingSnapshot?.status === "provisional" ? <span>Provisional</span> : null}
        </button>
      </nav>
      {view === "management" ? <FinanceDashboard tasks={tasks} /> : <AccountingDashboard snapshot={accountingSnapshot} error={accountingError} />}
    </>
  );
}

function FinanceDashboard({ tasks }: { tasks: AgentTask[] }) {
  const latest = tasks[0];
  const report = financialReportFromTask(latest);
  const [selectedMonth, setSelectedMonth] = useState("all");
  const [supplierQuery, setSupplierQuery] = useState("");
  const [supplierYear, setSupplierYear] = useState("all");
  const [collectionQuery, setCollectionQuery] = useState("");
  const [collectionSort, setCollectionSort] = useState("amount_desc");
  const effectiveCollections = useMemo(() => {
    const synced = report?.collections;
    if (synced?.mode === "facto_receivables" && synced.authoritative) return synced;
    return FACTO_MANUAL_RECEIVABLES_VERIFICATION;
  }, [report?.collections]);
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
    const rows = (effectiveCollections.customers ?? []).filter((item) => {
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
  }, [collectionQuery, collectionSort, effectiveCollections.customers]);

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
  const supplierMaximum = Math.max(
    ...filteredSuppliers.map((item) => item.displayed_purchases),
    1,
  );
  const supplierTotal = filteredSuppliers.reduce(
    (total, item) => total + item.displayed_purchases,
    0,
  );
  const collections = effectiveCollections;
  // A legacy snapshot may mark a payment ledger as authoritative. Accounts
  // receivable is valid only when it came from Facto's collections resource
  // or from the exact dated balance printed in Facto's official PDF.
  const collectionsAuthoritative = (
    ["facto_receivables", "facto_document_pdf", "manual_facto_verification"].includes(collections?.mode ?? "")
    && Boolean(collections?.authoritative ?? report.receivables_available)
  );
  const collectionsFromPdf = collections?.mode === "facto_document_pdf";
  const collectionsFromManualVerification = collections?.mode === "manual_facto_verification";
  const reviewedCollectionDocuments = Number(
    collections?.reviewed_documents ?? collections?.documents ?? 0,
  );
  const collectionChartSlices = (collections?.aging ?? []).map((item, index) => ({
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

      <section className="data-card finance-collections-header">
        <div>
          <span className="eyebrow">COBRANZA TRAZABLE</span>
          <h2>Caja y cuentas por cobrar</h2>
          <p>
            {collections?.mode === "facto_receivables"
              ? "Cartera oficial de Cobranza → Documentos impagos, con el saldo pendiente informado por Facto después de abonos."
              : collectionsFromPdf
                ? "Saldo pendiente exacto y fechado, leído desde el PDF oficial que Facto entrega por API para cada factura."
                : collectionsFromManualVerification
                  ? "Corte verificado manualmente en Facto mientras esperamos la ruta API oficial de Cobranza."
              : "El CRM no convierte facturas emitidas, condiciones de pago ni listados de abonos en deuda. Sólo mostrará la cartera real de Documentos impagos de Facto."}
          </p>
        </div>
        <span className={collectionsAuthoritative ? "ready" : "pending"}>
          {collectionsAuthoritative
            ? collectionsFromManualVerification
              ? "Verificación manual"
              : collectionsFromPdf
                ? "Saldo PDF verificado"
                : "Saldo oficial disponible"
            : "Esperando recurso de Cobranza"}
        </span>
      </section>

      {collectionsAuthoritative ? (
        <>
          <section className="agent-dashboard-kpis finance-collection-kpis">
            <article>
              <CircleDollarSign size={22} />
              <span>
                {collectionsFromManualVerification
                  ? "Saldo pendiente verificado"
                  : collectionsFromPdf && !collections?.portfolio_complete
                    ? "Saldo pendiente observado"
                    : "Cuentas por cobrar"}
              </span>
              <strong>{formatCurrency.format(Number(collections?.observed_amount ?? 0))}</strong>
              <small>{collections?.documents ?? 0} documentos impagos</small>
            </article>
            <article className={Number(collections?.overdue_amount ?? 0) > 0 ? "risk" : ""}>
              <AlertTriangle size={22} />
              <span>Cartera vencida</span>
              <strong>
                {collectionsFromManualVerification
                  ? "Pendiente API"
                  : formatCurrency.format(Number(collections?.overdue_amount ?? 0))}
              </strong>
              <small>
                {collectionsFromManualVerification
                  ? "Facto debe entregar fechas de vencimiento"
                  : `${collections?.overdue_documents ?? 0} documentos fuera de plazo`}
              </small>
            </article>
            <article>
              <TrendingUp size={22} />
              <span>Vence en próximos 30 días</span>
              <strong>
                {collectionsFromManualVerification
                  ? "Pendiente API"
                  : formatCurrency.format(Number(collections?.due_next_30 ?? 0))}
              </strong>
              <small>
                {collectionsFromManualVerification
                  ? "No se estiman vencimientos"
                  : "Saldo pendiente con vencimiento próximo"}
              </small>
            </article>
            <article>
              <Database size={22} />
              <span>Fuente de cobranza</span>
              <strong>Facto</strong>
              <small>
                {collectionsFromPdf
                  ? `PDF oficial · ${collections?.pdf_coverage?.documents_with_balance ?? 0} saldos leídos`
                  : collectionsFromManualVerification
                    ? "Facto web · corte 31-07-2026"
                    : "Cobranza → Documentos impagos"}
              </small>
            </article>
          </section>

          {collectionsFromPdf ? (
            <div className={`notice-banner ${collections?.portfolio_complete ? "success" : "warning"}`}>
              <strong>
                {collections?.portfolio_complete
                  ? "Cobertura PDF completa para los documentos consultados."
                  : "Cobertura parcial: este monto no debe interpretarse todavía como toda la cartera."}
              </strong>
              <span>
                Facto entregó {collections?.pdf_coverage?.documents_with_balance ?? 0} saldos exactos en
                {` ${collections?.pdf_coverage?.documents_with_pdf ?? 0}`} PDF disponibles,
                de {collections?.pdf_coverage?.documents_examined ?? reviewedCollectionDocuments} documentos examinados.
                No se estiman los saldos faltantes.
              </span>
            </div>
          ) : null}

          {collectionsFromManualVerification ? (
            <div className="notice-banner warning">
              <strong>Corte manual temporal: 18 facturas, 9 clientes y $30.756.397 pendientes.</strong>
              <span>
                Verificado en Facto → Cobranza → Documentos impagos al 31-07-2026. Este corte no se
                actualiza automáticamente y será reemplazado por la ruta API oficial, sin perder el historial.
              </span>
            </div>
          ) : null}

          <section className="finance-collections-grid">
            {collectionsFromManualVerification ? (
              <article className="data-card finance-collection-card">
                <div className="section-title">
                  <div>
                    <h2>Antigüedad de la cartera</h2>
                    <p>La clasificación por vencimiento se activará con la ruta API oficial.</p>
                  </div>
                </div>
                <div className="finance-customer-empty">
                  <Database size={24} />
                  <strong>No se inventan fechas ni mora</strong>
                  <span>
                    Facto confirmó los saldos pendientes en su plataforma, pero el corte manual no incluye
                    vencimientos ni abonos estructurados para construir este gráfico con trazabilidad.
                  </span>
                </div>
              </article>
            ) : (
              <DonutChart
                centerLabel="saldo pendiente"
                centerValue={formatCurrency.format(Number(collections?.observed_amount ?? 0))}
                formatter={(value) => formatCurrency.format(value)}
                slices={collectionChartSlices}
                subtitle="Distribución del saldo real informado por Facto según su vencimiento."
                title="Antigüedad de la cartera"
              />
            )}

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
                      {item.folios?.length ? ` · Folios ${item.folios.join(", ")}` : ""}
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
                    <strong>Sin documentos impagos para este filtro</strong>
                    <span>La cartera oficial de Facto no contiene coincidencias.</span>
                  </div>
                ) : null}
              </div>
            </article>
          </section>
        </>
      ) : (
        <section className="data-card finance-collection-card">
          <div className="notice-banner warning">
            <strong>La API conectada aún no entrega Cobranza → Documentos impagos.</strong>
            <span>
              Facto entregó {reviewedCollectionDocuments} facturas emitidas, pero una factura emitida
              no demuestra que siga pendiente. Por seguridad, el CRM no muestra $0 ni calcula deuda
              desde condiciones de pago.
            </span>
          </div>
          <div className="finance-customer-empty">
            <Database size={24} />
            <strong>Cartera real pendiente de habilitación en Facto</strong>
            <span>
              El conector ya está preparado para recibir saldo pendiente, abonos, vencimiento, RUT y
              razón social desde un recurso oficial de solo lectura.
            </span>
          </div>
        </section>
      )}

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
  const [commercialSnapshot, setCommercialSnapshot] = useState<CommercialSnapshot>({
    customers: [],
  });
  const [commercialProducts, setCommercialProducts] = useState<
    CommercialSalesProduct[]
  >([]);
  const [accountingSnapshot, setAccountingSnapshot] = useState<AccountingSnapshot | null>(null);
  const [accountingError, setAccountingError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) {
      setTasks([]);
      setSnapshots([]);
      setAccountingSnapshot(null);
      setLoading(false);
      return;
    }
    setNotice("");
    try {
      const { data, error } = await supabase.from("business_agent_tasks").select("id,agent_type,status,created_at,completed_at,result,error_code").eq("agent_type", agentType).order("created_at", { ascending: false }).limit(20);
      if (error) throw error;
      setTasks((data ?? []) as AgentTask[]);
      if (agentType === "logistics") setSnapshots(await loadAllSnapshots());
      if (agentType === "finance") {
        const [accountingResult, financialResult, financeInventory] = await Promise.all([
          supabase
            .from("accounting_snapshots")
            .select("id,fiscal_year,version,period_start,period_end,status,basis,source_coverage,bank_summary,payroll_summary,prebalance_rows,controls,findings,artifact_metadata,updated_at")
            .order("fiscal_year", { ascending: false })
            .order("version", { ascending: false })
            .limit(1),
          supabase
            .from("integration_records")
            .select("payload")
            .eq("provider", "facto")
            .eq("resource", "financial_snapshots")
            .order("updated_at", { ascending: false })
            .limit(1),
          loadAllSnapshots(),
        ]);
        if (accountingResult.error) {
          setAccountingSnapshot(null);
          setAccountingError("Falta instalar o publicar el módulo privado de contabilidad en Supabase.");
        } else {
          const rawAccounting = (accountingResult.data?.[0] as AccountingSnapshot | undefined) ?? null;
          const rawFinancial = (financialResult.data?.[0]?.payload as FinancialReport | undefined) ?? null;
          setAccountingSnapshot(
            rawAccounting ? reconcileAccountingSnapshot(rawAccounting, rawFinancial, financeInventory) : null,
          );
          setAccountingError("");
        }
      } else {
        setAccountingSnapshot(null);
        setAccountingError("");
      }
      if (agentType === "commercial") {
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
        if (commercialResult.error) throw commercialResult.error;
        if (financialResult.error) throw financialResult.error;
        const synchronized = commercialResult.data?.[0]?.payload as
          | CommercialSnapshot
          | undefined;
        const financial = financialResult.data?.[0]?.payload as
          | { top_products?: CommercialSalesProduct[] }
          | undefined;
        setCommercialSnapshot(synchronized ?? { customers: [] });
        setCommercialProducts(financial?.top_products ?? []);
      }
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
      {!loading && agentType === "foreign_trade" ? <ForeignTradeDashboard tasks={tasks} /> : null}
      {!loading && agentType === "finance" ? (
        <FinanceWorkspace
          accountingError={accountingError}
          accountingSnapshot={accountingSnapshot}
          tasks={tasks}
        />
      ) : null}
      {!loading && agentType === "commercial" ? (
        <CommercialDashboard
          synchronizedCustomers={commercialSnapshot.customers}
          synchronizedProducts={commercialProducts}
          tasks={tasks}
        />
      ) : null}
      {!loading && agentType !== "logistics" && agentType !== "finance" && agentType !== "commercial" && agentType !== "foreign_trade" ? <GenericAgentDashboard agentType={agentType} tasks={tasks} /> : null}
    </section>
  );
}
