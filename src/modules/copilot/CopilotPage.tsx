import { FormEvent, useMemo, useState } from "react";
import {
  ArrowUpRight,
  BarChart3,
  Bot,
  CheckCircle2,
  CircleDollarSign,
  Database,
  FileSpreadsheet,
  FileText,
  Loader2,
  Mic,
  PackageCheck,
  Save,
  Send,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  UserPlus,
  UserRound,
  Users,
  UserX,
} from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import {
  saveCopilotCampaignDraft,
  sendCopilotMessage,
  type CopilotCampaignDraft,
  type CopilotReportSnapshot,
  type CopilotToolSummary,
  type SavedCopilotCampaign,
} from "../../lib/copilotApi";
import { exportReportExcel, exportReportPdf } from "../../lib/reportExport";

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  traceId?: string;
  tools?: CopilotToolSummary[];
  conversationId?: string;
  campaignDraft?: CopilotCampaignDraft;
  reportSnapshot?: CopilotReportSnapshot;
  saveKey?: string;
  savedCampaign?: SavedCopilotCampaign;
  saveError?: string;
};

const baseStarterPrompts = [
  "Analiza todos los agentes del CRM y muestrame estadisticas, tendencias, riesgos y oportunidades.",
  "Cual es la rentabilidad de este mes? Muestrame ventas, compras y si la utilidad esta certificada.",
  "Prepara un informe ejecutivo profesional de los ultimos 90 dias.",
  "Ayudame a crear una campana para clientes de climactiva.cl e invitarlos a RedTecnicos.cl.",
  "Prepara una campana para clientes de Facto que no compran hace 1 mes.",
  "Crea un borrador para clientes de Facto o Climactiva.cl con mas de 2 compras.",
];

