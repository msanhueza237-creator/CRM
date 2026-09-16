import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowUp,
  ArrowUpRight,
  Bot,
  CheckCircle2,
  ChevronDown,
  Clock3,
  Download,
  FileSpreadsheet,
  FileText,
  History,
  Loader2,
  MessageSquare,
  Mic,
  MicOff,
  Volume2,
  VolumeX,
  Plus,
  Search,
  ShieldCheck,
  Square,
  TriangleAlert,
  X,
} from "lucide-react";
import {
  authorizedExportMessage,
  centralHistory,
  flattenResults,
  safeSourcePath,
  streamCentralMessage,
  CopilotConnectionError,
  type CentralConversation,
  type CentralMessage,
  type CopilotReadResult,
  type CentralEvent,
  copilotVoiceRequest,
} from "../../lib/copilotCentralApi";
import { exportCentralMessage, exportCustomerPriceList } from "../../lib/copilotCentralExport";
import { useAuth } from "../auth/AuthContext";
import { CopilotPage as LegacyCopilotPage } from "./CopilotPage";
import "./central-copilot.css";
import { BusinessVisuals } from "./BusinessVisuals";
import { useCopilotVoice } from "./useCopilotVoice";
import { useCopilotLive } from "./useCopilotLive";
import { CopilotLivePanel } from "./CopilotLivePanel";

const labels: Record<string, string> = {
  consult_commercial: "Comercial",
  consult_finance: "Finanzas",
  consult_collections: "Cobranza",
  consult_marketing: "Marketing",
  consult_logistics: "Logistica",
  consult_foreign_trade: "Comercio Exterior",
  get_sales_summary: "Ventas y resultado",
  compare_sales_periods: "Comparacion de periodos",
  get_customer_sales: "Facturacion por cliente",
  get_customer_profile: "Ficha de empresa",
  get_loans: "Prestamos",
  get_product_profitability: "Margen por producto",
  search_prospects: "Prospeccion",
  get_prospecting_report: "Campañas y búsquedas de prospectos",
  get_bank_movements: "Bancos y conciliacion",
  get_checks: "Cheques",
  search_products: "Productos y stock",
  get_inventory_valuation: "Inventario: cantidades, costo y venta",
  get_price_list: "Precios",
  search_customers: "Clientes",
  get_financial_summary: "Finanzas",
  get_accounting_report: "Contabilidad",
  get_accounts_receivable: "Cobranza",
  get_accounts_payable: "Obligaciones",
  get_financial_documents: "Documentos",
  get_top_products: "Ventas",
  get_imports: "Importaciones",
  get_import_details: "Detalle de importacion",
  get_content: "Contenido",
  get_content_metrics: "Metricas de redes",
  get_campaigns: "Campanas",
  get_agent_activity: "Agentes",
  generate_business_report: "Informe del negocio",
  get_integration_status: "Integraciones",
};
const statuses: Record<string, string> = {
  ok: "Consultado",
  empty: "Sin coincidencias",
  partial: "Cobertura parcial",
  unavailable: "No disponible",
  forbidden: "Sin permiso",
  needs_clarification: "Requiere informacion",
};
const value = (data: unknown) =>
  data == null
    ? "No disponible"
    : typeof data === "object"
      ? JSON.stringify(data)
      : String(data);
const date = (stamp?: string | null) =>
  stamp && Number.isFinite(Date.parse(stamp))
    ? new Date(stamp).toLocaleString("es-CL", {
        dateStyle: "short",
        timeStyle: "short",
      })
    : "Sin fecha de origen";

