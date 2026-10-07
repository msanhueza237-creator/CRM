import { collectModuleRows } from "./module-pagination.ts";
import { recipientFromRows } from "../_shared/direct-message.ts";

export async function getMessageRecipients(db: any) {
  const read = (table: string, fields: string) => collectModuleRows(async (offset, size) => {
    const { data, error, count } = await db.from(table).select(fields, { count: "exact" }).order("id").range(offset, offset + size - 1);
    if (error) throw new Error("No se pudieron leer todos los contactos del CRM.");
    return { rows: data || [], total: count };
  });
  const companies = await read("companies", "id,name,contact_name,email,phone,whatsapp,whatsapp_number");
  const contacts = await read("contacts", "id,company_id,full_name,email,phone,whatsapp");
  const byCompany = new Map(companies.map(c => [c.id, c]));
  return { recipients: [...companies.map(c => recipientFromRows(c)), ...contacts.flatMap(c => {
    const company = byCompany.get(c.company_id); return company ? [recipientFromRows(company, c)] : [];
  })] };
}
