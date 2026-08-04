import { getSupabaseFunctionUrl, isSupabaseConfigured, supabase } from "./supabase";

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
