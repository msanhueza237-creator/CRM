import { useEffect, useRef, useState } from "react";
import { MessageCircle, RefreshCw, Send, X } from "lucide-react";
import { getWhatsAppConversation, getWhatsAppTemplates, getWhatsAppAssistantPreview, type WhatsAppAssistantPreview, type MetaTemplate, type WhatsAppConversation } from "../../lib/whatsappApi";
import { sendDirectMessage } from "../../lib/directMessageApi";
import { notifyInboxChanged, setWhatsAppRead } from "../../lib/whatsappInboxApi";
import { WhatsAppQuotePanel } from "./WhatsAppQuotePanel";
import { MessageAttachments } from "./MessageAttachments";
import { useAuth } from "../auth/AuthContext";
import { WhatsAppConsent } from "../messages/WhatsAppConsent";
import { WhatsAppCatalogSelection } from "./WhatsAppCatalogSelection";
import { whatsAppContactBlocked } from "../../lib/whatsappConsent";
import "./whatsapp-conversation.css";

const statusLabels: Record<string, string> = { received: "Recibido", accepted: "Aceptado por Meta", sent: "Enviado", delivered: "Entregado", read: "Leído confirmado", failed: "Fallido", pending: "Pendiente de confirmar" };

export function WhatsAppConversationDialog({ companyId, phone, contactId = "", onClose }: { companyId: string; phone?: string; contactId?: string; onClose: () => void }) {
  const { user } = useAuth();
  const [data, setData] = useState<WhatsAppConversation | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [mode, setMode] = useState<"reply" | "template">("reply");
  const [templates, setTemplates] = useState<MetaTemplate[]>([]);
  const [templateId, setTemplateId] = useState("");
  const [parameters, setParameters] = useState<string[]>([]);
  const [templateError, setTemplateError] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [readError, setReadError] = useState("");
  const [quoteOpen, setQuoteOpen] = useState(false);
  const [assistant, setAssistant] = useState<WhatsAppAssistantPreview | null>(null);
  const [assistantLoading, setAssistantLoading] = useState(false);
  const [assistantError, setAssistantError] = useState("");
  const acknowledged = useRef(new Set<string>());
  const marking = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const busy = useRef(false);
  const requestId = useRef<string | null>(null);
  const active = useRef(true);
  const generation = useRef(0);
  const olderLoaded = useRef(false);
  const history = useRef<HTMLDivElement>(null);
  const latestInboundMessage = data?.messages.slice().reverse().find(m => m.direction === "inbound");
  const latestInbound = latestInboundMessage?.id;
  const assistantCurrent = Boolean(assistant?.messageId && assistant.messageId === latestInbound &&
    !(data?.lastOutboundAt && latestInboundMessage && Date.parse(data.lastOutboundAt) >= Date.parse(latestInboundMessage.occurredAt)));
  useEffect(() => { setAssistant(null); setAssistantError(""); }, [latestInbound, data?.lastOutboundAt]);
  async function suggest() {
    if (!data || assistantLoading || sending) return;
    setAssistantLoading(true); setAssistantError("");
    try {
      const result = await getWhatsAppAssistantPreview(companyId, data.phone, contactId);
      if (active.current) { setAssistant(result); if(result.plan.reason === "formal_quote_ready" && result.messageId === latestInbound) setQuoteOpen(true); }
    } catch (err) { if (active.current) setAssistantError(err instanceof Error ? err.message : "No se pudo preparar la propuesta."); }
    finally { if (active.current) setAssistantLoading(false); }
  }

  async function load(older = false, quiet = false) {
    const serial = ++generation.current;
    if (!quiet) setLoading(true);
    try {
      const result = await getWhatsAppConversation(companyId, phone, older ? data?.nextOffset || 0 : 0, contactId);
      if (!active.current || serial !== generation.current) return;
      const mergeHistory = older || (quiet && olderLoaded.current);
      if (!quiet) olderLoaded.current = older;
      setData(previous => ({ ...result, nextOffset: quiet && olderLoaded.current ? previous?.nextOffset ?? result.nextOffset : result.nextOffset,
        messages: mergeHistory ? [...result.messages, ...(previous?.messages || []).filter(m => !result.messages.some(v => v.id === m.id))].sort((a,b)=>Date.parse(a.occurredAt)-Date.parse(b.occurredAt)) : result.messages }));
      setError("");
      if (!older && !quiet) requestAnimationFrame(() => history.current?.scrollTo({ top: history.current.scrollHeight }));
    } catch (err) {
      if (active.current && serial === generation.current) { setError(err instanceof Error ? err.message : "No se pudo leer la conversacion."); setData(previous => previous ? { ...previous, canReply: false, canTemplate: false } : null); }
    } finally { if (active.current && serial === generation.current) setLoading(false); }
  }

  useEffect(() => {
    active.current = true; dialog.current?.showModal(); void load();
    const timer = window.setInterval(() => { setNow(Date.now()); if (!document.hidden && !busy.current) void load(false, true); }, 15000);
    return () => { active.current = false; window.clearInterval(timer); };
  }, [companyId, phone, contactId]);

  useEffect(() => {
    if (!data) return;
    let current = true;
    const markLoaded = async () => {
      if (document.hidden || marking.current || !current) return;
      const ids = data.messages.filter(m => m.direction === "inbound" && !acknowledged.current.has(m.id)).map(m => m.id);
      if (!ids.length) return;
      marking.current = true;
      try {
        for (let i = 0; i < ids.length && current; i += 50) {
          const batch = ids.slice(i, i + 50);
          await setWhatsAppRead(companyId || null, data.phone, batch, true);
          batch.forEach(id => acknowledged.current.add(id));
        }
        if (current) setReadError("");
      } catch { if (current) setReadError("No se pudo guardar la lectura. Se reintentara al actualizar."); }
      finally { marking.current = false; }
    };
    void markLoaded(); document.addEventListener("visibilitychange", markLoaded);
    return () => { current = false; document.removeEventListener("visibilitychange", markLoaded); };
  }, [data, companyId]);

  useEffect(() => {
    if (mode !== "template") return;
    let current = true; setTemplateError(""); setTemplates([]);
    getWhatsAppTemplates().then(result => { if (current) {
      if (!result.ready) setTemplateError(result.blockers.join(" "));
      setTemplates(result.templates.filter(t => t.status === "APPROVED" && !t.blockedReason));
    } }).catch(err => { if (current) setTemplateError(err.message); });
    return () => { current = false; };
  }, [mode]);
  const template = templates.find(t => `${t.id}:${t.language}` === templateId);
  const templateReady = Boolean(template && template.variables.every((_, i) => parameters[i]?.trim()) && data?.canTemplate && !templateError);

  async function send() {
    if (!data || busy.current || uncertain || (mode === "template" ? !templateReady : (!text.trim() && !files.length) || !data.canReply || !data.expiresAt || Date.parse(data.expiresAt) <= Date.now() || text.length > (files.length ? 1024 : 4096))) return;
    busy.current = true; setSending(true); setNotice(""); setError("");
    requestId.current ||= crypto.randomUUID();
    try {
      const result = await sendDirectMessage("whatsapp", { companyId, contactId, phone: data.phone, text: text.trim(), mode,
        templateId: template?.id, language: template?.language, templateVersion: template?.versionKey, parameters, requestId: requestId.current, confirmSend: true }, mode === "template" ? [] : files);
      setNotice(result.warning || "Mensaje aceptado por Meta.");
      if (result.accepted) { setText(""); setFiles([]); requestId.current = null; }
      else if (result.outcome === "rejected") requestId.current = null;
      else setUncertain(true);
    } catch (err) { setNotice(err instanceof Error ? err.message : "No se pudo confirmar el envio. No lo repitas sin revisar el historial."); setUncertain(true); }
    finally { busy.current = false; setSending(false); notifyInboxChanged(); await load(); }
  }

  const open = Boolean(data?.canReply && data.expiresAt && Date.parse(data.expiresAt) > now);
  const windowOpen = Boolean(data?.expiresAt && Date.parse(data.expiresAt)>now);
  const contactBlocked = whatsAppContactBlocked(data?.consent);
  const minutes = data?.expiresAt ? Math.max(0, Math.floor((Date.parse(data.expiresAt)-now)/60000)) : 0;
  return <dialog ref={dialog} className="wa-conversation" aria-labelledby="wa-title" onCancel={event => { event.preventDefault(); if (!busy.current) onClose(); }}>
    <header><div><h2 id="wa-title"><MessageCircle size={20} /> {data?.name || "Conversacion WhatsApp"}</h2>{data && <p>+{data.phone}</p>}</div>
      <button type="button" className="ghost-button" aria-label="Cerrar conversacion" title="Cerrar conversacion" disabled={sending} onClick={onClose}><X size={20} /></button></header>
    <div className="wa-toolbar"><span className={`wa-window-status ${windowOpen?"wa-window-open":"wa-window-closed"}`}><strong>{windowOpen?"VENTANA ABIERTA":"VENTANA CERRADA"}</strong><small>{windowOpen?`Quedan aproximadamente ${Math.floor(minutes/60)} h ${minutes%60} min`:"Se requiere plantilla aprobada por Meta."}</small></span>
      <button type="button" className="ghost-button" aria-label="Actualizar conversacion" title="Actualizar conversacion" disabled={loading || sending} onClick={() => void load()}><RefreshCw size={18} /></button></div>
    {error && <p className="wa-alert" role="alert">{error}</p>}
    {readError && <p className="wa-alert" role="status">{readError}</p>}
    {contactBlocked && <p className="wa-alert" role="status"><strong>No contactable por WhatsApp</strong>{data?.consent?.status === "opt_out" ? ". Baja registrada. No se permiten mensajes ni plantillas." : ". Los envíos están bloqueados."}</p>}
    <div ref={history} className="wa-history" role="log" aria-label="Historial WhatsApp" aria-busy={loading}>
      {data?.nextOffset !== null && data?.nextOffset !== undefined && <button className="ghost-button" disabled={loading || sending} onClick={() => void load(true)}>Mensajes anteriores</button>}
      {!data && loading && <p>Cargando mensajes...</p>}
      {data?.messages.map(message => <article key={message.id} className={`wa-message wa-${message.direction}`}>
        <strong>{message.direction === "inbound" ? "Cliente" : "Climactiva"}{message.type === "order" ? " · Pedido" : ""}</strong>
        {message.catalogSelection ? <>{message.catalogSelection.kind !== "order" && <p>{message.body}</p>}<WhatsAppCatalogSelection selection={message.catalogSelection} /></> : <p>{message.body}</p>}
        <small>{new Date(message.occurredAt).toLocaleString("es-CL")} · {statusLabels[message.status] || message.status}</small>
      </article>)}
    </div>
    <footer>
      {companyId && <section aria-label="Asistente de respuesta" className="wa-template-preview wa-response-assistant">
        <strong>Asistente de respuesta</strong>
        <button type="button" className="ghost-button" disabled={!open || loading || sending || assistantLoading || uncertain} onClick={() => void suggest()}>{assistantLoading ? "Consultando catálogo..." : "Proponer respuesta"}</button>
        {assistantError && <p role="alert">{assistantError}</p>}
        {assistantCurrent && assistant?.plan.text && <><p>{assistant.plan.text}</p><small>{assistant.plan.source === "tiendanube" ? "Fuente: catálogo de Tiendanube." : "Propuesta para revisar."}</small>
          <button type="button" className="ghost-button" disabled={!open || sending || loading || uncertain || mode !== "reply" || Boolean(text.trim()) || Boolean(files.length)} onClick={() => { setText(assistant.plan.text || ""); }}>Usar propuesta</button></>}
        {assistantCurrent && !assistant?.plan.text && <p>{assistant?.plan.requires === "vision" ? "Esta imagen necesita identificación antes de responder." : assistant?.plan.requires === "transcription" ? "Este audio necesita transcripción antes de responder." : assistant?.plan.requires === "facto_quote" ? "Usa Preparar cotización PDF para revisar los datos y generar el documento del CRM." : assistant?.plan.requires === "verified_order" ? "Verifica el pedido o las condiciones de despacho antes de responder." : "No hay datos suficientes para proponer una respuesta fiable. Revisa la consulta."}</p>}
        {assistant && !assistantCurrent && <p>La conversación cambió. Consulta una propuesta para el último mensaje.</p>}
      </section>}
      {companyId && assistantCurrent && assistant?.plan.reason === "formal_quote_ready" && !quoteOpen && <button type="button" className="ghost-button wa-quote-open" disabled={loading || sending || uncertain} onClick={() => setQuoteOpen(true)}>Preparar cotización PDF</button>}
      {quoteOpen && <WhatsAppQuotePanel key={companyId + (data?.phone || phone || "")} phone={data?.phone || phone || ""} contactId={contactId} canAttach={open && mode === "reply" && !text.trim() && !files.length && !sending && !uncertain} companyId={companyId} message={latestInboundMessage?.body || ""} sourceMessageId={latestInbound || ""} onClose={() => setQuoteOpen(false)} onAttach={(file, caption) => { setFiles([file]); setText(caption); setMode("reply"); }} />}
      {!windowOpen && !contactBlocked && mode!=="template" && <button className="ghost-button" disabled={sending||uncertain} onClick={()=>setMode("template")}>Seleccionar plantilla</button>}
      <div className="direct-channels" role="group" aria-label="Tipo de mensaje WhatsApp"><button type="button" aria-pressed={mode === "reply"} disabled={sending || uncertain} onClick={() => setMode("reply")}>Mensaje</button><button type="button" aria-pressed={mode === "template"} disabled={sending || uncertain} onClick={() => setMode("template")}>Plantilla aprobada</button></div>
      {(mode === "template" ? data?.templateReasons : data?.reasons)?.map(reason => <p className="wa-alert" key={reason}>{reason}</p>)}
      {notice && <p className="wa-alert" role="status">{notice}</p>}
      <form onSubmit={event => { event.preventDefault(); void send(); }}>
        {mode === "template" ? <div className="wa-template">
          <label>Plantilla<select value={templateId} disabled={sending || uncertain} onChange={event => { setTemplateId(event.target.value); const selected=templates.find(t=>`${t.id}:${t.language}`===event.target.value); setParameters(selected?.variables.map(key=>{const field=selected.bindings?.find(b=>b.key===key)?.field || "manual";return field==="nombre_vendedor"?user?.name || "":data?.variableContext?.[field] || "";}) || []); }}><option value="">Seleccionar plantilla aprobada</option>{templates.map(t => <option key={`${t.id}:${t.language}`} value={`${t.id}:${t.language}`}>{t.name} · {t.language}</option>)}</select></label>
          {templateError && <p className="wa-alert" role="alert">{templateError}</p>}
          {template?.variables.map((name, index) => <label key={name}>Variable {name} · {template.bindings?.find(b=>b.key===name)?.field || "manual"}<input value={parameters[index] || ""} maxLength={1024} disabled={sending || uncertain || ["nombre_cliente","empresa","nombre_vendedor"].includes(template.bindings?.find(b=>b.key===name)?.field || "")} onChange={event => setParameters(previous => { const next = [...previous]; next[index] = event.target.value; return next; })} /></label>)}
          {template && <div className="wa-template-preview"><strong>{template.header}</strong><p>{template.body.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (match, name) => parameters[template.variables.indexOf(name)] || match)}</p><small>{template.footer}</small><small>Meta puede cobrar este mensaje.</small></div>}
        </div> : <><label htmlFor="wa-reply">Respuesta</label>
          <textarea id="wa-reply" rows={3} maxLength={files.length ? 1024 : 4096} value={text} disabled={!open || sending || loading || uncertain} onChange={event => setText(event.target.value)} />
          <MessageAttachments files={files} onChange={setFiles} disabled={!open || sending || loading || uncertain} maximum={1} />
        </>}
        <div className="wa-send"><span>{mode === "reply" ? `${text.length}/${files.length ? 1024 : 4096}` : "Consentimiento verificado al enviar"}</span><button className="primary-button" type="submit" disabled={sending || loading || uncertain || (mode === "template" ? !templateReady : !open || (!text.trim() && !files.length) || text.length > (files.length ? 1024 : 4096))}><Send size={18} /> {sending ? "Enviando..." : mode === "template" ? "Enviar plantilla" : "Enviar respuesta"}</button></div>
      </form>
      {data && companyId && <WhatsAppConsent companyId={companyId} contactId={contactId} phone={data.phone} consent={data.consent} disabled={sending} onSaved={()=>void load()}/>}
    </footer>
  </dialog>;
}
