import { useEffect, useRef, useState } from "react";
import { RefreshCw, Send } from "lucide-react";
import { getWhatsAppTemplates, sendWhatsAppCampaign, type WhatsAppTemplatesResponse, type WhatsAppDispatchResult } from "../../lib/whatsappApi";
import type { Company } from "../../types/crm";
import "./meta-campaign.css";

export function MetaCampaignDialog({ campaignId, companies, blockedReason, onClose, onSent }: {
  campaignId: string; companies: Company[]; onClose: () => void;
  blockedReason?: string;
  onSent: (companyIds: string[], completed: boolean) => Promise<void>;
}) {
  const [catalog, setCatalog] = useState<WhatsAppTemplatesResponse | null>(null);
  const [templateId, setTemplateId] = useState("");
  const [parameters, setParameters] = useState<string[]>([]);
  const [thumbnail, setThumbnail] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [results, setResults] = useState<WhatsAppDispatchResult[]>([]);
  const busy = useRef(false);
  const template = catalog?.templates.find((t) => t.id === templateId);
  const approved = catalog?.templates.filter((t) => t.status === "APPROVED") || [];
  const invalid = companies.filter((c) => !c.whatsappOptIn || (c.whatsappStatus && c.whatsappStatus !== "opt_in") ||
    !/^[1-9]\d{7,14}$/.test((c.whatsappNumber || c.whatsapp || c.phone || "").replace(/\D/g, "")));
  const phones = companies.map((c) => (c.whatsappNumber || c.whatsapp || c.phone || "").replace(/\D/g, ""));
  const duplicatePhones = new Set(phones).size !== phones.length;
  const ready = catalog?.ready && template && !template.blockedReason && !blockedReason && confirmed && !loading && !sending &&
    companies.length > 0 && !invalid.length && !duplicatePhones && parameters.length === template.variables.length && parameters.every((p) => p.trim());

  async function loadTemplates() {
    setLoading(true); setError(""); setConfirmed(false); setCatalog(null); setParameters([]); setThumbnail("");
    try {
      const data = await getWhatsAppTemplates();
      setCatalog(data);
      const initial = data.templates.find((t) => t.name === "super_stars_catalogo" && t.status === "APPROVED" && !t.blockedReason);
      setTemplateId(initial?.id || "");
      setParameters(initial?.variables.map(() => "") || []);
    } catch (err) { setError(err instanceof Error ? err.message : "No fue posible consultar Meta."); }
    finally { setLoading(false); }
  }

  useEffect(() => { void loadTemplates(); }, []);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = document.getElementById("meta-campaign-dialog");
    dialog?.focus();
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape" && !busy.current) onClose();
      if (event.key !== "Tab") return;
      const elements = Array.from(dialog?.querySelectorAll<HTMLElement>('button:not(:disabled),select:not(:disabled),input:not(:disabled),[tabindex="0"]') || []);
      const first = elements[0], last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
    document.addEventListener("keydown", handleKey);
    return () => { document.removeEventListener("keydown", handleKey); previous?.focus(); };
  }, [onClose]);

  async function send() {
    if (!ready || !template || busy.current) return;
    busy.current = true; setSending(true); setError(""); setResults([]);
    const accumulated: WhatsAppDispatchResult[] = [];
    try {
      for (let start = 0; start < companies.length; start += 10) {
        const batch = companies.slice(start, start + 10);
        const result = await sendWhatsAppCampaign({ campaignId, templateId: template.id, language: template.language,
          confirmSend: true, thumbnailProductId: thumbnail,
          recipients: batch.map((c) => ({ companyId: c.id, phone: c.whatsappNumber || c.whatsapp || c.phone, parameters })),
        });
        accumulated.push(...result.results); setResults([...accumulated]);
        if (!result.success || result.results.some((r) => !r.success || r.error)) break;
      }
    } catch (err) {
      setError(`${err instanceof Error ? err.message : "No se pudo completar el envio."} Revisa los intentos antes de repetir.`);
    } finally {
      const accepted = accumulated.filter((r) => r.success).map((r) => r.companyId);
      if (accepted.length) {
        try { await onSent(accepted, accepted.length === companies.length); }
        catch { setError("Meta acepto mensajes, pero no se pudo actualizar el resumen de campana. No reenviar."); }
      }
      setConfirmed(false); setSending(false); busy.current = false;
    }
  }

  return <div className="meta-modal-overlay">
    <div id="meta-campaign-dialog" className="meta-modal-box meta-campaign-dialog" role="dialog" aria-modal="true" aria-labelledby="meta-dialog-title" tabIndex={-1}>
      <div className="meta-dialog-heading">
        <h2 id="meta-dialog-title">Campaña WhatsApp</h2>
        <button type="button" className="ghost-button" aria-label="Actualizar plantillas" title="Actualizar plantillas" onClick={loadTemplates} disabled={loading || sending}><RefreshCw size={18} /></button>
      </div>
      <p>{companies.length} destinatarios seleccionados</p>
      {error && <p className="meta-warning-panel" role="alert">{error}</p>}
      {blockedReason && <p className="meta-warning-panel">{blockedReason}</p>}
      {catalog?.blockers.map((blocker) => <p className="meta-warning-panel" key={blocker}>{blocker}</p>)}
      <fieldset disabled={sending || loading} className="meta-template-fields">
        <label>Plantilla aprobada
          <select value={templateId} onChange={(e) => {
            setTemplateId(e.target.value); setConfirmed(false); setThumbnail("");
            setParameters(approved.find((t) => t.id === e.target.value)?.variables.map(() => "") || []);
          }}>
            <option value="">{loading ? "Consultando Meta..." : "Seleccionar plantilla"}</option>
            {approved.map((t) => <option key={t.id} value={t.id} disabled={Boolean(t.blockedReason)}>{t.name} · {t.language}{t.blockedReason ? " · Requiere configuración" : ""}</option>)}
          </select>
        </label>
        {!loading && catalog && !approved.length && <p>No hay plantillas aprobadas en esta cuenta.</p>}
        {template && <>
          <p className="meta-template-status">Aprobada · {template.language} · {template.category}</p>
          <div className="meta-template-preview" aria-label="Vista previa de la plantilla">
            {template.header && <strong>{template.header}</strong>}
            <p>{template.body.replace(/{{\s*([^{}]+?)\s*}}/g, (placeholder, name: string) => parameters[template.variables.indexOf(name)] || placeholder)}</p>
            {template.footer && <small>{template.footer}</small>}
            {template.catalogIndexes.length > 0 && <p className="meta-catalog-label">Ver catálogo</p>}
          </div>
          {template.variables.map((variable, index) => <label key={variable}>Variable {variable}
            <input value={parameters[index] || ""} maxLength={1024} onChange={(e) => {
              setParameters((values) => values.map((value, i) => i === index ? e.target.value : value)); setConfirmed(false);
            }} />
          </label>)}
          {template.catalogIndexes.length > 0 && <label>Producto destacado del catálogo (opcional)
            <input value={thumbnail} maxLength={200} placeholder="ID de producto en Meta" onChange={(e) => { setThumbnail(e.target.value); setConfirmed(false); }} />
          </label>}
          {template.blockedReason && <p className="meta-warning-panel">{template.blockedReason}</p>}
        </>}
        {invalid.length > 0 && <p className="meta-warning-panel">{invalid.length} destinatarios sin consentimiento vigente o número válido. Revisa la lista antes de enviar.</p>}
        {duplicatePhones && <p className="meta-warning-panel">Hay números repetidos en la lista de destinatarios.</p>}
        <label className="meta-send-confirmation"><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
          Confirmo enviar esta plantilla a los {companies.length} destinatarios seleccionados. Meta puede cobrar estos mensajes.
        </label>
      </fieldset>
      {results.length > 0 && <div className="meta-log-panel" role="status">
        {results.filter((r) => r.success).length} aceptados por Meta de {companies.length}
        {results.map((r) => <div key={r.companyId}>{r.phone}: {r.success ? "Aceptado por Meta" : "No confirmado"}{r.error ? ` · ${r.error}` : ""}</div>)}
      </div>}
      <div className="meta-modal-actions">
        <button className="ghost-button" type="button" disabled={sending} onClick={onClose}>Cerrar</button>
        <button className="primary-button" type="button" disabled={!ready} onClick={send}><Send size={18} />{sending ? "Enviando..." : "Enviar campaña"}</button>
      </div>
    </div>
  </div>;
}
