import { getSupabaseFunctionUrl, isSupabaseConfigured, supabase } from "./supabase";

// ── Types ──────────────────────────────────────────────────────────

export interface GmailStatus {
  connected: boolean;
  connectedEmail: string | null;
  status: string;
  dailyLimit: number;
  sentToday: number;
  lastConnectedAt: string | null;
  lastHealthCheckAt: string | null;
  lastError: string | null;
}

export interface GmailMetrics {
  sentToday: number;
  dailyLimit: number;
  activeCampaigns: number;
  failedEmails: number;
  companiesContacted: number;
  lastCampaign: string | null;
}

export interface GmailCampaignPayload {
  name: string;
  subject: string;
  bodyText: string;
  bodyHtml: string;
  segmentFilters: Record<string, unknown>;
  recipients: {
    companyId: string;
    toEmail: string;
    variables?: Record<string, string>;
  }[];
  attachments?: {
    name: string;
    url: string;
  }[];
}

export interface GmailCampaignResult {
  success: boolean;
  campaignId: string;
  sent: number;
  failed: number;
  log: string[];
}

export interface GmailReplySyncResult {
  checked: number;
  replies: {
    campaignId: string;
    campaignName: string;
    companyId: string;
    fromEmail: string;
    subject: string;
    snippet: string;
    body: string;
    gmailMessageId: string;
    receivedAt: string;
  }[];
  log: string[];
}

export interface GmailTestResult {
  success: boolean;
  message: string;
  gmailMessageId?: string;
}

// ── Defaults ───────────────────────────────────────────────────────

export const emptyGmailStatus: GmailStatus = {
  connected: false,
  connectedEmail: null,
  status: "disconnected",
  dailyLimit: 50,
  sentToday: 0,
  lastConnectedAt: null,
  lastHealthCheckAt: null,
  lastError: null,
};

export const emptyGmailMetrics: GmailMetrics = {
  sentToday: 0,
  dailyLimit: 0,
  activeCampaigns: 0,
  failedEmails: 0,
  companiesContacted: 0,
  lastCampaign: null,
};

// ── Internal helpers ───────────────────────────────────────────────

async function getSessionToken(): Promise<string> {
  if (!isSupabaseConfigured || !supabase) {
    throw new Error("Conecta Supabase para usar Gmail API.");
  }
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Sesion requerida.");
  return token;
}

async function callGmail<T = unknown>(
  route: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const token = await getSessionToken();
  const functionUrl = getSupabaseFunctionUrl("gmail-integration", route);
  const method = options.method || "GET";

  let response: Response;
  try {
    response = await fetch(functionUrl, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  } catch {
    throw new Error(
      "No se pudo contactar la Edge Function gmail-integration. Revisa que este servida o desplegada en Supabase.",
    );
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      data.error ||
        `Error en gmail-integration (${response.status}). Revisa que la funcion este desplegada.`,
    );
  }
  return data as T;
}

// ── Public API ─────────────────────────────────────────────────────

export async function getGmailStatus(): Promise<GmailStatus> {
  return callGmail<GmailStatus>("status");
}

export async function getGmailMetrics(): Promise<GmailMetrics> {
  return callGmail<GmailMetrics>("metrics");
}

export async function getGmailAuthUrl(returnTo: string): Promise<string> {
  const data = await callGmail<{ authUrl: string }>(`auth?return_to=${encodeURIComponent(returnTo)}`);
  return data.authUrl;
}

export async function disconnectGmail(): Promise<void> {
  await callGmail("disconnect", { method: "POST", body: {} });
}

export async function saveGmailSettings(dailyLimit: number): Promise<void> {
  await callGmail("settings", { method: "POST", body: { dailyLimit } });
}

export async function sendGmailTest(toEmail: string): Promise<GmailTestResult> {
  return callGmail<GmailTestResult>("test-send", { method: "POST", body: { toEmail } });
}

export async function sendGmailCampaign(payload: GmailCampaignPayload): Promise<GmailCampaignResult> {
  return callGmail<GmailCampaignResult>("send-campaign", { method: "POST", body: payload });
}

export async function syncGmailReplies(): Promise<GmailReplySyncResult> {
  return callGmail<GmailReplySyncResult>("sync-replies", { method: "POST", body: {} });
}
