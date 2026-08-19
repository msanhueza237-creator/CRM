import { FormEvent, useMemo, useState } from "react";
import {
  Bot,
  CheckCircle2,
  Database,
  Loader2,
  Mic,
  Save,
  Send,
  ShieldCheck,
  Sparkles,
  UserPlus,
  UserRound,
  Users,
  UserX,
} from "lucide-react";
import { Link } from "react-router-dom";
import {
  saveCopilotCampaignDraft,
  sendCopilotMessage,
  type CopilotCampaignDraft,
  type CopilotToolSummary,
  type SavedCopilotCampaign,
} from "../../lib/copilotApi";

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  traceId?: string;
  tools?: CopilotToolSummary[];
  conversationId?: string;
  campaignDraft?: CopilotCampaignDraft;
  saveKey?: string;
  savedCampaign?: SavedCopilotCampaign;
  saveError?: string;
};

const starterPrompts = [
  "Ayudame a crear una campana para clientes de climactiva.cl e invitarlos a RedTecnicos.cl.",
  "Prepara una campana para clientes de Facto que no compran hace 1 mes.",
  "Crea un borrador para clientes de Facto o Climactiva.cl con mas de 2 compras.",
];

export function CopilotPage() {
  const [conversationId, setConversationId] = useState<string>();
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "welcome",
      role: "assistant",
      content:
        "Escribeme libremente lo que necesitas. Puedo preparar campanas, calcular sus clientes y agregarlos al borrador cuando tu lo confirmes; nunca programo ni envio automaticamente.",
    },
  ]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [savingDraftId, setSavingDraftId] = useState<string>();
  const [error, setError] = useState("");
  const canSend = draft.trim().length > 0 && !loading;

  const lastToolSummary = useMemo(
    () => [...messages].reverse().find((message) => message.tools?.length)?.tools ?? [],
    [messages],
  );

  async function submitMessage(event?: FormEvent<HTMLFormElement>, promptOverride?: string) {
    event?.preventDefault();
    const content = (promptOverride ?? draft).trim();
    if (!content || loading) return;

    const userMessage: ChatMessage = { id: crypto.randomUUID(), role: "user", content };
    setMessages((current) => [...current, userMessage]);
    setDraft("");
    setError("");
    setLoading(true);

    try {
      const response = await sendCopilotMessage(content, conversationId);
      setConversationId(response.conversationId);
      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: response.message,
          traceId: response.traceId,
          tools: response.tools,
          conversationId: response.conversationId,
          campaignDraft: response.campaignDraft ?? undefined,
          saveKey: response.campaignDraft ? crypto.randomUUID() : undefined,
        },
      ]);
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : "Error llamando al copiloto.";
      setError(message);
      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: message,
        },
      ]);
    } finally {
      setLoading(false);
    }
  }

  async function saveCampaignDraft(message: ChatMessage) {
    if (!message.campaignDraft || !message.conversationId || !message.saveKey || savingDraftId) return;
    const preview = message.campaignDraft.recipientPreview;
    if (!preview.sourceDataAvailable) return;
    const confirmed = window.confirm(
      `Se guardara "${message.campaignDraft.name}" como borrador con ${preview.recipientCount} destinatarios. ` +
      `${preview.importableCount} clientes externos se agregaran a Empresas. No se programara ni enviara nada. ¿Deseas continuar?`,
    );
    if (!confirmed) return;

    setSavingDraftId(message.id);
    setMessages((current) => current.map((item) => item.id === message.id ? { ...item, saveError: undefined } : item));
    try {
      const savedCampaign = await saveCopilotCampaignDraft(
        message.campaignDraft,
        message.conversationId,
        message.saveKey,
      );
      setMessages((current) => current.map((item) =>
        item.id === message.id ? { ...item, savedCampaign, saveError: undefined } : item
      ));
    } catch (saveError) {
      const saveMessage = saveError instanceof Error ? saveError.message : "No se pudo guardar el borrador.";
      setMessages((current) => current.map((item) =>
        item.id === message.id ? { ...item, saveError: saveMessage } : item
      ));
    } finally {
      setSavingDraftId(undefined);
    }
  }

  return (
    <section className="page-stack copilot-page">
      <div className="page-heading">
        <div>
          <p>Asistente seguro</p>
          <h1>Copiloto CRM</h1>
        </div>
        <span className="status-badge borrador">Borradores seguros</span>
      </div>

      <div className="copilot-grid">
        <section className="panel copilot-chat-panel">
          <div className="panel-heading">
            <div>
              <h2>Conversacion</h2>
              <span>Escribe una solicitud abierta; los botones de abajo son solo ejemplos rapidos.</span>
            </div>
            <Sparkles size={22} />
          </div>

          <div className="copilot-messages" aria-live="polite">
            {messages.map((message) => (
              <article key={message.id} className={`copilot-message ${message.role}`}>
                <div className="copilot-avatar">
                  {message.role === "assistant" ? <Bot size={18} /> : <UserRound size={18} />}
                </div>
                <div>
                  <p>{message.content}</p>
                  {message.traceId ? <span>Trace: {message.traceId}</span> : null}
                  {message.campaignDraft ? (
                    <section className="copilot-campaign-draft" aria-label="Borrador de campana preparado">
                      <div className="copilot-campaign-draft-heading">
                        <div>
                          <span>Borrador preparado</span>
                          <strong>{message.campaignDraft.name}</strong>
                        </div>
                        <span className="status-badge borrador">Sin enviar</span>
                      </div>
                      <dl>
                        <div><dt>Canal</dt><dd>{message.campaignDraft.type}</dd></div>
                        <div><dt>Segmento</dt><dd>{message.campaignDraft.segment}</dd></div>
                        <div><dt>Objetivo</dt><dd>{message.campaignDraft.objective}</dd></div>
                      </dl>
                      <section className="copilot-recipient-preview" aria-label="Destinatarios calculados">
                        <div className="copilot-recipient-preview-heading">
                          <div>
                            <Users size={18} />
                            <span>Destinatarios calculados</span>
                          </div>
                          <strong>{message.campaignDraft.recipientPreview.recipientCount}</strong>
                        </div>
                        <div className="copilot-recipient-metrics">
                          <div>
                            <Database size={17} />
                            <strong>{message.campaignDraft.recipientPreview.existingCrmCount}</strong>
                            <span>ya existen en Empresas</span>
                          </div>
                          <div>
                            <UserPlus size={17} />
                            <strong>{message.campaignDraft.recipientPreview.importableCount}</strong>
                            <span>se agregaran al confirmar</span>
                          </div>
                          <div>
                            <UserX size={17} />
                            <strong>{message.campaignDraft.recipientPreview.excludedCount}</strong>
                            <span>excluidos por datos o canal</span>
                          </div>
                        </div>
                        <div className="copilot-recipient-criteria">
                          {message.campaignDraft.recipientPreview.criteria.map((criterion) => (
                            <span key={criterion}>{criterion}</span>
                          ))}
                        </div>
                        {message.campaignDraft.recipientPreview.sample.length ? (
                          <div className="copilot-recipient-sample">
                            <span>Muestra del segmento</span>
                            {message.campaignDraft.recipientPreview.sample.slice(0, 5).map((customer, index) => (
                              <div key={`${customer.name}-${index}`}>
                                <strong>{customer.name}</strong>
                                <span>
                                  {customer.source} · {customer.purchases} compras
                                  {customer.daysSincePurchase === null ? "" : ` · ${customer.daysSincePurchase} dias sin comprar`}
                                </span>
                                <small className={customer.destinationStatus}>
                                  {customer.destinationStatus === "crm"
                                    ? "En Empresas"
                                    : customer.destinationStatus === "importar"
                                      ? "Se agregara"
                                      : "Excluido"}
                                </small>
                              </div>
                            ))}
                          </div>
                        ) : null}
                        {!message.campaignDraft.recipientPreview.sourceDataAvailable ? (
                          <p className="form-error" role="alert">
                            Falta sincronizar la cartera comercial antes de guardar este segmento.
                          </p>
                        ) : null}
                      </section>
                      <div className="copilot-campaign-copy">
                        <span>Contenido</span>
                        <p>{message.campaignDraft.message}</p>
                      </div>
                      {message.savedCampaign ? (
                        <div className="copilot-draft-saved" role="status">
                          <CheckCircle2 size={18} />
                          <span>
                            Guardada con {message.savedCampaign.recipientCount} destinatarios
                            {message.savedCampaign.importedCount
                              ? ` y ${message.savedCampaign.importedCount} clientes nuevos`
                              : ""}. No fue enviada.
                          </span>
                          <Link className="ghost-button" to="/campanas">Abrir Campanas</Link>
                        </div>
                      ) : (
                        <button
                          className="primary-button"
                          type="button"
                          disabled={savingDraftId === message.id || !message.campaignDraft.recipientPreview.sourceDataAvailable}
                          onClick={() => void saveCampaignDraft(message)}
                        >
                          {savingDraftId === message.id ? <Loader2 size={17} className="spin-icon" /> : <Save size={17} />}
                          {savingDraftId === message.id ? "Guardando..." : "Guardar borrador"}
                        </button>
                      )}
                      {message.saveError ? <p className="form-error" role="alert">{message.saveError}</p> : null}
                    </section>
                  ) : null}
                </div>
              </article>
            ))}
            {loading ? (
              <article className="copilot-message assistant">
                <div className="copilot-avatar">
                  <Loader2 size={18} className="spin-icon" />
                </div>
                <div>
                  <p>Consultando el CRM y preparando respuesta...</p>
                </div>
              </article>
            ) : null}
          </div>

          {error ? <p className="form-error">{error}</p> : null}

          <div className="copilot-prompts">
            <span className="copilot-prompts-label">Ejemplos</span>
            {starterPrompts.map((prompt) => (
              <button key={prompt} className="ghost-button" type="button" onClick={() => void submitMessage(undefined, prompt)} disabled={loading}>
                {prompt}
              </button>
            ))}
          </div>

          <form className="copilot-composer" onSubmit={submitMessage}>
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                  void submitMessage();
                }
              }}
              placeholder="Ej: Ayudame a crear una campana para clientes de climactiva.cl e invitarlos a redtecnicos.cl..."
              rows={5}
            />
            <div>
              <button className="ghost-button" type="button" disabled title="La voz se habilitara en una fase posterior">
                <Mic size={18} />
              </button>
              <button className="primary-button" type="submit" disabled={!canSend}>
                {loading ? <Loader2 size={18} className="spin-icon" /> : <Send size={18} />}
                {loading ? "Pensando..." : "Enviar"}
              </button>
            </div>
          </form>
        </section>

        <aside className="panel copilot-side-panel">
          <div className="panel-heading">
            <h2>Controles activos</h2>
            <ShieldCheck size={22} />
          </div>
          <ul className="copilot-safety-list">
            <li>Sin SQL generado por el modelo.</li>
            <li>Guarda campanas solo como borrador y con confirmacion.</li>
            <li>Puede asociar e importar clientes solo al confirmar.</li>
            <li>Sin programacion ni envios automaticos.</li>
            <li>Sesion, usuario y rol salen del backend.</li>
            <li>Auditoria de mensajes, herramientas y errores.</li>
          </ul>

          <div className="copilot-tool-log">
            <h3>Ultimas consultas</h3>
            {lastToolSummary.length ? (
              lastToolSummary.map((tool, index) => (
                <article key={`${tool.humanSummary}-${index}`}>
                  <strong>{tool.ok ? "OK" : "Error"}</strong>
                  <p>{tool.humanSummary}</p>
                  {tool.warnings.length ? <span>{tool.warnings.join(" ")}</span> : null}
                </article>
              ))
            ) : (
              <p className="muted">Aun no hay herramientas ejecutadas en esta conversacion.</p>
            )}
          </div>
        </aside>
      </div>
    </section>
  );
}
