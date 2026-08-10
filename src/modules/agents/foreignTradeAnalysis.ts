import { syncGmailCustomsReferences } from "../../lib/gmailApi";
import { supabase } from "../../lib/supabase";

type IntegrationPayloadRecord = {
  external_id?: string | null;
  resource: string;
  payload: Record<string, unknown>;
  updated_at?: string | null;
};

function normalized(value: unknown) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function isAdCargasInvoice(row: IntegrationPayloadRecord) {
  const searchable = normalized(JSON.stringify(row.payload));
  return [
    "ad cargas internacional",
    "ads cargas internacional",
    "ads internacional cargo",
    "adscargas",
  ].some((alias) => searchable.includes(alias));
}

function isAgencyRodriguezReference(row: IntegrationPayloadRecord) {
  const searchable = normalized(JSON.stringify(row.payload));
  return (
    searchable.includes("agenciarodriguezpalma.cl") ||
    searchable.includes("j.rodriguez@agenciarodriguezpalma.cl")
  );
}

async function readAllIntegrationRows(
  provider: string,
  resources: string[],
  columns: string,
) {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const rows: IntegrationPayloadRecord[] = [];
  for (let from = 0; ; from += 1000) {
    let query = supabase
      .from("integration_records")
      .select(columns)
      .eq("provider", provider);
    query = resources.length === 1
      ? query.eq("resource", resources[0])
      : query.in("resource", resources);
    const { data, error } = await query.range(from, from + 999);
    if (error) throw error;
    rows.push(...((data ?? []) as unknown as IntegrationPayloadRecord[]));
    if ((data ?? []).length < 1000) break;
  }
  return rows;
}

export async function queueForeignTradeAnalysis() {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) {
    throw new Error("Tu sesión no está disponible. Vuelve a iniciar sesión.");
  }

  const inventoryRows = await readAllIntegrationRows(
    "facto",
    ["inventory_snapshots"],
    "payload",
  );
  const products = inventoryRows
    .map((row) => row.payload)
    .filter((payload) => Boolean(payload.sku));
  if (!products.length) {
    throw new Error("Facto aún no entrega productos para actualizar la propuesta.");
  }

  const freightRecords = await readAllIntegrationRows(
    "facto",
    ["purchase_documents", "purchase_document_details"],
    "external_id,resource,payload,updated_at",
  );

  let gmailSyncNote = "";
  try {
    const gmailSync = await syncGmailCustomsReferences();
    gmailSyncNote = ` Gmail revisó ${gmailSync.checked} correo(s) y sincronizó ${gmailSync.synced} referencia(s).`;
  } catch (error) {
    const message = error instanceof Error ? error.message : "No se pudo actualizar Gmail.";
    gmailSyncNote = ` No fue posible refrescar Gmail (${message}); se usarán las referencias ya guardadas.`;
  }

  const customsRows = await readAllIntegrationRows(
    "gmail",
    ["customs_cost_references"],
    "external_id,resource,payload,updated_at",
  );
  const freightByDocument = new Map<string, Record<string, unknown>>();
  freightRecords
    .filter(isAdCargasInvoice)
    .sort((left, right) =>
      left.resource === right.resource
        ? 0
        : left.resource === "purchase_documents"
          ? -1
          : 1,
    )
    .forEach((row, index) => {
      const key = row.external_id || String(row.payload.document_id ?? row.payload.id ?? index);
      freightByDocument.set(key, {
        ...row.payload,
        crm_external_id: row.external_id,
        crm_resource: row.resource,
        crm_updated_at: row.updated_at,
      });
    });
  const customsCostReferences = customsRows
    .filter(isAgencyRodriguezReference)
    .map((row) => ({
      ...row.payload,
      crm_external_id: row.external_id,
      crm_resource: row.resource,
      crm_updated_at: row.updated_at,
    }));

  const { data, error } = await supabase
    .from("business_agent_tasks")
    .insert({
      agent_type: "foreign_trade",
      action: "review_import_plan",
      requested_by: authData.user.id,
      payload: {
        products,
        as_of: new Date().toISOString().slice(0, 10),
        freight_invoices: Array.from(freightByDocument.values()),
        customs_cost_references: customsCostReferences,
        sources: [
          "facto_read_only",
          "crm/facto/purchase_documents/ad_cargas_internacional",
          "gmail/agenciarodriguezpalma.cl/j.rodriguez",
          "google_drive/agente comercio exterior/chinafore proveedor",
          "google_drive/agente comercio exterior/agencia",
        ],
      },
    })
    .select("id")
    .single();
  if (error) throw error;
  return {
    taskId: String(data.id),
    productCount: products.length,
    freightInvoiceCount: freightByDocument.size,
    customsReferenceCount: customsCostReferences.length,
    gmailSyncNote,
  };
}
