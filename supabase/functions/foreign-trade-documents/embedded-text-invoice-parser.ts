export type EmbeddedInvoiceLine = {
  source_index: number;
  source_page: number;
  source_row_label: string;
  supplier_product_code: null;
  supplier_sku: null;
  supplier_reference: null;
  sku: null;
  product_name: string;
  description: string;
  description_original: string;
  description_translated: null;
  model: null;
  brand: null;
  technical_attributes: string[];
  quantity: number;
  quantity_per_box: null;
  box_count: null;
  currency: null;
  unit_price: number;
  total_price: number;
  unit_weight_kg: null;
  gross_weight_kg: null;
  net_weight_kg: null;
  box_length_cm: null;
  box_width_cm: null;
  box_height_cm: null;
  cbm_per_box: null;
  cbm_total: null;
  country_of_origin: null;
  hs_code: null;
  confidence: number;
  warnings: string[];
};

export type EmbeddedInvoiceExtraction = {
  lines: EmbeddedInvoiceLine[];
  lineTotal: number;
  candidateCount: number;
  coverage: number;
  warnings: string[];
};

export const EMBEDDED_TEXT_INVOICE_PARSER_VERSION = "embedded_invoice_text_v1";

const rowStartPattern = /^\s*(\d{1,3})\s+(.+)$/;
const rowPattern = /^\s*(\d{1,3})\s+(.+?)\s+([\d,.]+)\s+([A-Za-z]+(?:\/[A-Za-z]+)?)\s+(?:US\$|USD\s*|\$)\s*([\d,.]+)\s+(?:US\$|USD\s*|\$)\s*([\d,.]+)\s*$/i;

export function parseEmbeddedTextInvoice(
  pages: string[],
  originalPageNumbers: number[] = [],
): EmbeddedInvoiceExtraction {
  const lines: EmbeddedInvoiceLine[] = [];
  const warnings: string[] = [];
  let candidateCount = 0;

  pages.forEach((pageText, pageIndex) => {
    const physicalPage = originalPageNumbers[pageIndex] || pageIndex + 1;
    const pageLines = normalizePageLines(pageText);
    let pending: { label: string; text: string } | null = null;

    const flushPending = () => {
      if (!pending) return;
      const parsed = parseInvoiceRow(pending.text, lines.length + 1, physicalPage);
      if (parsed) lines.push(parsed);
      pending = null;
    };

    for (const line of pageLines) {
      const start = line.match(rowStartPattern);
      if (start && isPlausibleRowLabel(start[1])) {
        flushPending();
        candidateCount += 1;
        pending = { label: start[1], text: line };
        if (rowPattern.test(pending.text)) flushPending();
        continue;
      }

      if (!pending) continue;
      if (isDocumentBoundary(line)) {
        flushPending();
        continue;
      }
      pending.text = `${pending.text} ${line}`.replace(/\s+/g, " ").trim();
      if (rowPattern.test(pending.text)) flushPending();
    }
    flushPending();
  });

  const printedLabels = lines.map((line) => Number(line.source_row_label));
  const duplicates = uniqueNumbers(printedLabels.filter((label, index) => printedLabels.indexOf(label) !== index));
  const skipped = missingLabels(printedLabels);
  if (duplicates.length) {
    warnings.push(`El proveedor repitió los números de fila ${duplicates.join(", ")}; se conservaron como referencia y se usó el orden físico para importar.`);
  }
  if (skipped.length) {
    warnings.push(`El proveedor omitió los números de fila ${skipped.join(", ")}; no se descartaron productos y se usó el orden físico para importar.`);
  }

  const coverage = candidateCount > 0 ? lines.length / candidateCount : 0;
  return {
    lines,
    lineTotal: roundMoney(lines.reduce((sum, line) => sum + line.total_price, 0)),
    candidateCount,
    coverage,
    warnings,
  };
}

function parseInvoiceRow(
  value: string,
  sourceIndex: number,
  sourcePage: number,
): EmbeddedInvoiceLine | null {
  const match = value.match(rowPattern);
  if (!match) return null;
  const quantity = parseDocumentNumber(match[3]);
  const unitPrice = parseDocumentNumber(match[5]);
  const totalPrice = parseDocumentNumber(match[6]);
  if (quantity === null || unitPrice === null || totalPrice === null) return null;
  const unit = match[4].toLowerCase();
  const productName = match[2].replace(/\s+/g, " ").trim();
  if (!productName) return null;
  const calculatedTotal = roundMoney(quantity * unitPrice);
  const rowWarnings = Math.abs(calculatedTotal - totalPrice) > 0.02
    ? [`Total impreso ${totalPrice} versus cantidad por precio ${calculatedTotal}.`]
    : [];

  return {
    source_index: sourceIndex,
    source_page: sourcePage,
    source_row_label: match[1],
    supplier_product_code: null,
    supplier_sku: null,
    supplier_reference: null,
    sku: null,
    product_name: productName,
    description: productName,
    description_original: productName,
    description_translated: null,
    model: null,
    brand: null,
    technical_attributes: [`Unidad documental: ${unit}`],
    quantity,
    quantity_per_box: null,
    box_count: null,
    currency: null,
    unit_price: unitPrice,
    total_price: totalPrice,
    unit_weight_kg: null,
    gross_weight_kg: null,
    net_weight_kg: null,
    box_length_cm: null,
    box_width_cm: null,
    box_height_cm: null,
    cbm_per_box: null,
    cbm_total: null,
    country_of_origin: null,
    hs_code: null,
    confidence: rowWarnings.length ? 0.96 : 0.995,
    warnings: rowWarnings,
  };
}

function normalizePageLines(value: string) {
  return value
    .replace(/\u00a0/g, " ")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function isPlausibleRowLabel(value: string) {
  const label = Number(value);
  return Number.isInteger(label) && label >= 1 && label <= 500;
}

function isDocumentBoundary(value: string) {
  return /^(?:INVOICE|COMMERCIAL|PACKING|TOTAL|SUBTOTAL|DEPOSIT|BALANCE|HANGZHOU|杭州|NO\.\s+DESCRIPTION)/i.test(value);
}

function parseDocumentNumber(value: string) {
  const normalized = value.replace(/,/g, "").trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function uniqueNumbers(values: number[]) {
  return [...new Set(values)].sort((left, right) => left - right);
}

function missingLabels(labels: number[]) {
  if (!labels.length) return [];
  const unique = new Set(labels);
  const minimum = Math.min(...labels);
  const maximum = Math.max(...labels);
  return Array.from({ length: maximum - minimum + 1 }, (_, index) => minimum + index)
    .filter((label) => !unique.has(label));
}

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
