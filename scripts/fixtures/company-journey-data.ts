import { customerJourneyTool } from "../../supabase/functions/crm-copilot/customer-journey.ts";
import type { CopilotSources } from "../../supabase/functions/crm-copilot/sources.ts";
import type { getCompanyHistory } from "../../src/lib/copilotCentralApi";
const id = "11111111-1111-4111-8111-111111111111", company = { id, name: "Empresa de prueba", rut: "76919986-1", next_follow_up: "2026-10-15" };
const source = { actor: { role: "administrador" }, entity: async () => "entity", select: async () => [company],
  all: async (path: string) => {
    if (path.startsWith("companies?")) return [company];
    if (path.startsWith("tasks?")) return [{ id: "task", title: "Confirmar recepcion de cotizacion", due_date: "2026-10-15" }];
    if (path.startsWith("interactions?")) return Array.from({ length: 23 }, (_, i) => ({ id: `q${i}`, type: "cotizacion", description: `Cotizacion Facto ${200 + i} - Equipamiento de climatizacion y accesorios industriales`, occurred_at: "2026-10-01T12:00:00Z", result: "Referencia manual pendiente de respuesta", next_action: "Revisar con cliente" }));
    if (path.startsWith("accounting_source_documents?")) return [{ id: "inv", entity_id: "entity", source_type: "FACTO", document_type: "sales_invoice", counterpart_tax_id: company.rut, folio: 1500, issued_on: "2026-10-02", net_amount: 1900000, currency: "CLP", status: "validated", data_quality: "validated" }];
    return [];
  }, records: async () => [{ external_id: "12", updated_at: "2026-10-05T13:00:00Z", payload: { customer: { identification: company.rut }, number: 12, created_at: "2026-10-02T12:00:00Z", total: "2261000", currency: "CLP", status: "open", payment_status: "pending", shipping_status: "unpacked" } }],
} as unknown as CopilotSources;
export const loadFixtureHistory: typeof getCompanyHistory = async (companyId, period, section, query, offset) => {
  const result = await customerJourneyTool(source, { company_id: companyId, period, section, query, offset, limit: 20 });
  return query === "error" ? { ...result, status: "unavailable", summary: "Fuente no disponible", data: null } : result;
};
