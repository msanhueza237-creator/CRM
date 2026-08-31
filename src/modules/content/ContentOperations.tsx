import { useState } from "react";
import { AlertTriangle, BarChart3, CheckCircle2, Download, Eye, FileSpreadsheet, History, Send } from "lucide-react";
import { approveContentPublication, publishContentPublication } from "../../lib/contentCenterApi";
import type { ContentPublication } from "../../types/content";
import { useAuth } from "../auth/AuthContext";
import { ContentMediaGallery } from "./ContentMediaGallery";
import { getPublicationMediaUrls } from "./contentMedia";
import type { ContentCenterData } from "./useContentCenter";

export function ContentPublications({ data }: { data: ContentCenterData }) {
  const { user } = useAuth();
  const [status, setStatus] = useState("");
  const [channelId, setChannelId] = useState("");
  const [selected, setSelected] = useState<ContentPublication | null>(null);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const filtered = data.publications.filter((item) => (!status || item.status === status) && (!channelId || item.channel_id === channelId));

  async function action(kind: "approve" | "publish", publication: ContentPublication) {
    setBusy(`${kind}-${publication.id}`); setError(""); setNotice("");
    try {
      const result = kind === "approve"
        ? await approveContentPublication(publication.id)
        : await publishContentPublication(publication.id);
      setSelected(result.publication);
      if (result.publication.error_message) setError(result.publication.error_message);
      else setNotice(kind === "approve" ? "Contenido aprobado." : "Publicación procesada por Meta.");
      await data.refresh();
    } catch (actionError) { setError(actionError instanceof Error ? actionError.message : "No se pudo completar la acción."); }
    finally { setBusy(""); }
  }

  return <div className="content-view-stack"><section className="content-calendar-filters"><label><span>Estado</span><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">Todos</option><option value="draft">Borrador</option><option value="pending_approval">Pendiente de aprobación</option><option value="approved">Aprobado</option><option value="scheduled">Programado</option><option value="published">Publicado</option><option value="failed">Error</option></select></label><label><span>Canal</span><select value={channelId} onChange={(event) => setChannelId(event.target.value)}><option value="">Todos</option>{data.bootstrap?.channels.map((channel) => <option key={channel.id} value={channel.id}>{channel.name}</option>)}</select></label><strong>{filtered.length} publicaciones</strong></section>{notice ? <div className="notice-banner success">{notice}</div> : null}{error ? <div className="notice-banner error">{error}</div> : null}<section className="panel content-publication-table"><div className="table-scroll"><table><thead><tr><th>Contenido</th><th>Producto</th><th>Canal</th><th>Estado</th><th>Fecha</th><th>Acciones</th></tr></thead><tbody>{filtered.map((publication) => <tr key={publication.id}><td><strong>{publication.body.slice(0, 90)}{publication.body.length > 90 ? "..." : ""}</strong><span>{publication.hashtags.slice(0, 3).map((tag) => `#${tag}`).join(" ")}</span></td><td>{productName(data, publication.product_id)}</td><td>{channelName(data, publication.channel_id)}</td><td><span className={`content-state ${publication.status}`}>{statusLabel(publication.status)}</span>{publication.error_code ? <small>{publication.error_code}</small> : null}</td><td>{formatDateTime(publication.published_at || publication.scheduled_at || publication.created_at)}</td><td><div className="content-table-actions"><button className="icon-button" type="button" title="Ver detalle" onClick={() => setSelected(publication)}><Eye size={16} /></button>{user?.role === "administrador" && ["draft", "pending_approval"].includes(publication.status) ? <button className="icon-button" type="button" title="Aprobar" disabled={Boolean(busy)} onClick={() => void action("approve", publication)}><CheckCircle2 size={16} /></button> : null}{user?.role === "administrador" && ["approved", "failed"].includes(publication.status) ? <button className="icon-button" type="button" title="Publicar" disabled={Boolean(busy)} onClick={() => void action("publish", publication)}><Send size={16} /></button> : null}</div></td></tr>)}</tbody></table></div>{!filtered.length ? <div className="empty-state"><Send size={28} /><span>No hay publicaciones con estos filtros.</span></div> : null}</section>{selected ? <PublicationDetail publication={selected} data={data} onClose={() => setSelected(null)} /> : null}</div>;
}

