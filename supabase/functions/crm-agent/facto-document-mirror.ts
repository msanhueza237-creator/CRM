import { factoHeader, factoIdentity } from "../accounting-center/facto-document-policy.ts";
import { normalizeFactoDocument } from "../accounting-center/facto-document-normalization.ts";

type Row = Record<string, any>;
const taxId = (value: unknown) => String(value || "").replace(/[^0-9k]/gi, "").toUpperCase();
const object = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const sourceFields = "id,source_key,external_id,document_type,folio,issued_on,counterpart_tax_id,status,source_updated_at";

// This projection only stages documents. The ledger, collections, payments and
// bank reconciliations are deliberately outside the integration key's scope.
export function planFactoDocumentMirror(record: Row, resource: string, entities: Row[], sources: Row[]) {
  const raw = object(record.payload);
  const header = factoHeader(raw);
  const flag = String(header.received_issued_flag ?? "");
  if (!["0", "1"].includes(flag)) return { skip: "direction_unverified" };
  const identity = factoIdentity(raw, resource, String(record.external_id || ""));
  if (identity.purchase !== resource.includes("purchase")) return { skip: "wrong_resource" };
  const companyTaxId = taxId(identity.purchase ? header.receiver_tax_id_code : header.issuer_tax_id_code);
  const matches = entities.filter(entity => companyTaxId && taxId(entity.tax_id) === companyTaxId);
  if (matches.length !== 1) return { skip: "company_unverified" };
  const entity = matches[0];
  const normalized = normalizeFactoDocument(raw, identity.purchase, identity.externalId);
  if (normalized.errors.length || !normalized.issuedOn || !normalized.folio || !identity.externalId
    || !/^\d{4}-\d{2}-\d{2}$/.test(normalized.issuedOn)
    || Number.isNaN(Date.parse(normalized.issuedOn))
    || new Date(normalized.issuedOn).toISOString().slice(0, 10) !== normalized.issuedOn
    || normalized.totalClp <= 0 || normalized.net < 0 || normalized.exempt < 0 || normalized.tax < 0) return { skip: "invalid_document" };
  if (normalized.documentType === "purchase_document") return { skip: "foreign_purchase_requires_review" };
  const status = String(header.document_status ?? "");
  if (status !== "1") return { skip: "provider_status_requires_review" };
  const key = `facto:${identity.purchase ? "purchase" : "sale"}:${identity.externalId}`;
  const sameEntity = sources.filter(source => source.entity_id === entity.id || source.entity_id === undefined);
  const candidates = sameEntity.filter(source => source.source_key === key ||
    (String(source.external_id) === identity.externalId && String(source.document_type).startsWith(identity.purchase ? "purchase_" : "sales_")));
  if (candidates.length > 1) return { skip: "ambiguous_identity" };
  const previous = candidates[0];
  if (previous && !["validated", "inconsistent", "pending"].includes(previous.status)) return { skip: "protected_accounting_state" };
  if (previous?.source_updated_at && Date.parse(previous.source_updated_at) >= Date.parse(record.updated_at)) return { skip: "already_observed" };
  // An Excel-backed purchase is not a second purchase just because the API ID is new.
  if (!previous && sameEntity.some(source => String(source.source_key).startsWith("facto-workbook:")
    && source.folio === normalized.folio && source.issued_on === normalized.issuedOn
    && source.document_type === normalized.documentType
    && taxId(source.counterpart_tax_id) === taxId(normalized.taxId))) return { skip: "workbook_identity_requires_review" };
  return { previous, row: {
    entity_id: entity.id, source_type: "FACTO", source_key: previous?.source_key || key,
    source_id: record.id ? String(record.id) : null,
    document_type: normalized.documentType, external_id: identity.externalId,
    folio: normalized.folio, counterpart_tax_id: normalized.taxId, counterpart_name: normalized.counterpart,
    issued_on: normalized.issuedOn, due_on: normalized.dueOn, currency: normalized.currency,
    exchange_rate: normalized.exchangeRate, net_amount: normalized.net, tax_amount: normalized.tax,
    exempt_amount: normalized.exempt, total_amount: normalized.total, total_clp: normalized.totalClp,
    status: "validated", data_quality: "validated", raw_payload: raw,
    source_created_at: normalized.sourceCreatedAt, source_updated_at: record.updated_at,
    observed_at: record.observed_at, updated_at: record.updated_at,
  } };
}

export async function mirrorFactoDocuments(db: any, resource: string, records: Row[]) {
  const result = { staged: 0, skipped: 0, reasons: {} as Record<string, number> };
  if (!["documents", "purchase_documents"].includes(resource) || !records.length) return result;
  const entitiesResult = await db.from("accounting_entities").select("id,tax_id").eq("active", true);
  if (entitiesResult.error) throw new Error("No se pudo verificar la empresa contable de Facto.");
  const entities = entitiesResult.data || [];
  if (!entities.length) return result;
  const sources: Row[] = [];
  for (let offset = 0; ; offset += 500) {
    const page = await db.from("accounting_source_documents").select(`entity_id,${sourceFields}`)
      .eq("source_type", "FACTO").in("entity_id", entities.map((entity: Row) => entity.id))
      .order("id").range(offset, offset + 499);
    if (page.error) throw new Error("No se pudo verificar la identidad de los documentos Facto.");
    sources.push(...page.data);
    if (page.data.length < 500) break;
  }
  for (const record of records) {
    const plan = planFactoDocumentMirror(record, resource, entities, sources);
    if (!plan.row) {
      result.skipped++;
      result.reasons[plan.skip || "skipped"] = (result.reasons[plan.skip || "skipped"] || 0) + 1;
      continue;
    }
    // Conditional updates cannot overwrite an entry posted after our read.
    let write;
    if (plan.previous) {
      write = db.from("accounting_source_documents").update(plan.row).eq("id", plan.previous.id)
        .eq("status", plan.previous.status);
      write = plan.previous.source_updated_at
        ? write.eq("source_updated_at", plan.previous.source_updated_at)
        : write.is("source_updated_at", null);
    } else {
      write = db.from("accounting_source_documents").upsert(plan.row,
        { onConflict: "entity_id,source_type,source_key", ignoreDuplicates: true });
    }
    const saved = await write.select(`entity_id,${sourceFields}`);
    if (saved.error) throw new Error("No se pudo incorporar el documento Facto a Finanzas.");
    if (saved.data?.length) {
      result.staged++;
      const index = sources.findIndex(source => source.id === saved.data[0].id);
      if (index >= 0) sources[index] = saved.data[0]; else sources.push(saved.data[0]);
    }
  }
  return result;
}
