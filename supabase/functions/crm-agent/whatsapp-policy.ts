import { replyWindow } from "../_shared/whatsapp-content.ts";

export const CLOSED_WINDOW_MESSAGE = "Este cliente se encuentra fuera de la ventana de atención de WhatsApp. Para iniciar la conversación debes utilizar una plantilla aprobada por Meta.";
export const templateWebhookFields = ["message_template_status_update", "message_template_quality_update", "template_category_update", "message_template_components_update"];

export function validWhatsAppWebhookAccount(value: unknown, wabaId: string, phoneId: string) {
  const row=(v:unknown):Record<string,unknown>=>v && typeof v==="object" && !Array.isArray(v)?v as Record<string,unknown>:{};
  const payload=row(value);
  return payload.object === "whatsapp_business_account" && Array.isArray(payload.entry) && payload.entry.length > 0 &&
    payload.entry.every(value => {const entry=row(value);return String(entry.id) === wabaId && Array.isArray(entry.changes) && entry.changes.length > 0 &&
      entry.changes.every(value => {const change=row(value);return templateWebhookFields.includes(String(change.field)) ||
        (change.field === "messages" && String(row(row(change.value).metadata).phone_number_id) === phoneId);});});
}

export class WhatsAppConversationPolicyService {
  static evaluate(message: Record<string, unknown> | null, phoneId: string, now = Date.now()) {
    const window = replyWindow(message, phoneId, now);
    return { ...window, state: window.open ? "OPEN" : "CLOSED", remainingSeconds: window.expiresAt ? Math.max(0, Math.floor((Date.parse(window.expiresAt) - now) / 1000)) : 0 };
  }
}

export function whatsappRoleAllowed(role: unknown, active: unknown, manage = false) {
  return active === true && (role === "administrador" || (!manage && role === "vendedor"));
}

export function redactMeta(value: unknown, secrets: string[] = []): unknown {
  if (typeof value === "string") {
    let text = value.replace(/Bearer\s+\S+|EAA[A-Za-z0-9_-]{20,}/g, "[REDACTED]");
    for (const secret of secrets.filter(Boolean)) text = text.split(secret).join("[REDACTED]");
    return text.slice(0, 16000);
  }
  if (Array.isArray(value)) return value.map(v => redactMeta(v, secrets));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, v]) => [key,
    /token|secret|authorization|password|cookie/i.test(key) ? "[REDACTED]" : redactMeta(v, secrets)]));
  return value;
}

export function metaFunctionalError(value: unknown) {
  const source = value as { error?: { code?: number }; code?: number } | undefined;
  const code = Number(source?.error?.code || source?.code);
  if (code === 131047) return "No se pudo enviar el mensaje porque la ventana de conversación está cerrada. Selecciona una plantilla aprobada.";
  if ([190, 102].includes(code)) return "El token de Meta necesita revisión por un administrador.";
  if ([10, 200].includes(code)) return "Meta no autorizó la operación. Revisa los permisos y los activos asignados a la integración.";
  if ([132001, 132015, 132016].includes(code)) return "Esta plantilla no está disponible para envío en Meta. Sincroniza su estado.";
  if ([131005, 133010].includes(code)) return "El número de WhatsApp no está correctamente configurado.";
  if ([131048, 131049, 130429].includes(code)) return "Meta limitó este envío. Revisa la calidad y los límites de la cuenta antes de volver a intentarlo.";
  return "Meta no pudo completar la operación. Un administrador puede consultar el detalle en la auditoría.";
}
