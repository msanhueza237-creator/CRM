import { customerTaxId, hasCustomerTaxId, invoiceCustomers, customerClassificationPlan, newInvoiceCustomer } from "../_shared/invoice-customers.ts";
import { CopilotDataError, type Row } from "./contracts.ts";
import type { CopilotSources } from "./sources.ts";
import { todayChile } from "./dates.ts";

export const companyProfileFields = "id,name,legal_name,rut,type,priority,city,region,address,description,business_line,status,source,notes,website,instagram,facebook,email,phone,whatsapp,contact_name,contact_role,whatsapp_opt_in,whatsapp_status,next_follow_up,updated_at";
export const invoiceIdentityFields = "id,entity_id,document_type,folio,issued_on,counterpart_tax_id,counterpart_name,status,data_quality";

export async function identifiedCompany(source: CopilotSources, id: unknown) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(String(id || "")))
    throw new CopilotDataError("Selecciona una empresa por su ID, desde search_customers.", "INVALID_ARGUMENTS");
  const companies = await source.select(`companies?select=${companyProfileFields}&id=eq.${id}&limit=1`);
  if (!companies.length) throw new CopilotDataError("Empresa no encontrada.", "INVALID_ARGUMENTS");
  return companies[0];
}

export async function uniqueCompanyTaxId(source: CopilotSources, company: Row) {
  const key = customerTaxId(company.rut);
  if (!hasCustomerTaxId(key)) throw new CopilotDataError("La empresa no tiene un RUT verificable. No se unen ventas por nombre.", "INVALID_ARGUMENTS");
  const companies = await source.all("companies?select=id,rut&order=id.asc");
  if (companies.filter(c => customerTaxId(c.rut) === key).length !== 1)
    throw new CopilotDataError("Hay varias fichas con el mismo RUT. Revisa la identidad antes de atribuir ventas.", "INVALID_ARGUMENTS");
  return key;
}

export async function customerInvoiceDocuments(source: CopilotSources) {
  const entity = await source.entity();
  const documents = await source.all(`accounting_source_documents?select=${invoiceIdentityFields}&entity_id=eq.${entity}&document_type=like.sales_*&issued_on=lte.${todayChile()}&order=id.asc`, 50000);
  return { entity, documents };
}

export async function companyPurchaseHistory(source: CopilotSources, company: Row) {
  const key = await uniqueCompanyTaxId(source, company);
  const { entity, documents } = await customerInvoiceDocuments(source);
  const history = invoiceCustomers(documents, entity, todayChile()).find(h => h.taxId === key);
  return history ? { invoiceCount: history.documents.length, firstPurchase: history.firstPurchase, lastPurchase: history.lastPurchase, classification: "cliente", basis: "Facturas de venta vigentes en el CRM" }
    : { invoiceCount: 0, firstPurchase: null, lastPurchase: null, classification: company.status, basis: "Sin facturas verificadas en la evidencia disponible; no acredita ausencia de compras" };
}

export async function readCustomerClassification(source: CopilotSources) {
  const { entity, documents } = await customerInvoiceDocuments(source);
  const companies = await source.all("companies?select=id,name,legal_name,rut,status,updated_at&order=id.asc");
  const plan = customerClassificationPlan(companies, documents, entity, todayChile());
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(plan)));
  const fingerprint = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
  return { plan, fingerprint, entity, asOf: todayChile() };
}

export async function applyCustomerClassification(source: CopilotSources, fingerprint: unknown, traceId: string, includeNew = false) {
  if (source.actor.role !== "administrador") throw new CopilotDataError("Solo administracion puede reclasificar empresas.", "FORBIDDEN");
  const preview = await readCustomerClassification(source);
  if (fingerprint !== preview.fingerprint) throw new CopilotDataError("La evidencia cambio. Revisa nuevamente el lote antes de confirmar.", "INVALID_ARGUMENTS");
  const candidates = preview.plan.filter(p => p.action === "classify" || (includeNew && p.action === "create"));
  const audit = (event: string, metadata: Row, affected: number) => source.request("rest/v1/copilot_audit_events", { method: "POST", body: JSON.stringify({
    user_id: source.actor.id, trace_id: traceId, request_id: traceId, event_type: event, result: "ok", risk_level: "low", affected_count: affected, metadata_redacted: metadata,
  }) });
  await audit("invoice_customer_classification_confirmed", { fingerprint, confirmed: true, candidates: candidates.map(c => ({ companyId: c.companyId, previousStatus: c.previousStatus, documents: c.documents })) }, 0);
  const applied: string[] = [], created: string[] = [], conflicts: string[] = [];
  for (const candidate of candidates) {
    // Earlier writes in this batch are expected; this particular identity must not change.
    source.invalidateCache();
    const current = (await readCustomerClassification(source)).plan.find(p => p.taxId === candidate.taxId);
    if (JSON.stringify(current) !== JSON.stringify(candidate)) {
      conflicts.push(String(candidate.companyId || candidate.taxId));
      continue;
    }
    if (candidate.action === "create") {
      const row = await newInvoiceCustomer(preview.entity, candidate.taxId, candidate.companyName);
      const saved = await source.request("rest/v1/companies?on_conflict=id&select=id,status", { method: "POST",
        headers: { Prefer: "resolution=ignore-duplicates,return=representation" }, body: JSON.stringify(row) }, true) as Row[];
      if (saved.length === 1 && saved[0].id === row.id && saved[0].status === "cliente") { applied.push(String(saved[0].id)); created.push(String(saved[0].id)); }
      else conflicts.push(row.id);
      continue;
    }
    const version = candidate.updatedAt ? `&updated_at=eq.${encodeURIComponent(String(candidate.updatedAt))}` : "&updated_at=is.null";
    const saved = await source.request(`rest/v1/companies?id=eq.${candidate.companyId}&status=eq.${candidate.previousStatus}${version}&select=id,status`, {
      method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ status: "cliente" }),
    }, true) as Row[];
    if (saved.length === 1 && saved[0].status === "cliente") applied.push(String(candidate.companyId)); else conflicts.push(String(candidate.companyId));
  }
  await audit("invoice_customer_classification_applied", { fingerprint, applied, created, conflicts }, applied.length);
  return { applied, created, conflicts, unresolved: preview.plan.filter(p => ["ambiguous", "unlinked"].includes(p.action) || (!includeNew && p.action === "create")) };
}
