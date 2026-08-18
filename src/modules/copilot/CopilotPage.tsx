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
  "Resume el estado comercial actual y menciona riesgos visibles.",
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
        "Estoy listo para ayudarte con busquedas, metricas y previsualizaciones de segmentos. En esta primera version no ejecuto envios ni cambios permanentes.",
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
              <span>OpenAI se ejecuta solo en backend; la clave nunca llega al navegador.</span>
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
              placeholder="Preguntale al copiloto por clientes, metricas o segmentos..."
              rows={3}
            />
            <div>
              <button className="ghost-button" type="button" disabled title="La voz se habilitara en una fase posterior">
                <Mic size={18} />
              </button>
              <button className="primary-button" type="submit" disabled={!canSend}>
                {loading ? <Loader2 size={18} className="spin-icon" /> : <Send size={18} />}
                Enviar
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
