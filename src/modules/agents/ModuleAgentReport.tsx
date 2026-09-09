import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, ArrowRight, ExternalLink } from "lucide-react";
import { ExecutiveDailyReport, type DailyBrief } from "./ExecutiveDailyReport";
import "./moduleReport.css";

type Row = Record<string, unknown>;
type Task = { id: string; status: string; error_code?: string | null; result?: { summary?: string; warnings?: string[]; evidence?: Row[] } | null };
type Section = { key: string; title: string; href: string; source: string; source_from: string | null; source_to: string | null; row_count: number; rows: Row[] };
const labels: Record<string, string> = {
  id: "ID", name: "Nombre", sku: "SKU", brands: "Marca", status: "Estado", priority: "Prioridad", rut: "RUT",
  stock: "Stock", stock_source: "Origen stock", source_at: "Fecha de origen", next_follow_up: "Seguimiento", updated_at: "Actualizado",
  company_id: "Empresa", type: "Tipo", occurred_at: "Fecha", next_action: "Proxima accion", reference: "Referencia", title: "Titulo",
  operation_type: "Tipo operacion", inventory_mode: "Base inventario", base_currency: "Moneda base", value_usd: "Valor USD", estimated_arrival: "Llegada estimada",
  document_type: "Tipo documento", original_file_name: "Archivo", parse_status: "Revision", confirmed_at: "Confirmado", currency: "Moneda",
  landed_total_clp: "Costo proyectado CLP", projected_profit_clp: "Utilidad proyectada CLP", missing_inputs: "Datos faltantes", calculated_at: "Calculado",
  category: "Categoria", amount_original: "Monto original", amount_clp: "Monto CLP", source_type: "Origen costo", country_code: "Pais", active: "Activo",
  scheduled_at: "Programada", published_at: "Publicada", next_run_at: "Proxima ejecucion", operation_mode: "Modo", send_at: "Envio programado",
  warnings: "Observaciones", document_number: "Folio", folio: "Folio", customer: "Cliente", counterpart_name: "Contraparte", counterpart_tax_id: "RUT",
  tax_id: "RUT", observed_amount: "Saldo informado", issued_on: "Emision", net_amount: "Neto", total_amount: "Total", source_updated_at: "Fecha de origen",
  companies: "Empresas", followups_overdue: "Seguimientos pendientes", interactions: "Interacciones", products: "SKU identificados", stock_unknown: "SKU sin stock verificado",
  stock_available: "SKU con stock registrado", stockouts: "SKU sin disponibilidad", campaigns: "Campanas", publications: "Publicaciones", pending_approval: "Por aprobar", failed_publications: "Publicaciones con error",
  active_operations: "Operaciones abiertas", shipments_in_transit: "Embarques en transito", trade_documents_to_review: "Documentos por revisar", scenarios_incomplete: "Escenarios incompletos",
  net_sales: "Ventas netas CLP", cost_of_sales: "Costo de ventas CLP", operating_expenses: "Gastos operativos CLP", gross_profit: "Resultado bruto CLP",
  operating_profit: "Resultado operativo CLP", bank_clp: "Banco CLP", payables: "Cuentas por pagar CLP", receivables: "Cuentas por cobrar CLP",
  overdue_amount: "Cartera vencida CLP", checks_portfolio: "Cheques CLP", bank_confirmed_receivables: "Saldo por cobrar con base bancaria CLP", gross_margin: "Margen bruto %",
};
function valueText(value: unknown): string {
  if (value === null || value === undefined || value === "") return "No disponible";
  if (typeof value === "boolean") return value ? "Si" : "No";
  if (typeof value === "number") return value.toLocaleString("es-CL", { maximumFractionDigits: 2 });
  if (Array.isArray(value)) return value.length ? value.map(valueText).join(", ") : "Sin observaciones";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}
