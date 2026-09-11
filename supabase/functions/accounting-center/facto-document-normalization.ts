import { factoHeader } from "./facto-document-policy.ts";

type JsonRecord = Record<string, unknown>;

export function normalizeFactoDocument(payload: JsonRecord, purchase: boolean, externalId: string) {
  const document = factoHeader(payload);
  const counterpartObject = asObject(first(document, ["customer","client","supplier","provider","receptor","emisor"]));
  const currencyId = String(first(document, ["currency_id"]) || "");
  const currency = String(first(document, ["currency","moneda","currency_code"]) || (!currencyId || currencyId === "39" ? "CLP" : "UNK")).toUpperCase().slice(0, 3);
  const rate = numeric(first(document, ["exchange_rate","exchange_rate_value","tipo_cambio","dolar"])) || (currency === "CLP" ? 1 : 0);
  let net = numeric(first(document, ["net","net_amount","monto_neto","total_neto"]));
  const tax = numeric(first(document, ["tax","vat","iva","monto_iva","taxes_amount"]));
  let exempt = numeric(first(document, ["exempt","exempt_amount","monto_exento"]));
  const total = numeric(first(document, ["total","total_amount","monto_total","amount"]));
  const documentType = factoDocumentType(document, purchase);
  if (documentType.includes("exempt_") && tax === 0 && total > 0) {
    exempt = total;
    net = 0;
  }
  let counterpart = String(
    first(counterpartObject, ["name","business_name","razon_social"])
      || first(document, purchase
        ? ["issuer_name","issuer_legal_name","supplier_name","provider_name","razon_social"]
        : ["receiver_legal_name","receiver_name","customer_name","client_name","razon_social"])
      || "",
  ).trim();
  // Chilean receipts can legitimately omit the customer's identity. Preserve the
  // sale without inventing a person while keeping it reconcilable as consumer sales.
  if (!counterpart && !purchase && ["sales_receipt", "sales_exempt_receipt"].includes(documentType)) {
    counterpart = "Consumidor final";
  }
  const errors: string[] = [];
  if (currency === "UNK") errors.push("currency_unknown");
  if (!/^(sales|purchase)_(invoice|exempt_invoice|receipt|exempt_receipt|debit_note|credit_note|document)$/.test(documentType)) errors.push("document_type_unsupported");
  if (Math.abs(net + exempt + tax - total) > 1) errors.push("totals_mismatch");
  if (!counterpart) errors.push("counterpart_missing");
  if (!total) errors.push("total_missing");
  if (currency !== "CLP" && !rate) errors.push("exchange_rate_missing");
  return {
    documentType,
    folio: String(first(document, ["folio","number","document_number","numero"]) || externalId),
    taxId: String(
      first(counterpartObject, ["tax_id","rut","document_number"])
        || first(document, purchase
          ? ["issuer_tax_id_code","supplier_tax_id","provider_tax_id","rut"]
          : ["receiver_tax_id_code","customer_tax_id","client_tax_id","rut"])
        || "",
    ),
    counterpart,
    issuedOn: dateValue(first(document, ["issued_on","issue_date","date","fecha_emision","fecha"])),
    dueOn: dateValue(first(document, ["due_on","due_date","fecha_vencimiento"])),
    currency,
    exchangeRate: rate || 1,
    net, tax, exempt, total,
    totalClp: total * (rate || 1),
    sourceCreatedAt: dateTimeValue(first(document, ["created_at","createdAt","fecha_creacion"])),
    errors,
  };
}

function factoDocumentType(document: JsonRecord, purchase: boolean) {
  // Verified Facto foreign invoice type; its tax-bureau code is 0, not a DTE code.
  if (purchase && String(document.document_type_id) === "57") return "purchase_document";
  const taxType = String(first(document, ["document_type_taxbureau", "tax_document_type"]) || "");
  const direction = purchase ? "purchase" : "sales";
  const suffixByTaxType: Record<string, string> = {
    "33": "invoice",
    "34": "exempt_invoice",
    "39": "receipt",
    "41": "exempt_receipt",
    "56": "debit_note",
    "61": "credit_note",
  };
  if (suffixByTaxType[taxType]) return `${direction}_${suffixByTaxType[taxType]}`;
  if (taxType) return `${direction}_unsupported_${taxType}`;
  return String(first(document, ["document_type", "type", "tipo_documento"]) || `${direction}_invoice`);
}

function asObject(value: unknown): JsonRecord { return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {}; }
function numeric(value: unknown) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  let text = String(value ?? "").trim().replace(/[^0-9,.-]/g, "");
  if (!text) return 0;
  const comma = text.lastIndexOf(",");
  const dot = text.lastIndexOf(".");
  if (comma >= 0 && dot >= 0) {
    const decimal = comma > dot ? "," : ".";
    text = decimal === "," ? text.replace(/\./g, "").replace(",", ".") : text.replace(/,/g, "");
  } else if (comma >= 0) {
    const decimals = text.length - comma - 1;
    text = decimals > 0 && decimals <= 4 ? text.replace(/\./g, "").replace(",", ".") : text.replace(/,/g, "");
  } else if (dot >= 0) {
    const decimals = text.length - dot - 1;
    if (!(decimals > 0 && decimals <= 4)) text = text.replace(/\./g, "");
  }
  const number = Number(text);
  return Number.isFinite(number) ? number : 0;
}
function first(object: JsonRecord, keys: string[]) { for (const key of keys) if (object[key] !== undefined && object[key] !== null && object[key] !== "") return object[key]; return null; }
function dateValue(value: unknown) {
  const text = String(value || "").trim();
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const local = text.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})/);
  if (local) return `${local[3]}-${local[2].padStart(2, "0")}-${local[1].padStart(2, "0")}`;
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString().slice(0, 10);
}
function dateTimeValue(value: unknown) { const parsed = Date.parse(String(value || "")); return Number.isNaN(parsed) ? null : new Date(parsed).toISOString(); }
