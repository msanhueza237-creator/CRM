import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { whatsappPhone } from "../_shared/whatsapp-content.ts";
import { whatsappDispatchId } from "./whatsapp-meta.ts";

// Existing CRM records are read without changing customer-maintained fields.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
const companyFields = "id,whatsapp,whatsapp_number,phone";
const contactFields = "id,company_id,whatsapp,phone,whatsapp_opt_in,whatsapp_status,whatsapp_opt_in_date,whatsapp_opt_in_source,whatsapp_opt_in_phone";
const matchesPhone = (row: Row, phone: string) => [row.whatsapp_number, row.whatsapp, row.phone].some(value => whatsappPhone(value) === phone);

async function matchingRows(db: SupabaseClient, table: "companies" | "contacts", phone: string, companyId?: string) {
  const matches: Row[] = [];
  for (let offset = 0; offset < 100000; offset += 500) {
    let query = db.from(table).select(table === "companies" ? companyFields : contactFields).order("id");
    if (companyId) query = query.eq("company_id", companyId);
    const { data, error } = await query.range(offset, offset + 499);
    if (error) throw new Error("No se pudo verificar el contacto WhatsApp. No se creará una ficha sin comprobarlo.");
    matches.push(...(data || []).filter((row: Row) => matchesPhone(row, phone)));
    if ((data?.length || 0) < 500) return matches;
  }
  throw new Error("La búsqueda de contactos quedó incompleta. Se requiere revisión.");
}

export async function findWhatsAppContacts(db: SupabaseClient, companyId: string, phone: string) {
  return await matchingRows(db, "contacts", phone, companyId);
}

// A shared directory number can still have one established messaging thread.
// Never select the newest company arbitrarily or trust a customer's display name.
async function establishedCompany(db: SupabaseClient, phone: string, candidates: string[], replyTo: string) {
  const variants = [phone, `+${phone}`, ...(phone.startsWith("569") && phone.length === 11 ? [phone.slice(2)] : [])];
  const accepted = ["accepted", "sent", "delivered", "read"];
  if (replyTo) {
    const { data, error } = await db.from("whatsapp_messages").select("company_id,phone_number,direction,status")
      .eq("meta_message_id", replyTo).limit(2);
    if (error) throw new Error("No se pudo verificar el mensaje al que responde el cliente.");
    if (data?.length === 1) {
      const row = data[0];
      if (row.direction === "outbound" && accepted.includes(row.status) && whatsappPhone(row.phone_number) === phone && candidates.includes(row.company_id)) return row.company_id as string;
    }
    // An explicit but invalid reference must not fall back to another thread.
    return null;
  }
  const companyIds = new Set<string>();
  let hasAcceptedOutbound = false;
  for (let offset = 0; offset < 100000; offset += 500) {
    const { data, error } = await db.from("whatsapp_messages").select("company_id,direction,status")
      .in("phone_number", variants).order("id").range(offset, offset + 499);
    if (error) throw new Error("No se pudo verificar el hilo WhatsApp existente.");
    for (const row of data || []) {
      if (!row.company_id) continue;
      companyIds.add(row.company_id);
      if (row.direction === "outbound" && accepted.includes(row.status)) hasAcceptedOutbound = true;
    }
    if (companyIds.size > 1) return null;
    if ((data?.length || 0) < 500) {
      const companyId = [...companyIds][0];
      return hasAcceptedOutbound && candidates.includes(companyId) ? companyId : null;
    }
  }
  throw new Error("La comprobación del hilo WhatsApp quedó incompleta.");
}

export async function resolveIncomingWhatsAppRecipient(db: SupabaseClient, rawPhone: string, name: string, replyTo = "") {
  const phone = whatsappPhone(rawPhone);
  if (!/^[1-9]\d{7,14}$/.test(phone)) throw new Error("Remitente WhatsApp no válido.");
  const companies = await matchingRows(db, "companies", phone);
  const contacts = await matchingRows(db, "contacts", phone);
  const companyIds = [...new Set([...companies.map(row => row.id), ...contacts.map(row => row.company_id)].filter(Boolean))];
  let companyId: string = companyIds[0];
  if (companyIds.length > 1) {
    companyId = await establishedCompany(db, phone, companyIds, replyTo) || "";
    if (!companyId) return { companyId: null, contactId: null, ambiguous: true };
  }
  if (!companyId) {
    companyId = await whatsappDispatchId("incoming-company", phone);
    const { error } = await db.from("companies").insert({ id: companyId, name: `Contacto WhatsApp (+${phone})`,
      whatsapp: `+${phone}`, whatsapp_number: `+${phone}`, phone: `+${phone}`, status: "prospecto", source: "whatsapp_webhook",
      description: "Creado automáticamente mediante webhook de WhatsApp al recibir un mensaje." });
    if (error && error.code !== "23505") throw new Error("No se pudo registrar el contacto entrante.");
    if (error) {
      const { data, error: readError } = await db.from("companies").select(companyFields).eq("id", companyId).maybeSingle();
      if (readError || !data || !matchesPhone(data, phone)) throw new Error("La ficha entrante cambió; se requiere revisión.");
    }
  }
  const linked = contacts.filter(row => row.company_id === companyId);
  if (linked.length) return { companyId, contactId: linked.length === 1 ? linked[0].id as string : null, ambiguous: false };
  const contactId = await whatsappDispatchId(`incoming-contact:${companyId}`, phone);
  const { error } = await db.from("contacts").insert({ id: contactId, company_id: companyId, full_name: name || "Contacto WhatsApp",
    phone: `+${phone}`, whatsapp: `+${phone}`, is_primary: false, notes: "Detectado por respuesta entrante de WhatsApp Meta." });
  if (error && error.code !== "23505") throw new Error("No se pudo registrar el contacto entrante.");
  if (error) {
    const { data, error: readError } = await db.from("contacts").select(contactFields).eq("id", contactId).eq("company_id", companyId).maybeSingle();
    if (readError || !data || !matchesPhone(data, phone)) throw new Error("El contacto entrante cambió; se requiere revisión.");
  }
  return { companyId, contactId, ambiguous: false };
}
