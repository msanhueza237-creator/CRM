type Row = Record<string, unknown>;
const object = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};

export function factoHeader(payload: Row): Row {
  const data = object(payload.data);
  const document = { ...object(data.document), ...object(payload.document) };
  return { ...payload, ...data, ...document, ...object(data.header), ...object(document.header),
    ...object(payload.header), ...object(data.totals), ...object(document.totals), ...object(payload.totals) };
}

export function factoIdentity(payload: Row, resource: string, fallback: string) {
  const header = factoHeader(payload);
  const flag = header.received_issued_flag;
  return {
    purchase: flag === 0 || flag === "0" ? true : flag === 1 || flag === "1" ? false : resource.includes("purchase"),
    externalId: String(header.document_id || fallback),
  };
}

export function isPostableFactoDocument(document: Row) {
  const type = String(document.document_type || "");
  const raw = object(document.raw_payload);
  const normalized = object(raw.normalized_data);
  const header = factoHeader(raw);
  const verifiedForeignWorkbook = type === "purchase_document" && raw.evidence === "Facto Excel complementario"
    && normalized.direction === "purchase" && /extranjera/i.test(String(normalized.document_type_label || ""));
  const verifiedForeignApi = type === "purchase_document" && String(header.document_type_id) === "57" && String(header.received_issued_flag) === "0";
  if ((!/^(sales|purchase)_(invoice|exempt_invoice|receipt|exempt_receipt|debit_note|credit_note)$/.test(type) && !verifiedForeignWorkbook && !verifiedForeignApi)
    || document.data_quality !== "validated" || !["validated", "posted"].includes(String(document.status))) return false;
  const flag = header.received_issued_flag;
  if ((flag === 0 || flag === "0") && type.startsWith("sales_")) return false;
  if ((flag === 1 || flag === "1") && type.startsWith("purchase_")) return false;
  return true;
}

export function factoReferenceLabel(payload: Row) {
  const references = factoHeader(payload).references;
  if (!Array.isArray(references)) return "";
  return references.map(value => {
    const reference = object(value);
    return reference.reference_number ? `Factura ${reference.reference_number}${reference.reference_date ? ` (${reference.reference_date})` : ""}` : "";
  }).filter(Boolean).join(", ");
}

export function factoPostingDate(document: Row, periods: Row[], adjustmentDate: string | null, today: string) {
  const issuedOn = String(document.issued_on || "");
  const isOpen = (date: string) => periods.some(period => ["open", "review"].includes(String(period.status))
    && date >= String(period.starts_on) && date <= String(period.ends_on));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(issuedOn) || issuedOn > today) throw new Error("Fecha de emisión no válida para contabilizar.");
  if (adjustmentDate && (!/^\d{4}-\d{2}-\d{2}$/.test(adjustmentDate) || adjustmentDate > today || adjustmentDate < issuedOn)) throw new Error("Fecha de regularización no válida.");
  if (isOpen(issuedOn)) return issuedOn;
  if (adjustmentDate && String(document.document_type).endsWith("_credit_note") && isOpen(adjustmentDate)) return adjustmentDate;
  throw new Error("El período original está cerrado o no existe. Una nota requiere fecha explícita de regularización en un período abierto.");
}
