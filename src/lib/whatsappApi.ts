import { getSupabaseFunctionUrl, isSupabaseConfigured, supabase } from "./supabase";
import type { WhatsAppConsentState } from "./whatsappConsent";
export interface MetaTemplate {
  id: string; name: string; language: string; status: string; category: string;
  body: string; header: string; footer: string; variables: string[];
  named: boolean; catalogIndexes: number[]; blockedReason: string | null;
  versionKey?: string;
  bindings?: Array<{ key: string; field: string; example: string }>;
}

export interface WhatsAppTemplatesResponse {
  templates: MetaTemplate[];
  ready: boolean;
  blockers: string[];
  phoneNumberId: string;
}

export interface WhatsAppDispatchResult {
  companyId: string;
  phone: string;
  success: boolean;
  messageId?: string;
  error?: string;
}

export async function whatsappRequest<T>(route: string, body?: unknown): Promise<T> {
  const token = await getSessionToken();
  const response = await fetch(getSupabaseFunctionUrl("crm-agent", route), {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "No se pudo completar la operacion WhatsApp.");
  return data as T;
}

export function getWhatsAppTemplates() {
  return whatsappRequest<WhatsAppTemplatesResponse>("meta-whatsapp-templates");
}

export interface WhatsAppCatalogSelection {
  kind: "order" | "enquiry"; catalogId: string; text: string;
  items: Array<{
    retailerId: string; quantity: number | null; unitPrice: number | null; currency: string | null; total: number | null;
    resolution: "matched" | "not_found" | "ambiguous" | "unavailable";
    product: { name: string; sku: string | null; variant: string | null; imageUrl: string | null; url: string | null;
      source: "tiendanube"; matchedBy: "variant_id" | "sku"; sourceUpdatedAt: string | null } | null;
  }>;
}

export interface WhatsAppConversation {
  companyId: string; name: string; phone: string; canReply: boolean; reasons: string[]; expiresAt: string | null;
  canTemplate: boolean; templateReasons: string[];
  variableContext?: Record<string,string>;
  consent?: WhatsAppConsentState;
  lastInboundAt?:string|null;lastOutboundAt?:string|null;
  nextOffset: number | null;
  messages: Array<{ id: string; direction: string; body: string; type: string; status: string; occurredAt: string; catalogSelection?: WhatsAppCatalogSelection }>;
}

export function getWhatsAppConversation(companyId: string, phone = "", offset = 0, contactId = "") {
  const query = new URLSearchParams({ companyId, phone, offset: String(offset), contactId });
  return whatsappRequest<WhatsAppConversation>(`meta-whatsapp-conversation?${query}`);
}

export interface WhatsAppAssistantPreview {
  mediaAnalysis?: {kind:"image"|"audio";text:string;observation:string;needsClarification:boolean}|null;
  messageId: string | null;
  plan: { action: "ignore" | "draft" | "clarify" | "handoff"; reason: string; text: string | null;
    requires: string; source: "tiendanube" | null; canSend: false };
}
export function getWhatsAppAssistantPreview(companyId: string, phone: string, contactId = "") {
  return whatsappRequest<WhatsAppAssistantPreview>(`whatsapp-assistant-preview?${new URLSearchParams({ companyId, phone, contactId })}`);
}

export function sendWhatsAppReply(body: { companyId: string; phone: string; text: string; requestId: string; confirmSend: true }) {
  return whatsappRequest<{ accepted: boolean; id: string; outcome: "accepted" | "rejected" | "uncertain"; warning: string | null }>("meta-whatsapp-reply", body);
}

export function sendWhatsAppCampaign(body: {
  campaignId: string; templateId: string; language: string; confirmSend: true; thumbnailProductId?: string;
  recipients: Array<{ companyId: string; phone: string; parameters: string[] }>;
}) {
  return whatsappRequest<{ success: boolean; results: WhatsAppDispatchResult[] }>("meta-whatsapp-send", body);
}

export interface WhatsAppConnectionStatus {
  ok: boolean;
  configured: boolean;
  checked_at: string;
  status: "pending_configuration" | "connected" | "degraded" | "error";
  webhook: {
    receiving: boolean;
    last_received_at: string | null;
  };
  cloud_api: {
    connected: boolean;
    phone_number_id: string | null;
    display_phone_number: string | null;
    verified_name: string | null;
    quality_rating: string | null;
    business_account_id: string | null;
    business_name: string | null;
  };
  production: {
    confirmed: boolean;
    message: string;
  };
  message: string;
}

async function getSessionToken() {
  if (!isSupabaseConfigured || !supabase) {
    throw new Error("Supabase no esta configurado.");
  }

  const { data, error } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (error || !token) throw new Error("Inicia sesion nuevamente para comprobar Meta.");
  return token;
}

export async function getWhatsAppConnectionStatus(): Promise<WhatsAppConnectionStatus> {
  const token = await getSessionToken();
  const response = await fetch(getSupabaseFunctionUrl("crm-agent", "meta-whatsapp-status"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ action: "check" }),
  });
  const data = (await response.json().catch(() => ({}))) as Partial<WhatsAppConnectionStatus> & { error?: string };

  if (!response.ok) {
    throw new Error(data.error || "No fue posible comprobar la conexion con Meta.");
  }

  return data as WhatsAppConnectionStatus;
}
