import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronLeft, ChevronRight, ExternalLink, Mail, MessageCircle, Plus, RefreshCw, Search } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { DirectMessageDialog } from "../campaigns/DirectMessageDialog";
import { WhatsAppConversationDialog } from "../campaigns/WhatsAppConversationDialog";
import { setWhatsAppRead, type InboxConversation, type InboxFilter } from "../../lib/whatsappInboxApi";
import { useWhatsAppInbox } from "./useWhatsAppInbox";
import "./messages.css";

export function MessagesPage() {
  const { isDemoMode } = useAuth();
  const [query, setQuery] = useState(""); const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<InboxFilter>("all"); const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<InboxConversation | null>(null); const [compose, setCompose] = useState(false);
  const [writeError, setWriteError] = useState(""); const [saving, setSaving] = useState(false);
  const { data, error, loading, refresh } = useWhatsAppInbox(!isDemoMode, search, filter, offset);
  useEffect(() => { const timer = window.setTimeout(() => { setSearch(query.trim()); setOffset(0); }, 300); return () => window.clearTimeout(timer); }, [query]);
  useEffect(() => { if (data && offset > 0 && offset >= data.total) setOffset(Math.max(0, Math.floor((data.total - 1) / 30) * 30)); }, [data, offset]);
  async function markUnread(row: InboxConversation) {
    if (!row.latestInboundId || saving) return;
    setSaving(true); setWriteError("");
    try { await setWhatsAppRead(row.companyId, row.phone, [row.latestInboundId], false); }
    catch (err) { setWriteError(err instanceof Error ? err.message : "No se pudo guardar la lectura."); }
    finally { setSaving(false); }
  }
  const filters: Array<{ value: InboxFilter; label: string; count?: number }> = [
    { value: "all", label: "Todas", count: data?.summary.conversations },
    { value: "unread", label: "No leidas", count: data?.summary.unreadConversations },
    { value: "new", label: "Contactos nuevos", count: data?.summary.newContacts },
  ];
  return <section className="messages-page">
    <header className="messages-heading"><div><h1><MessageCircle size={25} /> Mensajes</h1><p>WhatsApp {data ? `· ${data.summary.unreadMessages} mensajes no leidos` : ""}</p></div>
      <div className="messages-actions"><button className="ghost-button" title="Actualizar mensajes" aria-label="Actualizar mensajes" disabled={loading || isDemoMode} onClick={refresh}><RefreshCw size={18} /></button><button className="primary-button" disabled={isDemoMode} onClick={() => setCompose(true)}><Plus size={18} /> Nuevo mensaje</button></div></header>
    <div className="messages-filters" role="group" aria-label="Filtrar conversaciones">{filters.map(item => <button type="button" key={item.value} aria-pressed={filter === item.value} onClick={() => { setFilter(item.value); setOffset(0); }}>{item.label}{item.count !== undefined && <span>{item.count}</span>}</button>)}</div>
    <label className="messages-search"><Search size={19} /><input aria-label="Buscar conversacion" placeholder="Nombre, empresa o telefono" maxLength={160} value={query} onChange={event => setQuery(event.target.value)} /></label>
    {isDemoMode && <p role="status">Inicia sesion para ver los mensajes de WhatsApp.</p>}
    {(error || writeError) && <p className="wa-alert" role="alert">{error || writeError}</p>}
    {loading && !data && <p role="status">Cargando conversaciones...</p>}
    <div className="messages-list" aria-busy={loading}>
      {data?.conversations.map(row => <article className={`messages-row${row.unreadCount ? " has-unread" : ""}`} key={`${row.companyId}:${row.phone}`}>
        <button className="messages-open" onClick={() => { setSelected(row); setWriteError(""); }} aria-label={`Abrir conversacion con ${row.name}`}>
          <div className="messages-row-top"><strong>{row.name}</strong><time dateTime={row.lastAt}>{new Date(row.lastAt).toLocaleString("es-CL", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })}</time></div>
          <span className="messages-identity">+{row.phone}{row.companyName !== row.name ? ` · ${row.companyName}` : ""}</span>
          <span className="messages-preview">{row.direction === "outbound" ? "Tu: " : ""}{row.preview}</span>
          <span className="messages-tags">{row.isNew && <span className="messages-new">Contacto nuevo</span>}{row.unreadCount > 0 && <span className="messages-unread">{row.unreadCount} no {row.unreadCount === 1 ? "leido" : "leidos"}</span>}</span>
        </button>
        <div className="messages-row-actions">{row.companyId && <Link to={`/empresas/${row.companyId}`} className="ghost-button" title="Ver ficha de empresa" aria-label={`Ver ficha de ${row.companyName}`}><ExternalLink size={17} /></Link>}
          {row.latestInboundId && !row.unreadCount && <button className="ghost-button" title="Marcar como no leido" aria-label={`Marcar como no leido: ${row.name}`} disabled={saving} onClick={() => void markUnread(row)}><Mail size={17} /></button>}</div>
      </article>)}
      {data && !data.conversations.length && !loading && <p className="messages-empty">{search ? "No hay conversaciones que coincidan." : filter === "unread" ? "No hay conversaciones sin leer." : filter === "new" ? "No hay contactos nuevos por atender." : "Todavia no hay conversaciones de WhatsApp."}</p>}
    </div>
    {data && data.total > 0 && <footer className="messages-pagination"><span>{offset + 1}–{Math.min(offset + 30, data.total)} de {data.total}</span><div><button className="ghost-button" title="Pagina anterior" aria-label="Pagina anterior" disabled={!offset || loading} onClick={() => setOffset(value => Math.max(0, value - 30))}><ChevronLeft size={18} /></button><button className="ghost-button" title="Pagina siguiente" aria-label="Pagina siguiente" disabled={offset + 30 >= data.total || loading} onClick={() => setOffset(value => value + 30)}><ChevronRight size={18} /></button></div></footer>}
    {selected && <WhatsAppConversationDialog key={`${selected.companyId}:${selected.phone}`} companyId={selected.companyId || ""} phone={selected.phone} onClose={() => { setSelected(null); refresh(); }} />}
    {compose && <DirectMessageDialog onClose={() => { setCompose(false); refresh(); }} />}
  </section>;
}
