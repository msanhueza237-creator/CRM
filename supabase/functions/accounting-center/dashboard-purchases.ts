import { factoHeader, isPostableFactoDocument } from "./facto-document-policy.ts";
type Row = Record<string, unknown>;
const object = (value: unknown): Row => value && typeof value === "object" ? value as Row : {};
const number = (value: unknown) => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value)) ? Number(value) : null;

export function dashboardPurchaseEvidence(documents: Row[], asOf: string) {
  const seen = new Set<string>();
  return documents.flatMap(document => {
    const id = String(document.id || "");
    const issuedOn = String(document.issued_on || "");
    const type = String(document.document_type || "");
    const raw = object(document.raw_payload);
    let kind: "domestic" | "international" = "domestic";
    let netClp: number | null = null;
    let identity = id;
    if (document.source_type === "COMERCIO_EXTERIOR" && type === "inventory_receipt"
      && document.status === "posted" && document.data_quality === "validated") {
      kind = "international";
      // Landed costs may already be domestic supplier invoices. Count merchandise only.
      netClp = number(raw.merchandise_clp);
      identity = `receipt:${raw.operation_id || id}`;
    } else if (type.startsWith("purchase_") && isPostableFactoDocument(document)) {
      const header = factoHeader(raw);
      if (type === "purchase_document") kind = "international";
      identity = `${document.source_type || "FACTO"}:${header.document_id || document.external_id || id}`;
      const rate = document.currency === "CLP" ? 1 : number(document.exchange_rate);
      if (rate && rate > 0) {
        const net = number(document.net_amount);
        const exempt = number(document.exempt_amount) || 0;
        const total = number(document.total_clp);
        const tax = number(document.tax_amount);
        netClp = net !== null && net + exempt > 0 ? (net + exempt) * rate
          : total !== null && tax !== null ? total - tax * rate : null;
      }
    }
    if (!id || seen.has(identity) || !/^\d{4}-\d{2}-\d{2}$/.test(issuedOn) || issuedOn > asOf || netClp === null || netClp < 0) return [];
    seen.add(identity);
    const creditNote = type === "purchase_credit_note";
    return [{ id, folio: String(document.folio || document.external_id || "Sin folio"), issuedOn,
      netClp: creditNote ? -netClp : netClp, kind, creditNote,
      counterpart: String(document.counterpart_name || raw.supplier_name || "Proveedor internacional"), sourceType: String(document.source_type || "FACTO") }];
  });
}

export function dashboardDocumentTotals(purchases: ReturnType<typeof dashboardPurchaseEvidence>, sales: Array<{ netClp: number; creditNote: boolean }>) {
  const purchasesDomestic = purchases.filter(row => row.kind === "domestic").reduce((sum, row) => sum + row.netClp, 0);
  const purchasesInternational = purchases.filter(row => row.kind === "international").reduce((sum, row) => sum + row.netClp, 0);
  return { purchasesDomestic, purchasesInternational, purchasesNet: purchasesDomestic + purchasesInternational,
    purchaseCreditNotes: -purchases.filter(row => row.creditNote).reduce((sum, row) => sum + row.netClp, 0),
    salesCreditNotes: -sales.filter(row => row.creditNote).reduce((sum, row) => sum + row.netClp, 0) };
}
