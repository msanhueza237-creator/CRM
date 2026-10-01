import { customerClassificationPlan } from "../_shared/invoice-customers.ts";
import { accountingToday } from "../accounting-center/dashboard-sales.ts";

type Row = Record<string, any>;
// Only the CRM status changes; category, consent, history and accounting stay intact.
export async function classifyInvoiceCustomers(db: any, externalIds: string[], requestId: string) {
  const result = { classified: [] as string[], conflicts: [] as string[], unresolved: 0 };
  if (!externalIds.length) return result;
  const entities = await db.from("accounting_entities").select("id").eq("active", true).limit(2);
  if (entities.error || entities.data?.length !== 1) return { ...result, skipped: "entity_unverified" };
  const entity = entities.data[0].id;
  const evidence = await db.from("accounting_source_documents")
    .select("id,entity_id,document_type,issued_on,counterpart_tax_id,counterpart_name,status,data_quality")
    .eq("entity_id", entity).eq("source_type", "FACTO").in("external_id", externalIds).order("id");
  if (evidence.error) throw new Error("No se pudo verificar el historial de facturas del cliente.");
  const companies: Row[] = [];
  for (let offset = 0; offset < 50000; offset += 500) {
    const page = await db.from("companies").select("id,name,rut,status,updated_at").order("id").range(offset, offset + 499);
    if (page.error) throw new Error("No se pudo verificar la identidad de las empresas.");
    companies.push(...page.data);
    if (page.data.length < 500) break;
    if (offset === 49500) throw new Error("La base de empresas supera el limite verificable.");
  }
  const plan = customerClassificationPlan(companies, evidence.data || [], entity, accountingToday());
  result.unresolved = plan.filter(p => ["ambiguous", "unlinked", "create"].includes(p.action)).length;
  for (const item of plan.filter(p => p.action === "classify")) {
    const audit = await db.from("copilot_audit_events").insert({ request_id: requestId, trace_id: requestId,
      event_type: "invoice_customer_auto_classification", risk_level: "low", result: "requested", affected_count: 0,
      metadata_redacted: { companyId: item.companyId, previousStatus: item.previousStatus, documents: item.documents, rule: "verified_invoice_customer" } });
    if (audit.error) throw new Error("No se pudo respaldar la reclasificacion de cliente.");
    let update = db.from("companies").update({ status: "cliente" }).eq("id", item.companyId).eq("status", item.previousStatus);
    update = item.updatedAt ? update.eq("updated_at", item.updatedAt) : update.is("updated_at", null);
    const saved = await update.select("id,status");
    if (saved.error) throw new Error("No se pudo clasificar al cliente facturado.");
    if (saved.data?.length === 1 && saved.data[0].status === "cliente") result.classified.push(String(item.companyId));
    else result.conflicts.push(String(item.companyId));
  }
  if (result.classified.length || result.conflicts.length) {
    const audit = await db.from("copilot_audit_events").insert({ request_id: requestId, trace_id: requestId,
      event_type: "invoice_customer_auto_classification_completed", risk_level: "low", result: "ok",
      affected_count: result.classified.length, metadata_redacted: result });
    if (audit.error) throw new Error("Reclasificacion realizada; no se pudo completar su auditoria. Revisar antes de reintentar.");
  }
  return result;
}
