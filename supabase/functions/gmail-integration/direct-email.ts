import { encodeBase64, messageUuid, resolveMessageRecipient, type MessageFile } from "../_shared/direct-message.ts";

type Prepared = { accessToken: string; sender: string; dailyLimit: number; recordSent: () => Promise<void> };
const emailValid = (v: string) => /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(v);

export function directEmailMime(sender: string, to: string, subject: string, text: string, files: MessageFile[]) {
  if (!emailValid(sender) || !emailValid(to) || /[\r\n]/.test(subject)) throw new Error("Cabeceras de correo no validas.");
  const boundary = `crm_${crypto.randomUUID()}`;
  const encoded = (value: string) => encodeBase64(new TextEncoder().encode(value));
  const fold = (value: string) => value.match(/.{1,76}/g)?.join("\r\n") || "";
  const subjectCharacters = Array.from(subject), subjectWords = [];
  for (let i = 0; i < subjectCharacters.length; i += 10) subjectWords.push(`=?UTF-8?B?${encoded(subjectCharacters.slice(i, i + 10).join(""))}?=`);
  const lines = [`From: Climactiva <${sender}>`, `To: ${to}`, `Subject: ${subjectWords.join("\r\n ")}`,
    "MIME-Version: 1.0", `Content-Type: multipart/mixed; boundary="${boundary}"`, "", `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", fold(encoded(text))];
  for (const file of files) lines.push(`--${boundary}`, `Content-Type: ${file.type}`, "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; filename*=UTF-8''${encodeURIComponent(file.name).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`, "", fold(encodeBase64(file.bytes)));
  lines.push(`--${boundary}--`, "");
  return encoded(lines.join("\r\n")).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sendDirectEmail(db: any, payload: Record<string, any>, files: MessageFile[], userId: string,
  prepare: () => Promise<Prepared>, request: typeof fetch = fetch) {
  const subject = typeof payload.subject === "string" ? payload.subject.trim() : "";
  const text = typeof payload.text === "string" ? payload.text.trim() : "";
  if (payload.confirmSend !== true || !messageUuid.test(payload.requestId || "") || !subject || subject.length > 200 || /[\r\n]/.test(subject) || !text || text.length > 20000) throw new Error("Confirma destinatario, asunto y mensaje antes de enviar.");
  const { recipient } = await resolveMessageRecipient(db, String(payload.companyId || ""), String(payload.contactId || ""));
  if (!emailValid(recipient.email) || recipient.email !== payload.email) throw new Error("El correo no coincide con la ficha actual del contacto.");
  const { data: pending, error: pendingError } = await db.from("email_messages").select("id").eq("company_id", recipient.companyId).eq("to_email", recipient.email).eq("status", "pending").limit(1).maybeSingle();
  if (pendingError || pending) throw new Error("Hay un correo pendiente o no se pudo verificar su estado. Revisa el historial antes de reenviar.");
  const prepared = await prepare();
  const raw = directEmailMime(prepared.sender, recipient.email, subject, text, files);
  const id = payload.requestId;
  const preview = [text, ...files.map(f => `Adjunto: ${f.name}`)].join("\n");
  const { error: reserveError } = await db.from("email_messages").insert({ id, company_id: recipient.companyId, campaign_id: null,
    to_email: recipient.email, subject, body_preview: preview, status: "pending", created_by: userId });
  if (reserveError) throw new Error("No se pudo reservar el envio o este intento ya existe. Revisa el historial; no se contacto a Gmail.");
  try {
    // Count persisted reservations as well as accepted mail; uncertain sends also consume capacity.
    const { count, error } = await db.from("email_messages").select("id", { count: "exact", head: true })
      .gte("created_at", `${new Date().toISOString().slice(0, 10)}T00:00:00Z`).in("status", ["pending", "sent"]);
    if (error || !Number.isSafeInteger(count) || count > prepared.dailyLimit) throw new Error("No hay capacidad diaria verificable.");
    const current = await resolveMessageRecipient(db, recipient.companyId, recipient.contactId);
    if (current.recipient.email !== recipient.email) throw new Error("El destinatario cambio antes del envio.");
  } catch {
    await db.from("email_messages").update({ status: "failed", error_message: "Envio detenido antes de contactar Gmail: limite o destinatario sin verificar." }).eq("id", id);
    return { accepted: false, id, outcome: "rejected", warning: "No se envio: revisa el limite diario y la ficha del destinatario." };
  }
  try {
    // Never retry a message POST automatically: a timeout may already have delivered it.
    const response = await request("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST", headers: { Authorization: `Bearer ${prepared.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ raw }), signal: AbortSignal.timeout(30000),
    });
    const data = await response.json();
    if (!response.ok && response.status < 500 && response.status !== 408) {
      const { error } = await db.from("email_messages").update({ status: "failed", error_message: `Gmail rechazo el correo (${response.status}).` }).eq("id", id);
      return { accepted: false, id, outcome: "rejected", warning: `Gmail rechazo el correo (${response.status}).${error ? " El estado local requiere revision." : ""}` };
    }
    if (!response.ok || typeof data.id !== "string" || !data.id) throw new Error("uncertain-send");
    const { error } = await db.from("email_messages").update({ status: "sent", gmail_message_id: data.id, sent_at: new Date().toISOString() }).eq("id", id);
    let ancillaryError = false;
    try {
      await prepared.recordSent();
      const saved = await db.from("interactions").insert({ company_id: recipient.companyId, contact_id: recipient.contactId || null,
        type: "correo", owner_id: userId, description: `Correo a ${recipient.name} <${recipient.email}>\n${subject}\n${preview}`,
        result: "Aceptado por Gmail", next_action: "Esperar respuesta" });
      ancillaryError = Boolean(saved.error);
    } catch { ancillaryError = true; }
    return { accepted: true, id, outcome: "accepted", warning: error || ancillaryError ? "Gmail acepto el correo; el registro local requiere revision. No reenviar." : null };
  } catch {
    return { accepted: false, id, outcome: "uncertain", warning: "Resultado incierto. El intento queda reservado; revisa Gmail y el historial antes de volver a enviar." };
  }
}
