import { getSupabaseFunctionUrl, isSupabaseConfigured, supabase } from "./supabase";

export interface CopilotToolSummary {
  ok: boolean;
  humanSummary: string;
  warnings: string[];
  evidence: Array<{
    entityType: string;
    entityId?: string;
    label: string;
  }>;
}

export interface CopilotMessageResponse {
  conversationId: string;
  message: string;
  traceId: string;
  model: string;
  campaignDraft: CopilotCampaignDraft | null;
  reportSnapshot: CopilotReportSnapshot | null;
  tools: CopilotToolSummary[];
}

export interface CopilotReportBreakdown {
  key: string;
  label: string;
  value: number;
  percentage: number;
}

export interface CopilotAgentMetric {
  key: string;
  label: string;
  value: number | string;
}

export interface CopilotAgentIntelligence {
  totalAgents: number;
  agentsWithData: number;
  completedTasks: number;
  failedTasks: number;
  pendingTasks: number;
  runningTasks: number;
  pendingProposals: number;
  criticalAlerts: number;
  healthyIntegrations: number;
  totalIntegrations: number;
  agents: Array<{
    type: string;
    label: string;
    status: "healthy" | "attention" | "running" | "idle";
    completed: number;
    failed: number;
    pending: number;
    running: number;
    successRate: number;
    lastRunAt: string | null;
    summary: string;
    warnings: string[];
    metrics: CopilotAgentMetric[];
  }>;
  taskStatus: CopilotReportBreakdown[];
  taskTrend: Array<{ key: string; label: string; completed: number; failed: number; pending: number }>;
  proposalRisk: CopilotReportBreakdown[];
  alertSeverity: CopilotReportBreakdown[];
  integrationStatus: CopilotReportBreakdown[];
}

export interface CopilotFinancialAnalysis {
  available: boolean;
  monthKey: string;
  monthLabel: string;
  isCurrentMonth: boolean;
  updatedAt: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  netSales: number;
  grossSales: number;
  salesTax: number;
  salesDocuments: number;
  netPurchases: number;
  grossPurchases: number;
  purchaseTax: number;
  purchaseDocuments: number;
  documentaryDifference: number;
  documentaryMarginRate: number;
  previousMonthNetSales: number;
  salesTrendPercent: number | null;
  referenceGrossMargin: number | null;
  referenceMarginRate: number | null;
  profitabilityAvailable: boolean;
  profitabilityValue: number | null;
  profitabilityRate: number | null;
  accountingStatus: string;
  accountingPeriodLabel: string;
  explanation: string;
  warnings: string[];
}

export interface CopilotReportSnapshot {
  toolName: "generate_professional_report";
  title: string;
  subtitle: string;
  generatedAt: string;
  periodLabel: string;
  filters: {
    periodDays: number;
    source: string;
    companyType: string;
    region: string;
    campaignId: string;
    financialYear?: number;
  };
  filterOptions: {
    sources: string[];
    companyTypes: string[];
    regions: string[];
    campaigns: Array<{ id: string; name: string }>;
  };
  kpis: {
    companies: number;
    clients: number;
    conversionRate: number;
    newCompanies: number;
    interactions: number;
    campaigns: number;
    recipients: number;
    sent: number;
    replies: number;
    replyRate: number;
    interested: number;
    pendingTasks: number;
  };
  funnel: CopilotReportBreakdown[];
  companyTypes: CopilotReportBreakdown[];
  sources: CopilotReportBreakdown[];
  campaignStatuses: CopilotReportBreakdown[];
  trend: Array<{ key: string; label: string; interactions: number; campaigns: number; replies: number }>;
  campaignPerformance: Array<{
    id: string;
    name: string;
    status: string;
    channel: string;
    recipients: number;
    sent: number;
    replies: number;
    interested: number;
    replyRate: number;
  }>;
  campaignAnalysis: {
    id: string;
    name: string;
    status: string;
    channel: string;
    recipients: number;
    sent: number;
    failed: number;
    pending: number;
    skipped: number;
    replies: number;
    interested: number;
    sendRate: number;
    replyRate: number;
    failureRate: number;
    pendingRate: number;
    emailBatches: number;
    firstSentAt: string | null;
    lastSentAt: string | null;
    diagnosis: string;
    topErrors: Array<{ message: string; count: number }>;
  } | null;
  agentIntelligence: CopilotAgentIntelligence;
  financialAnalysis: CopilotFinancialAnalysis;
  insights: Array<{
    tone: "positive" | "attention" | "neutral";
    title: string;
    detail: string;
  }>;
  dataQuality: {
    contactable: number;
    missingContact: number;
    missingLocation: number;
  };
  warnings: string[];
}

export interface CopilotReportFilters {
  periodDays: number;
  source?: string;
  companyType?: string;
  region?: string;
  campaignId?: string;
  reportKind?: "financial";
  financialYear?: number;
}

export interface CopilotCampaignDraft {
  name: string;
  type: "email" | "whatsapp" | "mixta";
  segment: string;
  message: string;
  product: string;
  objective: string;
  segmentQuery: string;
  recipientPreview: CopilotRecipientPreview;
}

export interface CopilotRecipientPreview {
  totalMatched: number;
  recipientCount: number;
  existingCrmCount: number;
  importableCount: number;
  excludedCount: number;
  criteria: string[];
  sourceDataAvailable: boolean;
  refreshedAt: string | null;
  sample: Array<{
    name: string;
    source: string;
    purchases: number;
    daysSincePurchase: number | null;
    destinationStatus: "crm" | "importar" | "excluido";
  }>;
}

