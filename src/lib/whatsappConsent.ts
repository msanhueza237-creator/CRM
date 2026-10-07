export interface WhatsAppConsentState {
  allowed: boolean;
  status?: string | null;
  date: string | null;
  source: string | null;
}

export function whatsAppContactBlocked(consent?: WhatsAppConsentState) {
  return ["opt_out", "no_contactar", "bloqueado", "invalido"].includes(consent?.status || "");
}

export function whatsAppConsentLabel(consent?: WhatsAppConsentState) {
  if (whatsAppContactBlocked(consent)) return "No contactable por WhatsApp";
  return consent?.allowed && consent.date ? "Consentimiento registrado" : "Pendiente de acreditar";
}
