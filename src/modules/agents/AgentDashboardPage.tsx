import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  BarChart3,
  Boxes,
  CheckCircle2,
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
  price_known?: boolean;
  margin_percent?: number | null;
  average_daily_demand?: number;
  demand_available?: boolean;
  sales_history_available?: boolean;
  units_sold_observed?: number;
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
const formatSourceAmount = new Intl.NumberFormat("es-CL", { maximumFractionDigits: 0 });

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

function LogisticsDashboard({ tasks, snapshots }: { tasks: AgentTask[]; snapshots: Snapshot[] }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [sort, setSort] = useState("stock");

  const metrics = useMemo(() => {
    const withStock = snapshots.filter((item) => item.stock_known);
    const inStock = withStock.filter((item) => Number(item.available_units ?? 0) > 0);
    const outOfStock = withStock.filter((item) => Number(item.available_units ?? 0) <= 0);
    const withCost = snapshots.filter((item) => item.cost_available_in_source);
    const withSales = snapshots.filter((item) => item.demand_available);
    return {
      withStock,
      inStock,
      outOfStock,
      withCost,
      withSales,
      totalUnits: withStock.reduce((sum, item) => sum + Number(item.available_units ?? 0), 0),
      sourceValue: withCost.reduce(
        (sum, item) => sum + Number(item.available_units ?? 0) * Number(item.unit_cost_source ?? 0),
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
      if (filter === "with_sales") return Boolean(item.demand_available);
      if (filter === "without_sales") return !item.demand_available;
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
      return Number(right.available_units ?? 0) - Number(left.available_units ?? 0);
    });
  }, [filter, query, snapshots, sort]);

  const topStock = useMemo(
    () => [...metrics.inStock].sort((a, b) => Number(b.available_units ?? 0) - Number(a.available_units ?? 0)).slice(0, 8),
    [metrics.inStock],
  );
  const maxStock = Math.max(...topStock.map((item) => Number(item.available_units ?? 0)), 1);
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
          <span>Sin stock</span>
          <strong>{formatNumber.format(metrics.outOfStock.length)}</strong>
          <small>Stock comprobado en Facto</small>
        </article>
        <article>
          <CircleDollarSign size={22} />
          <span>Valor según costo fuente</span>
          <strong>{formatSourceAmount.format(metrics.sourceValue)}</strong>
          <small>{metrics.withCost.length} productos · moneda informada por Facto</small>
        </article>
        <article>
          <TrendingUp size={22} />
          <span>Con ventas por SKU</span>
          <strong>{formatNumber.format(metrics.withSales.length)}</strong>
          <small>Base para rotación real</small>
        </article>
      </section>

      <div className="logistics-dashboard-grid">
        <section className="data-card logistics-chart">
          <div className="section-title"><div><h2>Mayor existencia en bodega</h2><p>Unidades disponibles informadas por Facto.</p></div></div>
          <div className="stock-bars">
            {topStock.map((item) => (
              <article key={item.sku}>
                <div><strong>{item.name || item.sku}</strong><span>{formatNumber.format(Number(item.available_units ?? 0))}</span></div>
                <div className="stock-bar-track"><span style={{ width: `${Math.max(3, (Number(item.available_units ?? 0) / maxStock) * 100)}%` }} /></div>
              </article>
            ))}
            {!topStock.length ? <p>Facto todavía no entregó existencias positivas.</p> : null}
          </div>
        </section>

        <section className="data-card evidence-coverage">
          <div className="section-title"><div><h2>Cobertura de evidencia</h2><p>Qué análisis puede sostener hoy la información real.</p></div></div>
          {[
            ["Stock por producto", metrics.withStock.length, snapshots.length],
            ["Costo de origen", metrics.withCost.length, snapshots.length],
            ["Ventas por SKU", metrics.withSales.length, snapshots.length],
          ].map(([label, count, total]) => {
            const percentage = Number(total) ? (Number(count) / Number(total)) * 100 : 0;
            return (
              <article key={String(label)}>
                <div><strong>{label}</strong><span>{Math.round(percentage)}%</span></div>
                <div className="coverage-track"><span style={{ width: `${percentage}%` }} /></div>
              </article>
            );
          })}
          {!metrics.withSales.length ? (
            <div className="dashboard-warning"><AlertTriangle size={18} />Rotación, días en bodega y productos más vendidos aparecerán cuando Facto entregue líneas de venta por SKU. No se muestran estimaciones inventadas.</div>
          ) : null}
          {latest?.result?.summary ? <p className="agent-result-summary">{latest.result.summary}</p> : null}
        </section>
      </div>

      <section className="data-card logistics-catalog">
        <div className="section-title"><div><h2>Inventario completo</h2><p>{filtered.length} productos coinciden con los filtros.</p></div></div>
        <div className="logistics-controls">
          <label><Search size={18} /><input aria-label="Buscar producto" onChange={(event) => setQuery(event.target.value)} placeholder="Buscar por SKU o nombre" value={query} /></label>
          <select aria-label="Filtrar inventario" onChange={(event) => setFilter(event.target.value)} value={filter}>
            <option value="all">Todos</option><option value="in_stock">Con stock</option><option value="out_of_stock">Sin stock</option><option value="with_sales">Con ventas observadas</option><option value="without_sales">Sin ventas disponibles</option>
          </select>
          <select aria-label="Ordenar inventario" onChange={(event) => setSort(event.target.value)} value={sort}>
            <option value="stock">Mayor stock</option><option value="value">Mayor valor de inventario</option><option value="name">Nombre A-Z</option>
          </select>
        </div>
        <div className="logistics-table-wrap">
          <table className="logistics-table">
            <thead><tr><th>Producto</th><th>SKU</th><th>Stock</th><th>Costo origen</th><th>Precio</th><th>Ventas / rotación</th></tr></thead>
            <tbody>
              {filtered.slice(0, 250).map((item) => (
                <tr key={item.sku}>
                  <td><strong>{item.name || "Sin nombre"}</strong></td><td>{item.sku}</td>
                  <td><span className={`inventory-status ${Number(item.available_units ?? 0) > 0 ? "ok" : "empty"}`}>{item.stock_known ? formatNumber.format(Number(item.available_units ?? 0)) : "Sin dato"}</span></td>
                  <td>{item.cost_available_in_source ? formatSourceAmount.format(Number(item.unit_cost_source ?? 0)) : "Sin dato"}</td>
                  <td>{item.price_known ? formatSourceAmount.format(Number(item.unit_price ?? 0)) : "Sin dato"}</td>
                  <td>{item.demand_available ? `${formatNumber.format(Number(item.average_daily_demand ?? 0))}/día` : "Pendiente de ventas SKU"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {filtered.length > 250 ? <small>Se muestran los primeros 250 resultados filtrados.</small> : null}
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
    if (!isSupabaseConfigured || !supabase) return;
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