export function CentralCopilotPage() {
  const [params] = useSearchParams();
  const { user } = useAuth();
  return params.get("view") === "legacy" && user?.role === "administrador" ? (
    <>
      <Link to="/copiloto">Volver al Copiloto central</Link>
      <LegacyCopilotPage />
    </>
  ) : (
    <CentralConversationPage key={`${user?.id}:${user?.role}`} />
  );
}
function CentralConversationPage() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const [conversations, setConversations] = useState<CentralConversation[]>([]);
  const [messages, setMessages] = useState<CentralMessage[]>([]);
  const [conversationId, setConversationId] = useState<string>();
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [draft, setDraft] = useState(() => {
    const inventory = params.get("inventory_query");
    if (inventory) return inventory.slice(0, 1000);
    const run = params.get("prospecting_run");
    return run && /^[a-f0-9-]{36}$/i.test(run) ? `Analiza la ejecución de prospección ${run}: uso de DeepSeek, progreso, candidatos y evidencia pendiente.` : "";
  });
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [error, setError] = useState("");
  const voice = useCopilotVoice(setDraft, setError);
  const [progress, setProgress] = useState<
    Array<{ id: string; name: string; status: string }>
  >([]);
  const abortRef = useRef<AbortController>();
  const historyAbort = useRef<AbortController>();
  const endRef = useRef<HTMLDivElement>(null);
  const selected = useRef<string>();
  const campaignId = params.get("campaign");
  const [voiceMode,setVoiceMode]=useState(false);
  const voiceModeRef=useRef(voiceMode); voiceModeRef.current=voiceMode;
  const [usage,setUsage]=useState<Record<string,unknown>>();
  const live=useCopilotLive(conversationId,{
    onEvent:acceptEvent,
    onQuestion:text=>{setMessages(m=>[...m,{id:crypto.randomUUID(),role:"user",content:text}]);setProgress([]);setError("");},
    onBusy:value=>{if(voiceModeRef.current)setBusy(value);},onError:setError,
  });
  function acceptEvent(event:CentralEvent) {
    if(event.type==="conversation"){setConversationId(event.conversationId);selected.current=event.conversationId;}
    if(event.type==="tool_start")setProgress(p=>[...p,{id:event.callId!,name:event.toolName!,status:"running"}]);
    if(event.type==="tool_end")setProgress(p=>p.map(t=>t.id===event.callId?{...t,status:event.status!}:t));
    if(event.type==="complete"){
      setMessages(m=>m.some(row=>row.id===event.messageId)?m:[...m,{id:event.messageId||crypto.randomUUID(),role:"assistant",content:event.message||"",metadata:{results:event.results,traceId:event.traceId,timings:event.timings,agents:event.agents}}]);
      void loadList().catch(()=>{});
    }
  }
  function returnToText(){if(voiceModeRef.current)setBusy(false);voiceModeRef.current=false;void live.stop();setVoiceMode(false);}
  const loadList = () =>
    centralHistory().then((data) => setConversations(data.conversations || []));
  useEffect(() => {
    loadList().catch((e) => setError(e.message));
    return () => {
      abortRef.current?.abort();
      historyAbort.current?.abort();
    };
  }, []);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [messages.length, progress.length]);
  async function selectConversation(id: string, offset = 0) {
    if (busy) return;
    returnToText();
    voice.stop();
    historyAbort.current?.abort();
    const controller = new AbortController();
    historyAbort.current = controller;
    selected.current = id;
    setHistoryBusy(true);
    setError("");
    try {
      const data = await centralHistory(id, offset, controller.signal);
      if (selected.current !== id) return;
      setConversationId(id);
      setNextOffset(data.nextOffset ?? null);
      setMessages((current) =>
        offset ? [...(data.messages || []), ...current] : data.messages || [],
      );
      setHistoryOpen(false);
      setProgress([]);
    } catch (e) {
      if (!controller.signal.aborted)
        setError(
          e instanceof Error
            ? e.message
            : "No se pudo recuperar la conversacion.",
        );
    } finally {
      if (!controller.signal.aborted) setHistoryBusy(false);
    }
  }
  function newConversation() {
    returnToText();
    voice.stop();
    if (busy) return;
    historyAbort.current?.abort();
    selected.current = undefined;
    setHistoryBusy(false);
    setConversationId(undefined);
    setMessages([]);
    setProgress([]);
    setNextOffset(null);
    setError("");
    setHistoryOpen(false);
    if (campaignId) setParams({});
  }
  async function send(event?: FormEvent, prompt?: string) {
    event?.preventDefault();
    const text = (prompt || draft).trim();
    if (!text || busy || historyBusy) return;
    if(live.active){returnToText();}
    voice.stop();
    const controller = new AbortController();
    const localId = crypto.randomUUID();
    let acceptedConversation: string | undefined, acceptedMessage: string | undefined;
    abortRef.current = controller;
    setMessages((current) => [
      ...current,
      { id: localId, role: "user", content: text },
    ]);
    setDraft("");
    setBusy(true);
    setError("");
    setProgress([]);
    try {
      await streamCentralMessage(
        campaignId ? `${text}\nCampana en contexto: ${campaignId}` : text,
        conversationId,
        controller.signal,
        (event) => {
          if (event.type === "conversation") {
            acceptedConversation = event.conversationId;
            acceptedMessage = event.userMessageId;
            setConversationId(event.conversationId);
            selected.current = event.conversationId;
          }
          acceptEvent(event);
        },
      );
      await loadList().catch(() => setError("La respuesta esta guardada, pero no se pudo actualizar la lista de conversaciones."));
    } catch (e) {
      if (e instanceof CopilotConnectionError && !e.requestStarted) {
        setMessages((current) => current.filter((m) => m.id !== localId));
        setDraft(text);
      }
      if (!controller.signal.aborted && acceptedConversation && acceptedMessage) {
        try {
          const history = await centralHistory(acceptedConversation);
          const recovered = history.messages?.find((m) => m.role === "assistant" && m.metadata?.inReplyTo === acceptedMessage);
          if (recovered) {
            setMessages((current) => current.some((m) => m.id === recovered.id) ? current : [...current, recovered]);
            setError("");
            return;
          }
        } catch { /* Keep the original connection error; never repeat a POST automatically. */ }
      }
      setError(
        controller.signal.aborted
          ? "Consulta detenida. No se modificaron datos del negocio."
          : e instanceof Error
            ? e.message
            : "La consulta no pudo completarse.",
      );
    } finally {
      setBusy(false);
      abortRef.current = undefined;
    }
  }
  const finance = user?.role === "administrador" || user?.role === "finanzas";
  const starters = [
    ...(finance
      ? ["Como va el negocio hoy?", "Muestrame las ventas del mes.", "Compara este mes con el anterior.", "Cuanto tenemos pendiente por cobrar?", "Cuales son nuestros mejores clientes?", "Que clientes dejaron de comprar?"]
      : []),
    "Que productos tienen stock critico?",
    ...(finance ? ["Que productos tienen mejor margen?", "Genera el informe ejecutivo del mes."] : []),
    ...(user?.role === "administrador" ? ["Que mercaderia viene en camino?", "Como va la proxima importacion?"] : []),
    ...(user?.role !== "finanzas" ? ["Que tenemos programado en el centro de contenido?"] : []),
  ];
  return (
    <section className={`central-copilot${voiceMode ? " is-voice" : ""}`} aria-label="Copiloto central">
      <header className="cc-heading">
        <div className="cc-heading-title">
          <Bot size={25} />
          <div>
            <h1>Copiloto · Gerente</h1>
            <span>LATIN CHILE</span>
          </div>
        </div>
        <div className="cc-heading-actions">
          <button className={`cc-mode ${voiceMode?"is-active":""}`} aria-pressed={voiceMode} disabled={!voiceMode&&(busy||historyBusy)} onClick={()=>{if(voiceMode)returnToText();else {voice.stop();setVoiceMode(true);setHistoryOpen(false);void live.start();}}}><Mic size={18}/> Voz</button>
          <span className="cc-read-only">
            <ShieldCheck size={15} /> Solo lectura
          </span>
          {user?.role === "administrador" && (
            <Link to="/copiloto?view=legacy" className="cc-legacy">
              Borradores
            </Link>
          )}
          <button
            title="Historial"
            aria-label="Historial"
            className="cc-icon cc-history-toggle"
            onClick={() => setHistoryOpen(!historyOpen)}
          >
            <History size={20} />
          </button>
          <button
            title="Nueva conversacion"
            aria-label="Nueva conversacion"
            className="cc-icon"
            onClick={newConversation}
            disabled={busy}
          >
            <Plus size={21} />
          </button>
        </div>
      </header>
      <div className="cc-workspace">
        <aside className={`cc-history ${historyOpen ? "is-open" : ""}`}>
          <div className="cc-history-heading">
            <h2>Conversaciones</h2>
            <button
              className="cc-icon cc-history-close"
              title="Cerrar historial"
              aria-label="Cerrar historial"
              onClick={() => setHistoryOpen(false)}
            >
              <X size={18} />
            </button>
          </div>
          <label className="cc-history-search">
            <Search size={16} />
            <input
              aria-label="Buscar conversacion"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar"
            />
          </label>
          <nav>
            {conversations
              .filter((c) =>
                c.title.toLowerCase().includes(search.toLowerCase()),
              )
              .map((c) => (
                <button
                  disabled={busy}
                  className={c.id === conversationId ? "is-selected" : ""}
                  key={c.id}
                  onClick={() => selectConversation(c.id)}
                >
                  <MessageSquare size={15} />
                  <span>
                    <strong>{c.title}</strong>
                    <small>{date(c.updated_at)}</small>
                  </span>
                </button>
              ))}
          </nav>
          {!conversations.length && (
            <p className="cc-muted">Sin conversaciones guardadas</p>
          )}
          <div className="cc-history-footer">
            <ShieldCheck size={17} />
            <span>
              {user?.name}
              <small>{user?.role}</small>
            </span>
          </div>
        </aside>
        <main className="cc-main">
          {voiceMode&&<CopilotLivePanel live={live} onText={returnToText}/>}
          <div className="cc-conversation" aria-busy={busy || historyBusy}>
            {historyBusy && (
              <div className="cc-loading">
                <Loader2 size={18} className="spin" /> Recuperando conversacion
              </div>
            )}
            {nextOffset !== null && (
              <button
                className="cc-older"
                onClick={() => selectConversation(conversationId!, nextOffset)}
                disabled={busy || historyBusy}
              >
                Cargar mensajes anteriores
              </button>
            )}
            {!messages.length && !historyBusy && (
              <div className="cc-empty">
                <div className="cc-empty-mark">
                  <Bot size={32} />
                </div>
                <h2>Que necesita tu negocio hoy?</h2>
                <div className="cc-starters">
                  {starters.map((prompt) => (
                    <button
                      key={prompt}
                      onClick={() => send(undefined, prompt)}
                    >
                      <span>{prompt}</span>
                      <ArrowUpRight size={18} />
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((message) => (
              <ConversationMessage
                key={message.id}
                message={message}
                conversationId={conversationId}
                onError={setError}
                onContinue={(result) => {
                  if (result.continuation) void send(undefined, `Continua la consulta de ${labels[result.toolName] || result.toolName}. Usa estos filtros de la pagina anterior: ${JSON.stringify(result.continuation)}`);
                }}
                busy={busy || historyBusy}
                onSpeak={(text)=>{returnToText();voice.speak(text);}}
              />
            ))}
            {busy && (
              <div className="cc-execution" role="status">
                <Loader2 size={18} className="spin" />
                <div>
                  <strong>
                    {progress.some((p) => p.status === "running")
                      ? "Consultando fuentes"
                      : "Preparando respuesta"}
                  </strong>
                  {progress.map((p) => (
                    <span key={p.id}>
                      {p.status === "running" ? (
                        <Clock3 size={13} />
                      ) : ["ok", "empty"].includes(p.status) ? (
                        <CheckCircle2 size={13} />
                      ) : (
                        <TriangleAlert size={13} />
                      )}
                      {labels[p.name] || p.name}
                      {p.status !== "running" &&
                        ` · ${statuses[p.status] || p.status}`}
                    </span>
                  ))}
                </div>
              </div>
            )}
            <div ref={endRef} />
          </div>
          <div className="cc-compose-area" hidden={voiceMode}>
            {error && (
              <div className="cc-error" role="alert">
                <TriangleAlert size={18} />
                <span>{error}</span>
                <button
                  className="cc-icon"
                  aria-label="Cerrar error"
                  onClick={() => setError("")}
                >
                  <X size={16} />
                </button>
              </div>
            )}
            <form className="cc-composer" onSubmit={send}>
              <textarea
                aria-label="Consulta al Copiloto"
                placeholder="Pregunta sobre tu negocio..."
                value={draft}
                maxLength={6000}
                rows={2}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (
                    e.key === "Enter" &&
                    !e.shiftKey &&
                    !e.nativeEvent.isComposing
                  ) {
                    e.preventDefault();
                    void send();
                  }
                }}
              />
              <div>
                <span>
                  {voice.listening ? "Escuchando..." : draft.length ? `${draft.length} / 6000` : "CLIMACTIVA"}
                </span>
                <div className="cc-voice-controls">
                  <button type="button" className="cc-icon" disabled={busy || historyBusy || !voice.canListen} aria-pressed={voice.listening} title={voice.canListen ? "Dictar con el servicio de voz del navegador" : "Dictado no disponible en este navegador"} aria-label={voice.listening ? "Detener dictado" : "Dictar consulta"} onClick={voice.listening ? voice.stop : voice.listen}>{voice.listening ? <MicOff size={20} /> : <Mic size={20} />}</button>
                  {voice.speaking && <button type="button" className="cc-icon" title="Detener audio" aria-label="Detener audio" onClick={voice.stop}><VolumeX size={20} /></button>}
                {busy ? (
                  <button
                    type="button"
                    className="cc-send"
                    title="Detener consulta"
                    aria-label="Detener consulta"
                    onClick={() => abortRef.current?.abort()}
                  >
                    <Square size={17} />
                  </button>
                ) : (
                  <button
                    type="submit"
                    className="cc-send"
                    disabled={!draft.trim() || historyBusy}
                    title="Enviar consulta"
                    aria-label="Enviar consulta"
                  >
                    <ArrowUp size={20} />
                  </button>
                )}
                </div>
              </div>
            </form>
          </div>
        </main>
      </div>
      {user?.role==="administrador"&&<details className="cc-usage"><summary onClick={()=>{if(!usage)void copilotVoiceRequest("voice-stats").then(setUsage).catch(e=>setError(e.message));}}>Uso del Copiloto</summary>{usage&&<><p>{String(usage.modelCalls)} llamadas de razonamiento · {Math.ceil(Number(usage.seconds)/60)} minutos de voz · USD {Number(usage.estimatedUsd).toFixed(3)} estimados</p><small>{String(usage.scope)}. {String(usage.estimateNote)} {usage.partial?"Cobertura parcial.":""}</small></>}</details>}
    </section>
  );
}
function ConversationMessage({
  message,
  conversationId,
  onError,
  onContinue,
  busy,
  onSpeak,
}: {
  message: CentralMessage;
  conversationId?: string;
  onError: (error: string) => void;
  onContinue: (result: CopilotReadResult) => void;
  busy: boolean;
  onSpeak: (text: string) => void;
}) {
  const [exporting, setExporting] = useState<string>();
  const results = flattenResults(message.metadata?.results || []);
  const hasPriceList = results.some((r) => r.toolName === "get_price_list" && Number((r.data as { client_price_list?: { total?: number } } | null)?.client_price_list?.total) > 0);
  async function download(format: "excel" | "pdf" | "csv" | "client-excel") {
    setExporting(format);
    try {
      if (!conversationId)
        throw new Error("La respuesta aun no esta respaldada.");
      const authorized = await authorizedExportMessage(conversationId, message.id);
      const priceExport = flattenResults(authorized.metadata?.results || []).some((r) => r.toolName === "get_price_list" && Number((r.data as { client_price_list?: { total?: number } } | null)?.client_price_list?.total) > 0);
      if (format === "client-excel" || (format === "excel" && priceExport)) await exportCustomerPriceList(authorized);
      else await exportCentralMessage(authorized, format);
    } catch (error) {
      onError(
        error instanceof Error
          ? error.message
          : "No se pudo generar el archivo.",
      );
    } finally {
      setExporting(undefined);
    }
  }
  return (
    <article className={`cc-message cc-${message.role}`}>
      <div className="cc-message-label">
        {message.role === "user" ? (
          "Tu"
        ) : (
          <>
            <Bot size={17} /> Copiloto
            <button className="cc-icon" title="Escuchar respuesta" aria-label="Escuchar respuesta" onClick={() => onSpeak(message.content)}><Volume2 size={17} /></button>
          </>
        )}
      </div>
      <div className="cc-message-body">
        {message.role === "user" ? (
          <p>{message.content}</p>
        ) : (
          <>
            <div className="cc-markdown">
              <Markdown
                remarkPlugins={[remarkGfm]}
                skipHtml
                components={{
                  img: () => null,
                  a: ({ href, children }) =>
                    href && safeSourcePath(href) ? (
                      <Link to={href}>{children}</Link>
                    ) : (
                      <span>{children}</span>
                    ),
                  table: ({ children }) => (
                    <div className="cc-table-scroll">
                      <table>{children}</table>
                    </div>
                  ),
                }}
              >
                {message.content}
              </Markdown>
            </div>
            {results.map((result, index) => (
              <SourceResult
                key={`${result.toolName}-${index}`}
                result={result}
                onContinue={onContinue}
                busy={busy}
              />
            ))}
            {message.metadata?.traceId && (
              <footer className="cc-message-footer">
                <div className="cc-export">
                  {hasPriceList && <button disabled={!!exporting} title="Descargar lista de precios para clientes" aria-label="Descargar lista de precios para clientes" onClick={() => download("client-excel")}><FileSpreadsheet size={16} /> Lista de precios (Excel)</button>}
                  <button
                    disabled={!!exporting}
                    title="Descargar Excel"
                    aria-label="Descargar Excel"
                    onClick={() => download("excel")}
                  >
                    <FileSpreadsheet size={16} /> Excel
                  </button>
                  <button
                    disabled={!!exporting}
                    title="Descargar PDF"
                    aria-label="Descargar PDF"
                    onClick={() => download("pdf")}
                  >
                    <FileText size={16} /> PDF
                  </button>
                  <button
                    disabled={!!exporting}
                    title="Descargar CSV"
                    aria-label="Descargar CSV"
                    onClick={() => download("csv")}
                  >
                    <Download size={16} /> CSV
                  </button>
                  {exporting && <Loader2 className="spin" size={16} />}
                </div>
                <small title={message.metadata.traceId}>
                  Ref. {message.metadata.traceId.slice(0, 8)}
                </small>
              </footer>
            )}
            {message.metadata?.timings && <details className="cc-technical"><summary>Detalle tecnico</summary><dl>
              {Object.entries({ "Respuesta total": message.metadata.timings.totalMs, "Modelo": message.metadata.timings.modelMs, "Lecturas de datos (acumulado)": message.metadata.timings.databaseMs, "Servicios (acumulado)": message.metadata.timings.serviceMs }).map(([label,ms]) => <div key={label}><dt>{label}</dt><dd>{(ms / 1000).toFixed(1)} s</dd></div>)}
              <div><dt>Lecturas reutilizadas</dt><dd>{message.metadata.timings.cacheHits}</dd></div>
              {message.metadata.agents?.map((agent, index) => <div key={`${agent.agent}-${index}`}><dt>{agent.agent === "executive" ? "Gerente" : labels[`consult_${agent.agent}`] || agent.agent}</dt><dd>{statuses[agent.status] || agent.status} · {(agent.durationMs / 1000).toFixed(1)} s · {agent.modelCalls} llamadas</dd></div>)}
            </dl></details>}
          </>
        )}
      </div>
    </article>
  );
}
function SourceResult({ result, onContinue, busy }: { result: CopilotReadResult; onContinue: (result: CopilotReadResult) => void; busy: boolean }) {
  const data = result.data as {
    summary?: Record<string, unknown>;
    selected_total_clp?: string | null;
  } | null;
  const summary =
    result.toolName === "get_financial_summary" ? data?.summary : null;
  const kpis = summary
    ? [
        ["Disponible CLP", summary.bank_clp],
        ["Por cobrar CLP", summary.receivables],
        ["Por pagar CLP", summary.payables],
      ]
    : [];
  return (
    <section className="cc-result">
      <div className="cc-result-top">
        <strong>{labels[result.toolName] || result.toolName}</strong>
        <span className={`cc-state ${result.status}`}>
          {statuses[result.status] || result.status}
        </span>
      </div>
      {!!result.components?.length && <BusinessVisuals components={result.components} />}
      {!!kpis.length && (
        <dl className="cc-kpis">
          {kpis.map(([label, amount]) => (
            <div key={String(label)}>
              <dt>{String(label)}</dt>
              <dd>
                {amount == null
                  ? "No disponible"
                  : new Intl.NumberFormat("es-CL", {
                      style: "currency",
                      currency: "CLP",
                      maximumFractionDigits: 0,
                    }).format(Number(amount))}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {result.table && (
        <details open={result.table.rows.length <= 10}>
          <summary>
            <span>{result.table.title}</span>
            <span>
              {result.coverage.returned} / {result.coverage.totalMatched ?? "?"}
              <ChevronDown size={15} />
            </span>
          </summary>
          <div
            className="cc-table-scroll"
            tabIndex={0}
            aria-label={result.table.title}
          >
            <table>
              <thead>
                <tr>
                  {result.table.columns.map((c) => (
                    <th key={c.key}>{c.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.table.rows.map((row, index) => (
                  <tr key={String(row.id || index)}>
                    {result.table!.columns.map((c) => (
                      <td key={c.key}>{value(row[c.key])}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {result.continuation && <button className="cc-older" disabled={busy} onClick={() => onContinue(result)} title="Consultar siguiente pagina">Siguiente pagina <ArrowUpRight size={14} /></button>}
        </details>
      )}
      {result.warnings.length > 0 && (
        <details className="cc-warnings">
          <summary>
            <TriangleAlert size={14} /> {result.warnings.length} observaciones
            de la fuente
          </summary>
          <ul>
            {[...new Set(result.warnings)].map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </details>
      )}
      <div className="cc-provenance">
        <span>
          <Clock3 size={13} /> Origen: {date(result.freshness.sourceObservedAt)}
        </span>
        {result.evidence
          .filter((e) => safeSourcePath(e.path))
          .map((e, i) => (
            <Link key={`${e.path}-${i}`} to={e.path}>
              {e.label}
              <ArrowUpRight size={13} />
            </Link>
          ))}
      </div>
      {["unavailable", "forbidden", "needs_clarification"].includes(
        result.status,
      ) && <p className="cc-muted">{result.summary}</p>}
    </section>
  );
}