function SectionTable({ section }: { section: Section }) {
  const [page, setPage] = useState(0);
  const columns = [...new Set(section.rows.flatMap(Object.keys))].filter((key) => labels[key] && key !== "id");
  const maxPage = Math.max(0, Math.ceil(section.rows.length / 25) - 1);
  const current = Math.min(page, maxPage);
  const visible = section.rows.slice(current * 25, (current + 1) * 25);
  return <details className="agent-module-section">
    <summary>{section.title} ({section.row_count})</summary>
    <p>{section.source} · Origen: {section.source_from || "Sin fecha"} a {section.source_to || "Sin fecha"}</p>
    <Link to={section.href}>Abrir modulo <ExternalLink size={14} /></Link>
    {section.rows.length ? <>
      <div className="agent-module-table-wrap"><table className="agent-module-table agent-module-documents">
        <thead><tr>{columns.map((key) => <th key={key}>{labels[key]}</th>)}<th>Registro</th></tr></thead>
        <tbody>{visible.map((row, index) => <tr key={String(row.id || row.sku || index)}>
          {columns.map((key) => <td key={key}>{valueText(row[key])}</td>)}
          <td>{typeof row.href === "string" && row.href.startsWith("/") && !row.href.startsWith("//") ? <Link to={row.href}>Abrir</Link> : <Link to={section.href}>Ver en modulo</Link>}</td>
        </tr>)}</tbody>
      </table></div>
      <nav className="agent-module-pagination" aria-label={`Paginas de ${section.title}`}>
        <button type="button" title="Pagina anterior" aria-label="Pagina anterior" disabled={current === 0} onClick={() => setPage(current - 1)}><ArrowLeft size={18} /></button>
        <span>{current * 25 + 1}-{Math.min((current + 1) * 25, section.rows.length)} de {section.rows.length}</span>
        <button type="button" title="Pagina siguiente" aria-label="Pagina siguiente" disabled={current === maxPage} onClick={() => setPage(current + 1)}><ArrowRight size={18} /></button>
      </nav>
    </> : <p>Sin registros en esta fuente.</p>}
  </details>;
}
export function ModuleAgentReport({ tasks }: { tasks: Task[] }) {
  const task = tasks.find((item) => item.status === "completed" && item.result?.evidence?.some((entry) => entry.module_report));
  const report = task?.result?.evidence?.find((entry) => entry.module_report)?.module_report as Row | undefined;
  if (!task || !report) return <section className="data-card agent-module-report"><h2>Analisis de modulos</h2><p>Aun no hay un analisis completado con la nueva fuente.</p>{tasks[0]?.status === "failed" ? <p role="alert">No se pudo leer un modulo. No se usaron cifras antiguas para reemplazarlo.</p> : null}<Link to="/agentes">Solicitar analisis</Link></section>;
  const sections = (report.sections || []) as Section[];
  const recommendations = (report.recommendations || []) as { title: string; detail: string; href: string }[];
  const accounting = report.accounting as Row | null;
  const accountingSections: Section[] = accounting ? [
    { key: "receivables", title: "Cartera verificada", href: "/finanzas-contabilidad?view=receivables", source: "Finanzas", source_from: String(accounting.source_as_of || ""), source_to: String(accounting.source_as_of || ""), rows: (accounting.verified_documents || []) as Row[], row_count: ((accounting.verified_documents || []) as Row[]).length },
    { key: "documents", title: "Documentos financieros", href: "/finanzas-contabilidad?view=facto", source: "Finanzas", source_from: null, source_to: String(accounting.as_of || ""), rows: (accounting.source_documents || []) as Row[], row_count: ((accounting.source_documents || []) as Row[]).length },
  ] : [];
  const brief = task.result?.evidence?.find((entry) => entry.executive_brief)?.executive_brief as DailyBrief | undefined;
  if (report.agent === "executive" && brief) return <ExecutiveDailyReport brief={brief} stale={tasks[0]?.id !== task.id}>
    {(task.result?.warnings || []).map((warning,index) => <p className="notice-banner warning" key={index}>{warning}</p>)}
    {[...accountingSections, ...sections].map((section) => <SectionTable key={`${task.id}:${section.key}`} section={section} />)}
  </ExecutiveDailyReport>;
  return <section className="data-card agent-module-report">
    <span className="eyebrow">FUENTES: MODULOS DEL CRM</span><h2>Informe operativo</h2>
    <p>{task.result?.summary}</p><p>Consultado: {valueText(report.consulted_at)}</p>
    {accounting ? <p>Finanzas: base {valueText(accounting.basis)} · Corte cartera {valueText(accounting.source_as_of)} · <Link to="/finanzas-contabilidad?view=dashboard">Abrir Finanzas</Link></p> : null}
    {tasks[0]?.id !== task.id ? <p className="notice-banner warning">Este es el ultimo analisis completado, no la solicitud mas reciente.</p> : null}
    {(task.result?.warnings || []).map((warning, index) => <p className="notice-banner warning" key={index}>{warning}</p>)}
    <div className="agent-module-table-wrap"><table className="agent-module-table"><tbody>
      {Object.entries((report.metrics || {}) as Row).filter(([key]) => labels[key]).map(([key, value]) => <tr key={key}><th>{labels[key]}</th><td>{valueText(value)}</td></tr>)}
    </tbody></table></div>
    {recommendations.length ? <section className="agent-module-recommendations"><h3>Para revisar</h3>{recommendations.map((item, index) => <p key={index}><Link to={item.href}>{item.title}</Link><br />{item.detail}</p>)}</section> : null}
    {[...accountingSections, ...sections].map((section) => <SectionTable key={`${task.id}:${section.key}`} section={section} />)}
  </section>;
}
