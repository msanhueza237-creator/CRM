import { getSupabaseFunctionUrl, supabase } from "./supabase";
import type { MessageRecipient } from "../../supabase/functions/_shared/direct-message";
export type { MessageRecipient };
export type SendOutcome = { accepted: boolean; id: string; outcome: "accepted" | "rejected" | "uncertain"; warning: string | null };

async function directRequest<T>(fn: string, route: string, body?: FormData): Promise<T> {
  const { data } = await supabase!.auth.getSession();
  if (!data.session) throw new Error("Inicia sesion para enviar mensajes.");
  const response = await fetch(getSupabaseFunctionUrl(fn, route), { method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${data.session.access_token}` }, ...(body ? { body } : {}) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "No se pudo completar el mensaje.");
  return result;
}
export function getMessageRecipients() { return directRequest<{ recipients: MessageRecipient[] }>("crm-agent", "message-recipients"); }
export function sendDirectMessage(channel: "email" | "whatsapp", payload: Record<string, unknown>, files: File[]) {
  const form = new FormData(); form.set("message", JSON.stringify(payload));
  for (const file of files) form.append("files", file, file.name);
  return directRequest<SendOutcome>(channel === "email" ? "gmail-integration" : "crm-agent", channel === "email" ? "send-direct" : "meta-whatsapp-reply", form);
}
export async function getDirectEmailHistory(recipient: MessageRecipient) {
  const { data, error } = await supabase!.from("email_messages").select("id,subject,body_preview,status,created_at,sent_at,gmail_message_id")
    .eq("company_id", recipient.companyId).eq("to_email", recipient.email).order("created_at", { ascending: false }).limit(20);
  if (error) throw new Error("No se pudo leer el historial de correos.");
  return (data || []) as Array<{ id: string; subject: string; body_preview: string; status: string; created_at: string; sent_at: string | null; gmail_message_id: string | null }>;
}
