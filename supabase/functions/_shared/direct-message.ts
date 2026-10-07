import { whatsappPhone } from "./whatsapp-content.ts";

export const MESSAGE_FILE_LIMIT = 10 * 1024 * 1024;
export const IMAGE_FILE_LIMIT = 5 * 1024 * 1024;
export const MESSAGE_FILE_ACCEPT = ".pdf,.jpg,.jpeg,.png,.doc,.docx,.xls,.xlsx";
export const messageUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export type MessageFile = { name: string; type: string; bytes: Uint8Array };
export type MessageRecipient = { companyId: string; contactId: string; companyName: string; name: string; phone: string; email: string };
const mimeExtensions: Record<string, string[]> = {
  "application/pdf": ["pdf"], "image/jpeg": ["jpg", "jpeg"], "image/png": ["png"],
  "application/msword": ["doc"], "application/vnd.ms-excel": ["xls"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ["docx"],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ["xlsx"],
};

export function validateMessageFile(file: { name: string; type: string; size: number }) {
  if (!file.name || file.name.length > 180 || /[\r\n\x00-\x1f"\\/]/.test(file.name)) throw new Error("Nombre de archivo no valido.");
  const extension = file.name.toLowerCase().split(".").pop() || "";
  if (!mimeExtensions[file.type]?.includes(extension)) throw new Error("Adjunta PDF, Word, Excel o imagen JPG/PNG.");
  if (!file.size || file.size > (file.type.startsWith("image/") ? IMAGE_FILE_LIMIT : MESSAGE_FILE_LIMIT)) throw new Error("Archivo demasiado grande: imagenes hasta 5 MB; documentos hasta 10 MB.");
}

export async function readMessageForm(req: Request, channel: "email" | "whatsapp") {
  const maxBytes = MESSAGE_FILE_LIMIT + 128 * 1024;
  if (!req.headers.get("content-type")?.startsWith("multipart/form-data") || !req.body) throw new Error("Formato de mensaje no valido.");
  if (Number(req.headers.get("content-length")) > maxBytes) throw new Error("Los adjuntos no pueden superar 10 MB en total.");
  const reader = req.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  for (;;) {
    const next = await reader.read(); if (next.done) break;
    size += next.value.byteLength;
    if (size > maxBytes) { await reader.cancel(); throw new Error("Los adjuntos no pueden superar 10 MB en total."); }
    chunks.push(next.value);
  }
  const form = await new Response(new Blob(chunks.map(chunk => new Uint8Array(chunk).buffer)), { headers: { "Content-Type": req.headers.get("content-type")! } }).formData();
  const payload = JSON.parse(String(form.get("message") || "{}"));
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || payload.confirmSend !== true || !messageUuid.test(payload.requestId || "")) throw new Error("Confirma el envio con un identificador valido.");
  const attachments = form.getAll("files");
  if (attachments.length > (channel === "whatsapp" ? 1 : 5)) throw new Error(channel === "whatsapp" ? "WhatsApp permite un adjunto por mensaje." : "Maximo cinco adjuntos por correo.");
  const files: MessageFile[] = []; let total = 0;
  for (const file of attachments) {
    if (typeof file === "string") throw new Error("Adjunto no valido.");
    validateMessageFile(file); total += file.size;
    if (total > MESSAGE_FILE_LIMIT) throw new Error("Los adjuntos no pueden superar 10 MB en total.");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const prefix = Array.from(bytes.slice(0, 8));
    const starts = (signature: number[]) => signature.every((v, i) => prefix[i] === v);
    const valid = file.type === "application/pdf" ? starts([37,80,68,70,45]) : file.type === "image/jpeg" ? starts([255,216,255]) :
      file.type === "image/png" ? starts([137,80,78,71,13,10,26,10]) : file.type.includes("openxmlformats") ? starts([80,75,3,4]) : starts([208,207,17,224,161,177,26,225]);
    if (!valid) throw new Error(`El contenido de ${file.name} no coincide con su formato.`);
    files.push({ name: file.name, type: file.type, bytes });
  }
  return { payload, files };
}

export function recipientFromRows(company: Record<string, any>, contact?: Record<string, any>): MessageRecipient {
  return { companyId: company.id, contactId: contact?.id || "", companyName: company.name,
    name: contact?.full_name || company.contact_name || company.name,
    phone: whatsappPhone(contact ? contact.whatsapp || contact.phone : company.whatsapp_number || company.whatsapp || company.phone),
    email: String(contact ? contact.email || "" : company.email || "").trim().toLowerCase() };
}

export async function resolveMessageRecipient(db: any, companyId: string, contactId = "") {
  if (!messageUuid.test(companyId) || (contactId && !messageUuid.test(contactId))) throw new Error("Selecciona una empresa o contacto valido.");
  const { data: company, error } = await db.from("companies").select("id,name,contact_name,email,phone,whatsapp,whatsapp_number,whatsapp_opt_in,whatsapp_status").eq("id", companyId).maybeSingle();
  if (error || !company) throw new Error("La empresa ya no esta disponible.");
  let contact;
  if (contactId) {
    const result = await db.from("contacts").select("id,company_id,full_name,email,phone,whatsapp").eq("id", contactId).eq("company_id", companyId).maybeSingle();
    if (result.error || !result.data) throw new Error("El contacto no pertenece a esta empresa.");
    contact = result.data;
  }
  return { company, recipient: recipientFromRows(company, contact) };
}

export async function messageFileMetadata(files: MessageFile[]) {
  const result = [];
  for (const file of files) result.push({ name: file.name, type: file.type, size: file.bytes.length,
    sha256: Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(file.bytes)))).map(v => v.toString(16).padStart(2, "0")).join("") });
  return result;
}

export function encodeBase64(bytes: Uint8Array) {
  let binary = ""; for (let i = 0; i < bytes.length; i += 16384) binary += String.fromCharCode(...bytes.subarray(i, i + 16384));
  return btoa(binary);
}