export function CopilotPage() {
  const [searchParams] = useSearchParams();
  const campaignId = searchParams.get("campaign") ?? "";
  const campaignName = searchParams.get("campaignName") ?? "";
  const starterPrompts = useMemo(
    () => campaignId
      ? [
        `Analiza que paso con la campana ${campaignName || "seleccionada"}.`,
        "Explica cuantos destinatarios fueron enviados, fallaron o siguen pendientes.",
        "Evalua sus respuestas e interesados y recomienda los siguientes pasos.",
      ]
      : baseStarterPrompts,
    [campaignId, campaignName],
  );
  const [conversationId, setConversationId] = useState<string>();
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "welcome",
      role: "assistant",
      content:
        campaignId
          ? `Estoy listo para analizar la campana ${campaignName || "seleccionada"} con datos verificados de CRM y Gmail.`
          : "Escribeme libremente lo que necesitas. Puedo combinar la informacion de todos los agentes, analizar ventas, compras y rentabilidad mensual, mostrar estadisticas y tendencias, consultar cualquier campana y preparar borradores; nunca ejecuto acciones ni envios automaticamente.",
    },
  ]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [savingDraftId, setSavingDraftId] = useState<string>();
  const [exportingReport, setExportingReport] = useState<string>();
  const [error, setError] = useState("");
  const canSend = draft.trim().length > 0 && !loading;

  async function downloadReport(messageId: string, report: CopilotReportSnapshot, format: "pdf" | "excel") {
    const exportKey = `${messageId}:${format}`;
    setExportingReport(exportKey);
    setError("");
    try {
      if (format === "pdf") await exportReportPdf(report);
      else await exportReportExcel(report);
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : "No se pudo generar el archivo solicitado.");
    } finally {
      setExportingReport(undefined);
    }
  }

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
      const response = await sendCopilotMessage(content, conversationId, campaignId || undefined);
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
          reportSnapshot: response.reportSnapshot ?? undefined,
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

          {campaignId ? (
            <div className="copilot-campaign-context" role="status">
              <BarChart3 size={18} />
              <div><span>Campana en contexto</span><strong>{campaignName || campaignId}</strong></div>
              <Link to={`/informes?period=0&campaign=${encodeURIComponent(campaignId)}`}>Abrir informe</Link>
            </div>
          ) : null}

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
                  {message.reportSnapshot ? (
                    <section className="copilot-report-preview" aria-label="Informe profesional preparado">
                      <div className="copilot-report-preview-heading">
                        <div><BarChart3 size={19} /><span>Informe preparado</span></div>
                        <small>{message.reportSnapshot.periodLabel}</small>
                      </div>
                      <h3>{message.reportSnapshot.title}</h3>
                      <div className="copilot-report-kpis">
                        {message.reportSnapshot.campaignAnalysis ? (
                          <>
                            <div><span>Destinatarios</span><strong>{message.reportSnapshot.campaignAnalysis.recipients}</strong></div>
                            <div><span>Enviados</span><strong>{message.reportSnapshot.campaignAnalysis.sent}</strong></div>
                            <div><span>Pendientes</span><strong>{message.reportSnapshot.campaignAnalysis.pending}</strong></div>
                            <div><span>Respuesta</span><strong>{message.reportSnapshot.campaignAnalysis.replyRate}%</strong></div>
                          </>
                        ) : message.reportSnapshot.title.toLowerCase().includes("financier") && message.reportSnapshot.financialAnalysis.available ? (
                          <>
                            <div><span>Ventas netas</span><strong>{formatCopilotCurrency(message.reportSnapshot.financialAnalysis.netSales)}</strong></div>
                            <div><span>Compras netas</span><strong>{formatCopilotCurrency(message.reportSnapshot.financialAnalysis.netPurchases)}</strong></div>
                            <div><span>{message.reportSnapshot.financialAnalysis.profitabilityAvailable ? "Utilidad" : "Diferencia documental"}</span><strong>{formatCopilotCurrency(message.reportSnapshot.financialAnalysis.profitabilityAvailable ? Number(message.reportSnapshot.financialAnalysis.profitabilityValue) : message.reportSnapshot.financialAnalysis.documentaryDifference)}</strong></div>
                            <div><span>Variacion ventas</span><strong>{message.reportSnapshot.financialAnalysis.salesTrendPercent === null ? "Sin base" : `${message.reportSnapshot.financialAnalysis.salesTrendPercent > 0 ? "+" : ""}${message.reportSnapshot.financialAnalysis.salesTrendPercent}%`}</strong></div>
                          </>
                        ) : (
                          <>
                            <div><span>Empresas</span><strong>{message.reportSnapshot.kpis.companies}</strong></div>
                            <div><span>Conversion</span><strong>{message.reportSnapshot.kpis.conversionRate}%</strong></div>
                            <div><span>Interacciones</span><strong>{message.reportSnapshot.kpis.interactions}</strong></div>
                            <div><span>Respuesta</span><strong>{message.reportSnapshot.kpis.replyRate}%</strong></div>
                          </>
                        )}
                      </div>
                      {message.reportSnapshot.campaignAnalysis ? (
                        <p className="copilot-campaign-diagnosis">{message.reportSnapshot.campaignAnalysis.diagnosis}</p>
                      ) : !message.reportSnapshot.title.toLowerCase().includes("financier") ? (
                        <div className="copilot-report-mini-funnel">
                          {message.reportSnapshot.funnel.slice(0, 5).map((stage) => (
                            <div key={stage.key}>
                              <span>{stage.label}</span>
                              <div><i style={{ width: `${Math.max(stage.percentage, stage.value ? 4 : 0)}%` }} /></div>
                              <strong>{stage.value}</strong>
                            </div>
                          ))}
                        </div>
                      ) : null}
                      {!message.reportSnapshot.campaignAnalysis && message.reportSnapshot.financialAnalysis.available ? (
                        <div className="copilot-financial-overview">
                          <div className="copilot-financial-heading">
                            <div><CircleDollarSign size={17} /><strong>{message.reportSnapshot.financialAnalysis.monthLabel}</strong></div>
                            <span className={message.reportSnapshot.financialAnalysis.profitabilityAvailable ? "certified" : "reference"}>
                              {message.reportSnapshot.financialAnalysis.profitabilityAvailable ? "Utilidad certificada" : "Lectura referencial"}
                            </span>
                          </div>
                          <div className="copilot-financial-kpis">
                            <div><CircleDollarSign size={15} /><span>Ventas netas</span><strong>{formatCopilotCurrency(message.reportSnapshot.financialAnalysis.netSales)}</strong></div>
                            <div><PackageCheck size={15} /><span>Compras netas</span><strong>{formatCopilotCurrency(message.reportSnapshot.financialAnalysis.netPurchases)}</strong></div>
                            <div><TrendingUp size={15} /><span>{message.reportSnapshot.financialAnalysis.profitabilityAvailable ? "Utilidad" : "Diferencia documental"}</span><strong>{formatCopilotCurrency(message.reportSnapshot.financialAnalysis.profitabilityAvailable ? Number(message.reportSnapshot.financialAnalysis.profitabilityValue) : message.reportSnapshot.financialAnalysis.documentaryDifference)}</strong></div>
                          </div>
                          <p>{message.reportSnapshot.financialAnalysis.explanation}</p>
                        </div>
                      ) : null}
                      {!message.reportSnapshot.campaignAnalysis && !message.reportSnapshot.title.toLowerCase().includes("financier") ? (
                        <div className="copilot-agent-overview">
                          <div><Bot size={17} /><strong>Todos los agentes</strong><span>{message.reportSnapshot.agentIntelligence.agentsWithData}/{message.reportSnapshot.agentIntelligence.totalAgents} con datos</span></div>
                          {message.reportSnapshot.agentIntelligence.agents.map((agent) => (
                            <div className="copilot-agent-row" key={agent.type}>
                              <span>{agent.label}</span>
                              <div><i className={agent.status} style={{ width: `${agent.successRate}%` }} /></div>
                              <strong>{agent.completed}</strong>
                            </div>
                          ))}
                        </div>
                      ) : null}
                      <div className="copilot-report-actions">
                        <Link className="primary-button" to={`/informes?period=${message.reportSnapshot.filters.periodDays}${message.reportSnapshot.campaignAnalysis ? `&campaign=${encodeURIComponent(message.reportSnapshot.campaignAnalysis.id)}` : message.reportSnapshot.title.toLowerCase().includes("financier") ? `&view=financial${message.reportSnapshot.filters.financialYear ? `&year=${message.reportSnapshot.filters.financialYear}` : ""}` : ""}`}>
                          <BarChart3 size={17} /> Abrir informe <ArrowUpRight size={16} />
                        </Link>
                        <button className="ghost-button" type="button" disabled={Boolean(exportingReport)} onClick={() => void downloadReport(message.id, message.reportSnapshot!, "pdf")}>
                          {exportingReport === `${message.id}:pdf` ? <Loader2 size={16} className="spin-icon" /> : <FileText size={16} />} PDF
                        </button>
                        <button className="ghost-button" type="button" disabled={Boolean(exportingReport)} onClick={() => void downloadReport(message.id, message.reportSnapshot!, "excel")}>
                          {exportingReport === `${message.id}:excel` ? <Loader2 size={16} className="spin-icon" /> : <FileSpreadsheet size={16} />} Excel
                        </button>
                      </div>
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
              placeholder="Ej: Prepara un informe comercial de los ultimos 90 dias..."
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
            <li>Informes de solo lectura con cifras calculadas por el backend.</li>
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

function formatCopilotCurrency(value: number) {
  return new Intl.NumberFormat("es-CL", {
    style: "currency",
    currency: "CLP",
    maximumFractionDigits: 0,
  }).format(value);
}
