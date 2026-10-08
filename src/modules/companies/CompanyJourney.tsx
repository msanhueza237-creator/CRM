import { whatsappRequest } from "../../lib/whatsappApi";
import { crmQuotePdf } from "../../lib/crmQuotePdf";
import type { CrmQuote } from "../../../supabase/functions/_shared/crm-quote";
import { useEffect, useState } from "react";
import { ArrowUpRight, ChevronLeft, ChevronRight, FilePlus2, RefreshCw, Search } from "lucide-react";
import { getCompanyHistory, type CopilotReadResult } from "../../lib/copilotCentralApi";
import { useAuth } from "../auth/AuthContext";
import "./company-journey.css";

type Event = { id: string; section: string; source: string; date: string | null; title: string; detail: string; status: string;
  amount: number | null; currency: string | null; amountBasis: string | null; identity: string | null; href: string | null; observedAt: string | null };
type Journey = { sources: Record<string, { state: string; count: number | null; note: string; observedAt: string | null }>;
  events: Event[]; pendingTasks: { id: string; title: string; due_date: string | null }[]; pendingTaskCount: number | null; nextFollowUp: string | null };
const sections = [{ id: "all", label: "Todo" }, { id: "orders", label: "Pedidos" }, { id: "documents", label: "Facturas y notas" },
  { id: "quotes", label: "Cotizaciones" }, { id: "activity", label: "Actividad" }];
const sourceNames: Record<string, string> = { orders: "Tiendanube", documents: "Facto", quotes: "Cotizaciones CRM", activity: "Actividad CRM" };
const statusNames: Record<string, string> = { open: "Abierto", closed: "Cerrado", cancelled: "Cancelado", voided: "Anulado", validated: "Validado", posted: "Contabilizado", pending: "Pendiente", inconsistent: "Por revisar", duplicate: "Duplicado" };
const date = (value: string | null) => value ? value.slice(0, 10).split("-").reverse().join("/") : "Sin fecha";
const amount = (event: Event) => event.amount === null ? "Importe no disponible" : `${new Intl.NumberFormat("es-CL", { maximumFractionDigits: 2 }).format(event.amount)} ${event.currency || "(moneda pendiente)"}`;
const safeHref = (href: string | null) => {
  if (href?.startsWith("/finanzas-contabilidad?")) return href;
  try { const url = new URL(href || ""); return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : undefined; } catch { return undefined; }
};

export function CompanyJourney({ companyId, revision, onRegisterQuote, loadHistory = getCompanyHistory }: {
  companyId: string; revision: number; onRegisterQuote?: () => void; loadHistory?: typeof getCompanyHistory;
}) {
  const { user } = useAuth();
  const [period, setPeriod] = useState("this_year"), [section, setSection] = useState("all"), [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0), [refresh, setRefresh] = useState(0);
  const key = JSON.stringify([companyId, user?.id, user?.role, period, section, query, offset, refresh, revision]);
  const [response, setResponse] = useState<{ key: string; result?: CopilotReadResult; error?: string }>();
  const current = response?.key === key ? response : undefined;
  const result = current?.result, loading = !current, error = current?.error || "";
  useEffect(() => {
    if (!user) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => { controller.abort(); setResponse({ key, error: "La consulta excedio el tiempo disponible. Vuelve a intentar." }); }, 60000);
    const timer = setTimeout(() => {
      loadHistory(companyId, period, section, query, offset, controller.signal).then(value => {
        if (!controller.signal.aborted) setResponse({ key, result: value });
      }).catch(e => { if (!controller.signal.aborted) setResponse({ key, error: e instanceof Error ? e.message : "No se pudo leer el historial." }); })
        .finally(() => clearTimeout(timeout));
    }, 250);
    return () => { clearTimeout(timer); clearTimeout(timeout); controller.abort(); };
  }, [companyId, period, section, query, offset, key, user, loadHistory]);
  return <section className="company-journey" id="seguimiento" aria-label="Seguimiento comercial">
    <header className="company-journey-heading">
      <div><h2>Seguimiento comercial</h2><p>Responsable: Comercial</p></div>
      <div className="company-journey-actions">
        {onRegisterQuote && <button type="button" className="ghost-button" onClick={onRegisterQuote}><FilePlus2 size={17} /> Registrar cotizacion</button>}
        <button type="button" className="ghost-button company-insight-icon" title="Actualizar historial" aria-label="Actualizar historial" onClick={() => setRefresh(v => v + 1)} disabled={loading}><RefreshCw size={17} /></button>
      </div>
    </header>
    <div className="company-journey-filters">
      <label className="company-journey-search"><Search size={18} /><input aria-label="Buscar en historial comercial" placeholder="Folio, pedido o actividad" value={query} onChange={e => { setQuery(e.target.value); setOffset(0); }} /></label>
      <label>Periodo<select value={period} onChange={e => { setPeriod(e.target.value); setOffset(0); }}><option value="this_year">Año actual</option><option value="last_year">Año anterior</option><option value="all">Todo el historial disponible</option></select></label>
    </div>
    <div className="company-journey-tabs" role="tablist" aria-label="Tipo de registro">
      {sections.map((item, index) => <button key={item.id} id={`journey-tab-${item.id}`} type="button" role="tab" aria-controls="journey-records" aria-selected={section === item.id} tabIndex={section === item.id ? 0 : -1}
        onClick={() => { setSection(item.id); setOffset(0); }} onKeyDown={event => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const next = event.key === "Home" ? 0 : event.key === "End" ? sections.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + sections.length) % sections.length;
          setSection(sections[next].id); setOffset(0); document.getElementById(`journey-tab-${sections[next].id}`)?.focus();
        }}>{item.label}</button>)}
    </div>
    <div id="journey-records" role="tabpanel" aria-labelledby={`journey-tab-${section}`} aria-busy={loading}>
      <CompanyJourneyView result={result} loading={loading} error={error} section={section} />
    </div>
    {Boolean(result?.data) && result && <div className="company-insight-pagination">
      <span>{offset + (result.coverage.returned ? 1 : 0)}–{offset + result.coverage.returned} de {result.coverage.totalMatched ?? "?"}</span>
      <button className="ghost-button company-insight-icon" type="button" aria-label="Pagina anterior de historial" title="Pagina anterior" disabled={offset === 0 || loading} onClick={() => setOffset(v => Math.max(0, v - 20))}><ChevronLeft size={18} /></button>
      <button className="ghost-button company-insight-icon" type="button" aria-label="Pagina siguiente de historial" title="Pagina siguiente" disabled={result.coverage.nextOffset === undefined || loading} onClick={() => setOffset(result.coverage.nextOffset!)}><ChevronRight size={18} /></button>
    </div>}
  </section>;
}

