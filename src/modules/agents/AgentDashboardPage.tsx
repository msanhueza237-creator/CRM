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
  unit_price_is_net?: boolean;
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
  const sourcePrice = Number(item.unit_price ?? 0);
  return item.unit_price_is_net ? sourcePrice : sourcePrice / CHILE_VAT_FACTOR;
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

      <div className="logistics-dashboard-grid">
        <section className="data-card logistics-chart">
          <div className="section-title logistics-chart-title">
            <div><h2>Mayor existencia y valorización</h2><p>Compara unidades, capital a costo o valor potencial de venta.</p></div>
            <select
              aria-label="Métrica del ranking de inventario"
              onChange={(event) => setRankingMode(event.target.value as "stock" | "cost_value" | "sale_value")}
              value={rankingMode}
            >
              <option value="stock">Por unidades</option>
              <option value="cost_value">Por dinero a costo</option>
              <option value="sale_value">Por valor de venta</option>
            </select>
          </div>
          <div className="stock-bars product-ranking-scroll">
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

        <section className="data-card evidence-coverage">
          <div className="section-title"><div><h2>Cobertura de evidencia</h2><p>Qué análisis puede sostener hoy la información real.</p></div></div>
          {[
            ["Stock por producto", metrics.withStock.length, snapshots.length],
            ["Costo de origen", metrics.withCost.length, snapshots.length],
            ["Precio de venta", metrics.withPrice.length, snapshots.length],
            ["Historial de ventas", metrics.withSalesHistory.length, snapshots.length],
          ].map(([label, count, total]) => {
            const percentage = Number(total) ? (Number(count) / Number(total)) * 100 : 0;
            return (
              <article key={String(label)}>
                <div><strong>{label}</strong><span>{Math.round(percentage)}%</span></div>
                <div className="coverage-track"><span style={{ width: `${percentage}%` }} /></div>
              </article>
            );
          })}
          {!metrics.withSalesHistory.length ? (
            <div className="dashboard-warning"><AlertTriangle size={18} />El historial de ventas aún se está sincronizando desde Facto. Los rankings se habilitarán sólo con documentos reales.</div>
          ) : null}
          {latest?.result?.summary ? <p className="agent-result-summary">{latest.result.summary}</p> : null}
        </section>
      </div>

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
              <option value="sale_value">Por venta valorizada</option>
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
              <option value="sale_value">Por valor de venta</option>
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
      {!loading && agentType !== "logistics" ? <GenericAgentDashboard agentType={agentType} tasks={tasks} /> : null}
    </section>
  );
}
