type Row = Record<string, unknown>;
export const customerTaxId = (value: unknown) => String(value || "").replace(/[^0-9k]/gi, "").toUpperCase();
export const hasCustomerTaxId = (value: unknown) => /^\d{7,8}[0-9K]$/.test(customerTaxId(value));
export function validCustomerTaxId(value: unknown) {
  const key = customerTaxId(value);
  if (!hasCustomerTaxId(key)) return false;
  const sum = [...key.slice(0,-1)].reverse().reduce((total, digit, i) => total + Number(digit) * (2 + i % 6), 0);
  const digit = 11 - sum % 11;
  return key.at(-1) === (digit === 11 ? "0" : digit === 10 ? "K" : String(digit));
}
const companyNameKey = (value: unknown) => String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");

// Classification uses issued invoices, never purchases, guides, debt or notes.
export function invoiceCustomers(documents: Row[], entityId: string, through: string) {
  const groups = new Map<string, { taxId: string; name: string; documents: string[]; firstPurchase: string; lastPurchase: string }>();
  const seen = new Set<string>();
  for (const doc of documents) {
    const id = String(doc.id || ""), date = String(doc.issued_on || ""), key = customerTaxId(doc.counterpart_tax_id);
    if (!id || seen.has(id) || doc.entity_id !== entityId || !hasCustomerTaxId(key)
      || !["sales_invoice", "sales_exempt_invoice"].includes(String(doc.document_type))
      || !["validated", "posted"].includes(String(doc.status)) || doc.data_quality !== "validated"
      || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date))
      || new Date(date).toISOString().slice(0, 10) !== date || date > through) continue;
    seen.add(id);
    const group = groups.get(key) || { taxId: key, name: String(doc.counterpart_name || ""), documents: [], firstPurchase: date, lastPurchase: date };
    group.documents.push(id);
    group.firstPurchase = date < group.firstPurchase ? date : group.firstPurchase;
    if (date >= group.lastPurchase) { group.lastPurchase = date; group.name = String(doc.counterpart_name || group.name); }
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => a.taxId.localeCompare(b.taxId));
}

export function customerClassificationPlan(companies: Row[], documents: Row[], entityId: string, through: string) {
  return invoiceCustomers(documents, entityId, through).map(history => {
    const matches = companies.filter(c => customerTaxId(c.rut) === history.taxId);
    const company = matches.length === 1 ? matches[0] : undefined;
    const nameConflict = companies.some(c => companyNameKey(history.name) && [c.name,c.legal_name].some(n => companyNameKey(n) === companyNameKey(history.name)));
    const canCreate = validCustomerTaxId(history.taxId) && history.name.trim().length >= 3 && !nameConflict;
    return { ...history, companyId: company ? String(company.id) : null,
      companyName: String(company?.name || history.name), previousStatus: company ? String(company.status) : null,
      updatedAt: company?.updated_at || null,
      action: matches.length > 1 || (!company && nameConflict) ? "ambiguous" : !company ? canCreate ? "create" : "unlinked" : company.status === "cliente" ? "unchanged" : "classify" };
  });
}

export async function newInvoiceCustomer(entityId: string, taxId: string, name: string) {
  if (!validCustomerTaxId(taxId) || name.trim().length < 3) throw new Error("Identidad fiscal insuficiente para crear una ficha.");
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`crm-invoice-customer:${entityId}:${customerTaxId(taxId)}`));
  const hex = [...new Uint8Array(hash)].map(b=>b.toString(16).padStart(2,"0")).join("").slice(0,32);
  const id = `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20)}`;
  const rut = customerTaxId(taxId);
  return { id, name: name.trim(), legal_name: name.trim(), rut: `${rut.slice(0,-1)}-${rut.at(-1)}`, status: "cliente",
    type: "otro", priority: "media", source: "Facto - historial de facturas", whatsapp_opt_in: false, whatsapp_status: "sin_consentimiento" };
}