export function CompanyJourneyView({ result, loading, error, section = "all" }: { result?: CopilotReadResult; loading: boolean; error: string; section?: string }) {
  if (loading) return <p className="company-insight-note" role="status">Consultando historial comercial...</p>;
  if (error) return <p className="company-insight-warning" role="alert">{error}</p>;
  if (!result?.data) return <p className="company-insight-warning">{result?.summary || "Historial no disponible."}</p>;
  const data = result.data as Journey;
  const visibleSources = Object.entries(data.sources).filter(([key]) => section === "all" || section === key);
  const unavailable = visibleSources.some(([, source]) => ["unavailable", "needs_review"].includes(source.state));
  return <>
    <div className="company-journey-next">
      <div><span>Proximo seguimiento</span><strong>{data.nextFollowUp ? date(data.nextFollowUp) : "Sin fecha registrada"}</strong></div>
      <div><span>Tareas pendientes (todos los periodos)</span><strong>{data.pendingTaskCount ?? "No disponible"}</strong></div>
    </div>
    {data.pendingTasks.length > 0 && <details className="company-journey-tasks"><summary>Seguimientos por completar</summary><ul>{data.pendingTasks.map(task => <li key={task.id}><time>{date(task.due_date)}</time> {task.title}</li>)}</ul>{data.pendingTaskCount! > data.pendingTasks.length && <p>Se muestran las primeras {data.pendingTasks.length} tareas pendientes.</p>}</details>}
    <details className="company-journey-source-details" open={unavailable}>
      <summary>Fuentes del historial<small>{visibleSources.map(([key, state]) => `${sourceNames[key]}: ${state.count ?? (state.state === "forbidden" ? "restringido" : "por verificar")}`).join(" · ")}</small></summary>
      <div className="company-journey-sources">
      {visibleSources.map(([key, state]) => <div key={key}>
        <strong>{sourceNames[key]}</strong><span>{state.state === "available" ? `${state.count} registros en periodo` : state.state === "forbidden" ? "Acceso restringido" : "Pendiente de verificar"}</span>
        <small>{state.note}{state.observedAt ? ` Ultimo registro sincronizado: ${date(state.observedAt)}.` : ""}</small>
      </div>)}
      </div>
    </details>
    {!data.events.length ? <p className="company-insight-note">Sin coincidencias verificadas para estos filtros.</p> : <ol className="company-journey-events">
      {data.events.map(event => <li key={event.id}>
        <div className="company-journey-event-date"><time>{date(event.date)}</time><span>{event.source}</span></div>
        <div className="company-journey-event-body"><strong>{event.title}</strong><span className="company-journey-state">{statusNames[event.status] || event.status}</span><QuoteRecordDetail detail={event.detail} id={event.id} title={event.title} />
          {event.identity && <small>{event.identity}</small>}
          {safeHref(event.href) && <a href={safeHref(event.href)} target="_blank" rel="noreferrer">{event.section === "documents" ? "Ver documento en CRM" : "Abrir referencia"} <ArrowUpRight size={14} /></a>}
        </div>
        <div className="company-journey-event-amount">{event.amountBasis && <><strong>{amount(event)}</strong><small>{event.amountBasis}</small></>}</div>
      </li>)}
    </ol>}
    <details className="company-insight-evidence"><summary>Fuentes y limites del historial</summary><ul>{result.warnings.map(w => <li key={w}>{w}</li>)}</ul></details>
  </>;
}

function QuoteRecordDetail({detail,id,title}:{detail:string;id:string;title:string}) {
 const [error,setError]=useState('');const [busy,setBusy]=useState(false);
 if(!title.startsWith('Cotización CRM-')||!id.startsWith('interaction:'))return <p>{detail}</p>;
 return <div><p>Cotización comercial guardada en el CRM.</p><button className="ghost-button" type="button" style={{minHeight:44}} disabled={busy} onClick={()=>void (async()=>{setBusy(true);setError('');try{const {quote}=await whatsappRequest<{quote:CrmQuote}>('whatsapp-quote-record?id='+encodeURIComponent(id.slice('interaction:'.length)));const file=await crmQuotePdf(quote);const url=URL.createObjectURL(file);const a=document.createElement('a');a.href=url;a.download=file.name;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);}catch(e){setError(e instanceof Error?e.message:'No se pudo descargar la cotización.');}finally{setBusy(false);}})()}>{busy?'Preparando PDF...':'Descargar cotización PDF'}</button>{error&&<p role="alert">{error}</p>}</div>;
}
