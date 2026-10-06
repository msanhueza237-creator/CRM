import { useEffect, useRef, useState } from "react";
import { MessageCircle, RefreshCw, Send, X } from "lucide-react";
import { getWhatsAppConversation, sendWhatsAppReply, type WhatsAppConversation } from "../../lib/whatsappApi";
import "./whatsapp-conversation.css";

const statusLabels: Record<string, string> = { received: "Recibido", sent: "Aceptado por Meta", delivered: "Entregado", read: "Leido", failed: "No enviado", pending: "Pendiente de confirmar" };

export function WhatsAppConversationDialog({ companyId, phone, onClose }: { companyId: string; phone?: string; onClose: () => void }) {
  const [data, setData] = useState<WhatsAppConversation | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [now, setNow] = useState(Date.now());
  const dialog = useRef<HTMLDialogElement>(null);
  const busy = useRef(false);
  const requestId = useRef<string | null>(null);
  const active = useRef(true);
  const generation = useRef(0);
  const olderLoaded = useRef(false);
  const history = useRef<HTMLDivElement>(null);

  async function load(older = false, quiet = false) {
    if (quiet && olderLoaded.current) return;
    const serial = ++generation.current;
    if (!quiet) setLoading(true);
    try {
      const result = await getWhatsAppConversation(companyId, phone, older ? data?.nextOffset || 0 : 0);
      if (!active.current || serial !== generation.current) return;
      olderLoaded.current = older;
      setData(previous => ({ ...result, messages: older ? [...result.messages, ...(previous?.messages || [])].filter((m, i, all) => all.findIndex(v => v.id === m.id) === i) : result.messages }));
      setError("");
      if (!older && !quiet) requestAnimationFrame(() => history.current?.scrollTo({ top: history.current.scrollHeight }));
    } catch (err) {
      if (active.current && serial === generation.current) { setError(err instanceof Error ? err.message : "No se pudo leer la conversacion."); setData(previous => previous ? { ...previous, canReply: false } : null); }
    } finally { if (active.current && serial === generation.current) setLoading(false); }
  }

  useEffect(() => {
    active.current = true; dialog.current?.showModal(); void load();
    const timer = window.setInterval(() => { setNow(Date.now()); if (!document.hidden && !busy.current) void load(false, true); }, 15000);
    return () => { active.current = false; window.clearInterval(timer); };
  }, [companyId, phone]);

  async function send() {
    if (!data || !text.trim() || busy.current || !data.canReply || !data.expiresAt || Date.parse(data.expiresAt) <= Date.now()) return;
    busy.current = true; setSending(true); setNotice(""); setError("");
    requestId.current ||= crypto.randomUUID();
    try {
      const result = await sendWhatsAppReply({ companyId, phone: data.phone, text: text.trim(), requestId: requestId.current, confirmSend: true });
      setNotice(result.warning || "Mensaje aceptado por Meta.");
      if (result.accepted) { setText(""); requestId.current = null; }
      else if (result.outcome === "rejected") requestId.current = null;
    } catch (err) { setNotice(err instanceof Error ? err.message : "No se pudo confirmar el envio. No lo repitas sin revisar el historial."); }
    finally { busy.current = false; setSending(false); await load(); }
  }

  const open = Boolean(data?.canReply && data.expiresAt && Date.parse(data.expiresAt) > now);
  return <dialog ref={dialog} className="wa-conversation" aria-labelledby="wa-title" onCancel={event => { event.preventDefault(); if (!busy.current) onClose(); }}>
    <header><div><h2 id="wa-title"><MessageCircle size={20} /> {data?.name || "Conversacion WhatsApp"}</h2>{data && <p>+{data.phone}</p>}</div>
      <button type="button" className="ghost-button" aria-label="Cerrar conversacion" title="Cerrar conversacion" disabled={sending} onClick={onClose}><X size={20} /></button></header>
    <div className="wa-toolbar"><span>{open ? `Atencion abierta hasta ${new Date(data!.expiresAt!).toLocaleString("es-CL")}` : "Respuesta libre no disponible"}</span>
      <button type="button" className="ghost-button" aria-label="Actualizar conversacion" title="Actualizar conversacion" disabled={loading || sending} onClick={() => void load()}><RefreshCw size={18} /></button></div>
    {error && <p className="wa-alert" role="alert">{error}</p>}
    <div ref={history} className="wa-history" role="log" aria-label="Historial WhatsApp" aria-busy={loading}>
      {data?.nextOffset !== null && data?.nextOffset !== undefined && <button className="ghost-button" disabled={loading || sending} onClick={() => void load(true)}>Mensajes anteriores</button>}
      {!data && loading && <p>Cargando mensajes...</p>}
      {data?.messages.map(message => <article key={message.id} className={`wa-message wa-${message.direction}`}>
        <strong>{message.direction === "inbound" ? "Cliente" : "Climactiva"}{message.type === "order" ? " · Pedido" : ""}</strong>
        <p>{message.body}</p><small>{new Date(message.occurredAt).toLocaleString("es-CL")} · {statusLabels[message.status] || message.status}</small>
      </article>)}
    </div>
    <footer>{data?.reasons.map(reason => <p className="wa-alert" key={reason}>{reason}</p>)}
      {notice && <p className="wa-alert" role="status">{notice}</p>}
      <form onSubmit={event => { event.preventDefault(); void send(); }}><label htmlFor="wa-reply">Respuesta</label>
        <textarea id="wa-reply" rows={3} maxLength={4096} value={text} disabled={!open || sending || loading} onChange={event => setText(event.target.value)} />
        <div className="wa-send"><span>{text.length}/4096</span><button className="primary-button" type="submit" disabled={!open || sending || loading || !text.trim()}><Send size={18} /> {sending ? "Enviando..." : "Enviar respuesta"}</button></div>
      </form>
    </footer>
  </dialog>;
}
