import { FormEvent, useMemo, useState } from "react";
import { Bot, Loader2, Mic, Send, ShieldCheck, Sparkles, UserRound } from "lucide-react";
import { sendCopilotMessage, type CopilotToolSummary } from "../../lib/copilotApi";

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  traceId?: string;
  tools?: CopilotToolSummary[];
};

const starterPrompts = [
  "Ayudame a crear una campana para clientes de climactiva.cl e invitarlos a RedTecnicos.cl.",
  "Busca clientes interesados y dime a cuales deberia llamar primero.",
  "Previsualiza un segmento para una campana a clientes con correo.",
];

export function CopilotPage() {
  const [conversationId, setConversationId] = useState<string>();
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "welcome",
      role: "assistant",
      content:
        "Escribeme libremente lo que necesitas. Puedo ayudarte a buscar clientes, analizar segmentos y redactar campanas completas como borrador seguro; no envio ni guardo cambios sin una accion confirmada.",
    },
  ]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
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

  return (
    <section className="page-stack copilot-page">
      <div className="page-heading">
        <div>
          <p>Asistente seguro</p>
          <h1>Copiloto CRM</h1>
        </div>
        <span className="status-badge programada">Solo lectura</span>
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
            <li>Sin envios de campanas ni cambios persistentes.</li>
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
