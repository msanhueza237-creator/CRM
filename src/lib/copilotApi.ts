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
  tools: CopilotToolSummary[];
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

export async function sendCopilotMessage(message: string, conversationId?: string) {
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
    body: JSON.stringify({ message, conversationId }),
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(String(payload.error ?? "No se pudo contactar el copiloto."));
  }

  const typedPayload = payload as CopilotMessageResponse;
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
