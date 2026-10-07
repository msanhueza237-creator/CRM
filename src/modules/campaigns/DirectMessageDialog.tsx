import { useEffect, useRef, useState } from "react";
import { Mail, MessageCircle, Search, Send, X } from "lucide-react";
import { getMessageRecipients, getDirectEmailHistory, sendDirectMessage, type MessageRecipient } from "../../lib/directMessageApi";
import { getGmailStatus, type GmailStatus } from "../../lib/gmailApi";
import { WhatsAppConversationDialog } from "./WhatsAppConversationDialog";
import { MessageAttachments } from "./MessageAttachments";
import "./whatsapp-conversation.css";

const key = (r: MessageRecipient) => `${r.companyId}:${r.contactId}`;
const normalize = (v: string) => v.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
export function DirectMessageDialog({ companyId, initialChannel = "whatsapp", onClose }: { companyId?: string; initialChannel?: "whatsapp" | "email"; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null); const busy = useRef(false); const requestId = useRef<string | null>(null);
  const [recipients, setRecipients] = useState<MessageRecipient[]>([]); const [selected, setSelected] = useState("");
  const [query, setQuery] = useState(""); const [channel, setChannel] = useState(initialChannel);
  const [conversation, setConversation] = useState<MessageRecipient | null>(null);
  const [subject, setSubject] = useState(""); const [text, setText] = useState(""); const [files, setFiles] = useState<File[]>([]);
  const [loading, setLoading] = useState(true); const [sending, setSending] = useState(false); const [review, setReview] = useState(false);
  const [error, setError] = useState(""); const [notice, setNotice] = useState(""); const [gmail, setGmail] = useState<GmailStatus | null>(null);
  const [history, setHistory] = useState<Awaited<ReturnType<typeof getDirectEmailHistory>>>([]); const [historyError, setHistoryError] = useState(""); const [historyLoading, setHistoryLoading] = useState(false);
  const [revision, setRevision] = useState(0); const [uncertain, setUncertain] = useState(false);
  const recipient = recipients.find(r => key(r) === selected);
  useEffect(() => {
    let active = true; dialog.current?.showModal();
    getMessageRecipients().then(result => { if (!active) return; setRecipients(result.recipients); if (companyId) { const initial = result.recipients.find(r => r.companyId === companyId && !r.contactId) || result.recipients.find(r => r.companyId === companyId); if (initial) setSelected(key(initial)); } })
      .catch(err => { if (active) setError(err.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [companyId]);
  useEffect(() => {
    if (channel !== "email") return;
    let active = true; setGmail(null); setHistory([]); setHistoryError(""); setHistoryLoading(true);
    getGmailStatus().then(value => { if (active) setGmail(value); }).catch(err => { if (active) setHistoryError(err.message); });
    if (recipient?.email) getDirectEmailHistory(recipient).then(rows => { if (active) setHistory(rows); }).catch(err => { if (active) setHistoryError(err.message); }).finally(() => { if (active) setHistoryLoading(false); });
    else setHistoryLoading(false);
    return () => { active = false; };
  }, [channel, selected, revision, recipients]);
  const pending = history.some(message => message.status === "pending");
  const filtered = recipients.filter(r => normalize(`${r.companyName} ${r.name} ${r.phone} ${r.email}`).includes(normalize(query)));
  const locked = sending || uncertain;
  const canEmail = Boolean(recipient?.email && gmail?.connected && gmail.sentToday < gmail.dailyLimit && !pending && !historyError && !historyLoading && !locked);
  async function sendEmail() {
    if (!recipient || !canEmail || !review || busy.current) return;
    busy.current = true; setSending(true); setNotice(""); setError(""); requestId.current ||= crypto.randomUUID();
    try {
      const result = await sendDirectMessage("email", { companyId: recipient.companyId, contactId: recipient.contactId, email: recipient.email,
        subject, text, requestId: requestId.current, confirmSend: true }, files);
      setNotice(result.warning || "Correo aceptado por Gmail.");
      if (result.accepted) { setText(""); setSubject(""); setFiles([]); setReview(false); requestId.current = null; }
      else if (result.outcome === "rejected") { requestId.current = null; setReview(false); }
      else setUncertain(true);
    } catch (err) { setError(`${(err as Error).message} Revisa el historial antes de intentar otro envio.`); setUncertain(true); }
    finally { busy.current = false; setSending(false); setRevision(v => v + 1); }
  }
  if (conversation) return <WhatsAppConversationDialog companyId={conversation.companyId} contactId={conversation.contactId} phone={conversation.phone} onClose={onClose} />;
  return <dialog ref={dialog} className="wa-conversation direct-message" aria-labelledby="direct-title" onCancel={event => { event.preventDefault(); if (!busy.current) onClose(); }}>
    <header><h2 id="direct-title">Nuevo mensaje</h2><button className="ghost-button" title="Cerrar" aria-label="Cerrar nuevo mensaje" disabled={sending} onClick={onClose}><X size={20} /></button></header>
    <div className="direct-body">
      <label className="direct-search"><Search size={18} /><input aria-label="Buscar cliente o contacto" placeholder="Cliente, contacto, correo o telefono" value={query} disabled={locked || review} onChange={event => setQuery(event.target.value)} /></label>
      <label>Destinatario<select aria-label="Destinatario" value={selected} disabled={loading || locked || review} onChange={event => { setSelected(event.target.value); setNotice(""); setError(""); }}>
        <option value="">{loading ? "Cargando contactos..." : "Seleccionar cliente o contacto"}</option>
        {recipient && !filtered.includes(recipient) && <option value={key(recipient)}>{recipient.companyName} · {recipient.name}</option>}
        {filtered.map(r => <option key={key(r)} value={key(r)}>{r.companyName}{r.name !== r.companyName ? ` · ${r.name}` : ""}{r.contactId ? " (contacto)" : " (empresa)"} · {r.email || r.phone || "Sin datos de contacto"}</option>)}
      </select></label>
      {!loading && <small>{filtered.length} clientes y contactos encontrados</small>}
      <div className="direct-channels" role="group" aria-label="Canal de mensaje">
        <button type="button" aria-pressed={channel === "whatsapp"} disabled={locked || review} onClick={() => setChannel("whatsapp")}><MessageCircle size={18} /> WhatsApp</button>
        <button type="button" aria-pressed={channel === "email"} disabled={locked || review} onClick={() => setChannel("email")}><Mail size={18} /> Correo</button>
      </div>
      {recipient && <p className="direct-destination"><strong>{recipient.name}</strong><span>{channel === "whatsapp" ? recipient.phone ? `+${recipient.phone}` : "Sin numero registrado" : recipient.email || "Sin correo registrado"}</span></p>}
      {channel === "whatsapp" ? <button className="primary-button" disabled={!recipient?.phone || loading} onClick={() => { if (recipient) { dialog.current?.close(); setConversation(recipient); } }}><MessageCircle size={18} /> Abrir conversacion</button> : <>
        <p className="direct-account">{gmail?.connected ? `Desde ${gmail.connectedEmail} · ${gmail.sentToday}/${gmail.dailyLimit} envios hoy` : "Gmail no disponible"}</p>
        <label>Asunto<input maxLength={200} value={subject} disabled={locked || review} onChange={event => setSubject(event.target.value)} /></label>
        <label>Mensaje<textarea rows={5} maxLength={20000} value={text} disabled={locked || review} onChange={event => setText(event.target.value)} /></label>
        <MessageAttachments files={files} onChange={setFiles} disabled={locked || review} />
        {pending && <p className="wa-alert">Hay un envio pendiente de confirmar para este destinatario.</p>}
        {historyError && <p className="wa-alert" role="alert">{historyError}</p>}
        {review ? <div className="direct-review"><strong>Confirmar correo a {recipient?.email}</strong><p>{subject} · {files.length} adjunto(s)</p><div className="direct-actions"><button className="ghost-button" disabled={sending} onClick={() => setReview(false)}>Volver</button><button className="primary-button" disabled={!canEmail} onClick={() => void sendEmail()}><Send size={18} />{sending ? "Enviando..." : "Confirmar y enviar"}</button></div></div> : <button className="primary-button" disabled={!canEmail || !subject.trim() || !text.trim()} onClick={() => setReview(true)}><Send size={18} /> Revisar envio</button>}
        <details className="direct-history"><summary>Ultimos correos · {history.length}</summary>{history.map(message => <article key={message.id}><strong>{message.subject}</strong><p>{message.body_preview}</p><small>{new Date(message.created_at).toLocaleString("es-CL")} · {{ sent: "Aceptado por Gmail", pending: "Pendiente de confirmar", failed: "No enviado" }[message.status] || message.status}</small></article>)}</details>
      </>}
      {error && <p className="wa-alert" role="alert">{error}</p>}{notice && <p className="wa-alert" role="status">{notice}</p>}
    </div>
  </dialog>;
}