export interface SavedCopilotCampaign {
  id: string;
  name: string;
  status: "borrador";
  recipientCount: number;
  importedCount: number;
  excludedCount?: number;
}

export async function sendCopilotMessage(message: string, conversationId?: string, campaignId?: string) {
  if (!isSupabaseConfigured || !supabase) {
    throw new Error("Conecta Supabase para usar el copiloto OpenAI.");
  }

  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Tu sesion expiro. Inicia sesion nuevamente.");

  const response = await fetch(getSupabaseFunctionUrl("crm-copilot", "message"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ message, conversationId, campaignId }),
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(String(payload.error ?? "No se pudo contactar el copiloto."));
  }

  const typedPayload = payload as CopilotMessageResponse;
  if (typedPayload.reportSnapshot) {
    typedPayload.reportSnapshot = normalizeReportSnapshot(typedPayload.reportSnapshot);
  }
  if (typedPayload.campaignDraft && !typedPayload.campaignDraft.recipientPreview) {
    typedPayload.campaignDraft.segmentQuery = message;
    typedPayload.campaignDraft.recipientPreview = {
      totalMatched: 0,
      recipientCount: 0,
      existingCrmCount: 0,
      importableCount: 0,
      excludedCount: 0,
      criteria: ["Actualiza la Edge Function para calcular destinatarios"],
      sourceDataAvailable: false,
      refreshedAt: null,
      sample: [],
    };
  }
  return typedPayload;
}

export async function saveCopilotCampaignDraft(
  draft: CopilotCampaignDraft,
  conversationId: string,
  idempotencyKey: string,
) {
  if (!isSupabaseConfigured || !supabase) {
    throw new Error("Conecta Supabase para guardar el borrador.");
  }

  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Tu sesion expiro. Inicia sesion nuevamente.");

  const response = await fetch(getSupabaseFunctionUrl("crm-copilot", "campaign-draft"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ draft, conversationId, idempotencyKey }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(String(payload.error ?? "No se pudo guardar el borrador de campana."));
  }

  return payload.campaign as SavedCopilotCampaign;
}

export async function getCopilotReport(filters: CopilotReportFilters) {
  if (!isSupabaseConfigured || !supabase) {
    throw new Error("Conecta Supabase para generar informes con datos reales.");
  }

  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Tu sesion expiro. Inicia sesion nuevamente.");

  const response = await fetch(getSupabaseFunctionUrl("crm-copilot", "report"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(filters),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(String(payload.error ?? "No se pudo generar el informe."));
  }
  return normalizeReportSnapshot(payload.report as CopilotReportSnapshot);
}

function normalizeReportSnapshot(report: CopilotReportSnapshot): CopilotReportSnapshot {
  if (report.agentIntelligence && report.financialAnalysis) return report;
  const definitions = [
    ["commercial", "Comercial"],
    ["marketing", "Marketing"],
    ["finance", "Finanzas"],
    ["collections", "Cobranza"],
    ["logistics", "Logistica"],
    ["foreign_trade", "Comercio exterior"],
    ["executive", "Gerencia"],
  ];
  return {
    ...report,
    agentIntelligence: report.agentIntelligence ?? {
      totalAgents: definitions.length,
      agentsWithData: 0,
      completedTasks: 0,
      failedTasks: 0,
      pendingTasks: 0,
      runningTasks: 0,
      pendingProposals: 0,
      criticalAlerts: 0,
      healthyIntegrations: 0,
      totalIntegrations: 0,
      agents: definitions.map(([type, label]) => ({
        type,
        label,
        status: "idle" as const,
        completed: 0,
        failed: 0,
        pending: 0,
        running: 0,
        successRate: 0,
        lastRunAt: null,
        summary: "Actualiza la Edge Function para incluir resultados de este agente.",
        warnings: [],
        metrics: [],
      })),
      taskStatus: [],
      taskTrend: [],
      proposalRisk: [],
      alertSeverity: [],
      integrationStatus: [],
    },
    financialAnalysis: report.financialAnalysis ?? emptyFinancialAnalysis(),
  };
}

function emptyFinancialAnalysis(): CopilotFinancialAnalysis {
  const now = new Date();
  const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  return {
    available: false,
    monthKey,
    monthLabel: now.toLocaleDateString("es-CL", { month: "long", year: "numeric" }),
    isCurrentMonth: true,
    updatedAt: null,
    periodStart: null,
    periodEnd: null,
    netSales: 0,
    grossSales: 0,
    salesTax: 0,
    salesDocuments: 0,
    netPurchases: 0,
    grossPurchases: 0,
    purchaseTax: 0,
    purchaseDocuments: 0,
    documentaryDifference: 0,
    documentaryMarginRate: 0,
    previousMonthNetSales: 0,
    salesTrendPercent: null,
    referenceGrossMargin: null,
    referenceMarginRate: null,
    profitabilityAvailable: false,
    profitabilityValue: null,
    profitabilityRate: null,
    accountingStatus: "sin_cierre",
    accountingPeriodLabel: "Sin cierre mensual",
    explanation: "La Edge Function actual no incluye todavia el corte financiero mensual.",
    warnings: [],
  };
}