function PublicationDetail({ publication, data, onClose }: { publication: ContentPublication; data: ContentCenterData; onClose: () => void }) {
  const product = data.products.find((item) => item.id === publication.product_id);
  const images = getPublicationMediaUrls(publication, product);
  return <section className="panel content-publication-detail"><div className="panel-heading"><div><h2>{productName(data, publication.product_id)}</h2><span>{channelName(data, publication.channel_id)} · {statusLabel(publication.status)}</span></div><button className="ghost-button" type="button" onClick={onClose}>Cerrar</button></div><div className="content-publication-preview"><ContentMediaGallery images={images} alt={product?.name || "Producto"} /><div><p>{publication.body}</p><div className="content-hashtags">{publication.hashtags.map((tag) => <span key={tag}>#{tag}</span>)}</div>{publication.cta ? <strong>{publication.cta}</strong> : null}</div></div><dl className="content-facts"><div><dt>Modelo</dt><dd>{publication.model_name || "No informado"}</dd></div><div><dt>Creado</dt><dd>{formatDateTime(publication.created_at)}</dd></div><div><dt>Programado</dt><dd>{formatDateTime(publication.scheduled_at)}</dd></div><div><dt>Publicado</dt><dd>{formatDateTime(publication.published_at)}</dd></div><div><dt>ID externo</dt><dd>{publication.external_id || "Pendiente"}</dd></div><div><dt>Reintentos</dt><dd>{publication.retry_count}</dd></div></dl>{publication.error_message ? <div className="notice-banner error"><AlertTriangle size={18} /> {friendlyMetaError(publication.error_message)}</div> : null}</section>;
}

export function ContentHistory({ data }: { data: ContentCenterData }) {
  const [level, setLevel] = useState("");
  const [category, setCategory] = useState("");
  const [query, setQuery] = useState("");
  const rows = data.history.filter((event) => (!level || event.level === level) && (!category || historyCategory(event.event_type) === category) && (!query || `${event.message} ${event.event_type} ${historyEventLabel(event.event_type)}`.toLowerCase().includes(query.toLowerCase())));
  return <div className="content-view-stack"><div className="notice-banner"><History size={18} /><div><strong>Historial de operaciones</strong><span>Las consultas de metricas revisan publicaciones anteriores; no crean ni publican contenido nuevo.</span></div></div><section className="content-calendar-filters"><label><span>Buscar</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Evento o mensaje" /></label><label><span>Tipo</span><select value={category} onChange={(event) => setCategory(event.target.value)}><option value="">Todos</option><option value="publication">Publicaciones</option><option value="metrics">Metricas</option><option value="system">Sistema</option></select></label><label><span>Nivel</span><select value={level} onChange={(event) => setLevel(event.target.value)}><option value="">Todos</option><option value="info">Información</option><option value="warning">Advertencia</option><option value="error">Error</option></select></label></section><section className="panel content-history-timeline">{rows.map((event) => <article key={event.id} className={event.level}><div>{event.level === "error" ? <AlertTriangle size={18} /> : event.level === "warning" ? <AlertTriangle size={18} /> : <CheckCircle2 size={18} />}</div><div><strong>{historyMessage(event.event_type, event.message)}</strong><span>{historyEventLabel(event.event_type)} · {event.actor_type}{event.actor_id ? ` · ${event.actor_id}` : ""}</span>{Object.keys(event.metadata).length ? <details><summary>Detalle técnico</summary><pre>{JSON.stringify(event.metadata, null, 2)}</pre></details> : null}</div><time>{formatDateTime(event.created_at)}</time></article>)}{!rows.length ? <div className="empty-state"><History size={28} /><span>No hay eventos con estos filtros.</span></div> : null}</section></div>;
}

export function ContentStatistics({ data }: { data: ContentCenterData }) {
  const [exporting, setExporting] = useState("");
  const published = data.publications.filter((item) => item.status === "published");
  const byChannel = aggregate(published, (item) => channelName(data, item.channel_id));
  const byProduct = aggregate(published, (item) => productName(data, item.product_id)).slice(0, 8);
  const byCategory = aggregate(published, (item) => data.products.find((product) => product.id === item.product_id)?.category || "Sin categoría").slice(0, 8);
  const impressions = data.metrics.reduce((sum, row) => sum + Number(row.impressions || 0), 0);
  const engagement = data.metrics.length ? data.metrics.reduce((sum, row) => sum + Number(row.engagement_rate || 0), 0) / data.metrics.length : 0;
  const errors = data.publications.filter((item) => item.status === "failed").length;

  async function exportExcel() {
    setExporting("excel");
    const ExcelJS = await import("exceljs");
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Publicaciones");
    sheet.columns = [{ header: "Producto", key: "product", width: 42 }, { header: "Canal", key: "channel", width: 16 }, { header: "Estado", key: "status", width: 20 }, { header: "Fecha", key: "date", width: 24 }, { header: "Texto", key: "body", width: 80 }, { header: "Impresiones", key: "impressions", width: 16 }, { header: "Interacción", key: "engagement", width: 16 }];
    data.publications.forEach((publication) => { const metric = data.metrics.find((item) => item.publication_id === publication.id); sheet.addRow({ product: productName(data, publication.product_id), channel: channelName(data, publication.channel_id), status: statusLabel(publication.status), date: publication.published_at || publication.scheduled_at || publication.created_at, body: publication.body, impressions: metric?.impressions || 0, engagement: metric?.engagement_rate || 0 }); });
    sheet.getRow(1).font = { bold: true };
    downloadBlob(new Blob([await workbook.xlsx.writeBuffer()], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), "estadisticas-contenido.xlsx");
    setExporting("");
  }

  async function exportPdf() {
    setExporting("pdf");
    const { jsPDF } = await import("jspdf");
    const pdf = new jsPDF();
    pdf.setFontSize(18); pdf.text("Centro de Contenido - Informe ejecutivo", 14, 20);
    pdf.setFontSize(10); pdf.text(`Generado: ${new Intl.DateTimeFormat("es-CL", { dateStyle: "full", timeStyle: "short" }).format(new Date())}`, 14, 29);
    pdf.setFontSize(12); pdf.text(`Publicaciones: ${published.length}`, 14, 43); pdf.text(`Impresiones: ${impressions.toLocaleString("es-CL")}`, 14, 51); pdf.text(`Engagement promedio: ${engagement.toFixed(2)}%`, 14, 59); pdf.text(`Errores: ${errors}`, 14, 67);
    pdf.setFontSize(14); pdf.text("Publicaciones por canal", 14, 82); pdf.setFontSize(10); byChannel.forEach((row, index) => pdf.text(`${row.label}: ${row.value}`, 18, 91 + index * 8));
    pdf.setFontSize(14); pdf.text("Productos más utilizados", 14, 120); pdf.setFontSize(10); byProduct.slice(0, 8).forEach((row, index) => pdf.text(`${index + 1}. ${row.label}: ${row.value}`, 18, 129 + index * 8));
    pdf.save("estadisticas-contenido.pdf"); setExporting("");
  }

  return <div className="content-view-stack"><section className="content-stat-actions"><div><h2>Rendimiento del contenido</h2><span>Métricas disponibles desde los conectores sociales</span></div><button className="ghost-button" type="button" disabled={Boolean(exporting)} onClick={() => void exportPdf()}><Download size={17} /> PDF</button><button className="ghost-button" type="button" disabled={Boolean(exporting)} onClick={() => void exportExcel()}><FileSpreadsheet size={17} /> Excel</button></section><section className="content-kpi-grid"><StatKpi label="Publicaciones" value={published.length.toLocaleString("es-CL")} /><StatKpi label="Impresiones" value={impressions.toLocaleString("es-CL")} /><StatKpi label="Engagement" value={`${engagement.toFixed(2)}%`} /><StatKpi label="Errores" value={errors.toLocaleString("es-CL")} /></section><section className="content-stat-grid"><BarPanel title="Publicaciones por canal" rows={byChannel} /><BarPanel title="Productos más utilizados" rows={byProduct} /><BarPanel title="Distribución por categoría" rows={byCategory} /><TrendPanel data={data} /></section></div>;
}

function BarPanel({ title, rows }: { title: string; rows: Array<{ label: string; value: number }> }) { const max = Math.max(1, ...rows.map((row) => row.value)); return <section className="panel content-bar-panel"><div className="panel-heading"><h2>{title}</h2><BarChart3 size={19} /></div>{rows.map((row) => <div key={row.label}><span title={row.label}>{row.label}</span><div><i style={{ width: `${Math.max(3, (row.value / max) * 100)}%` }} /></div><strong>{row.value}</strong></div>)}{!rows.length ? <div className="empty-state"><BarChart3 size={25} /><span>Aún no hay publicaciones suficientes.</span></div> : null}</section>; }
function TrendPanel({ data }: { data: ContentCenterData }) { const months = Array.from({ length: 6 }, (_, index) => { const date = new Date(); date.setMonth(date.getMonth() - (5 - index)); return { key: `${date.getFullYear()}-${date.getMonth()}`, label: new Intl.DateTimeFormat("es-CL", { month: "short" }).format(date), value: data.publications.filter((item) => { const value = new Date(item.published_at || item.created_at); return item.status === "published" && `${value.getFullYear()}-${value.getMonth()}` === `${date.getFullYear()}-${date.getMonth()}`; }).length }; }); const max = Math.max(1, ...months.map((month) => month.value)); return <section className="panel content-trend-panel"><div className="panel-heading"><h2>Evolución temporal</h2><span>Últimos 6 meses</span></div><div className="content-column-chart">{months.map((month) => <div key={month.key}><strong>{month.value}</strong><i style={{ height: `${Math.max(4, (month.value / max) * 100)}%` }} /><span>{month.label}</span></div>)}</div></section>; }
function StatKpi({ label, value }: { label: string; value: string }) { return <article><BarChart3 /><span>{label}</span><strong>{value}</strong><small>Centro de Contenido</small></article>; }
function aggregate(rows: ContentPublication[], label: (row: ContentPublication) => string) { const values = new Map<string, number>(); rows.forEach((row) => values.set(label(row), (values.get(label(row)) || 0) + 1)); return [...values.entries()].map(([item, value]) => ({ label: item, value })).sort((left, right) => right.value - left.value); }
function productName(data: ContentCenterData, id: string | null) { return data.products.find((item) => item.id === id)?.name || "Sin producto"; }
function channelName(data: ContentCenterData, id: string) { return data.bootstrap?.channels.find((item) => item.id === id)?.name || "Canal"; }
function statusLabel(status: string) { return ({ draft: "Borrador", pending_approval: "Pendiente de aprobación", approved: "Aprobado", scheduled: "Programado", publishing: "Publicando", published: "Publicado", failed: "Error", paused: "Pausado", cancelled: "Cancelado" } as Record<string, string>)[status] || status; }
function historyCategory(eventType: string) { if (eventType.startsWith("metrics_")) return "metrics"; if (/publish|content_(?:approved|rejected|scheduled|published)/.test(eventType)) return "publication"; return "system"; }
function historyEventLabel(eventType: string) { return ({ publish_failed: "Publicacion fallida", content_published: "Publicacion realizada", content_approved: "Publicacion aprobada", content_rejected: "Borrador rechazado", content_scheduled: "Publicacion programada", metrics_synced: "Metricas actualizadas", metrics_sync_failed: "Metricas no actualizadas", catalog_synced: "Catalogo sincronizado" } as Record<string, string>)[eventType] || eventType.replace(/_/g, " "); }
function friendlyMetaError(message: string) { return /session has expired|error validating access token/i.test(message) ? "El token de Meta Social vencio. Actualiza META_SOCIAL_ACCESS_TOKEN con un token de pagina de larga duracion, comprueba la conexion en Administracion y vuelve a publicar." : message; }
function historyMessage(eventType: string, message: string) { if (eventType === "metrics_sync_failed" && !/no fue un intento de publicar/i.test(message)) return `No se pudieron actualizar las metricas de una publicacion anterior. No fue un intento de publicar contenido. ${friendlyMetaError(message)}`; return friendlyMetaError(message); }
function formatDateTime(value: string | null) { return value ? new Intl.DateTimeFormat("es-CL", { dateStyle: "short", timeStyle: "short" }).format(new Date(value)) : "Sin fecha"; }
function downloadBlob(blob: Blob, fileName: string) { const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = fileName; anchor.click(); URL.revokeObjectURL(url); }
