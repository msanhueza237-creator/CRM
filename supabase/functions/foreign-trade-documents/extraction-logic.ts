export type JsonRecord = Record<string, unknown>;

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
  pageCount: number;
  pageNumbers: number[];
  general: {
    supplier_name: string | null;
    proforma_number: string | null;
    document_date: string | null;
    currency: string | null;
    incoterm: string | null;
    origin_port: string | null;
    destination_port: string | null;
    payment_terms: string | null;
    order_number: string | null;
    confidence: number;
    warnings: string[];
  };
  warnings: string[];
};

export const EMBEDDED_TEXT_INVOICE_PARSER_VERSION = "embedded_invoice_text_v2";
export const EMBEDDED_TEXT_PACKING_LIST_PARSER_VERSION = "embedded_packing_list_text_v1";

export type EmbeddedPackingListExtraction = {
  lines: Array<{
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
    model: string | null;
    brand: null;
    technical_attributes: string[];
    quantity: number;
    quantity_per_box: number | null;
    box_count: number | null;
    currency: null;
    unit_price: null;
    total_price: null;
    unit_weight_kg: number | null;
    gross_weight_kg: number | null;
    net_weight_kg: number | null;
    box_length_cm: null;
    box_width_cm: null;
    box_height_cm: null;
    cbm_per_box: number | null;
    cbm_total: number | null;
    country_of_origin: null;
    hs_code: null;
    confidence: number;
    warnings: string[];
  }>;
  candidateCount: number;
  coverage: number;
  pageCount: number;
  pageNumbers: number[];
  general: EmbeddedInvoiceExtraction["general"];
  documentTotals: {
    boxes: number | null;
    cbm_total: number | null;
    gross_weight_kg: number | null;
    net_weight_kg: number | null;
  };
  warnings: string[];
};

const embeddedInvoiceRowStartPattern = /^\s*(\d{1,3})\s+(.+)$/;
const embeddedInvoiceRowPattern = /^\s*(\d{1,3})\s+(.+?)\s+([\d,.]+)\s+([A-Za-z]+(?:\/[A-Za-z]+)?)\s+(?:US\$|USD\s*|\$)\s*([\d,.]+)\s+(?:US\$|USD\s*|\$)\s*([\d,.]+)\s*$/i;

const embeddedPackingRowStartPattern = /^\s*(\d{1,3})(?:\s+(.+))?\s*$/;
const embeddedPackingRowPattern = /^\s*(\d{1,3})\s+(.+?)\s+([\d,.]+)\s+(pcs|pairs|sets)\b(.*)$/i;
const embeddedPackingMetricsPattern = /([\d,.]+)\s+CTNS?\s+([\d,.]+)\s+CBM\s+([\d,.]+)\s+KGS?\s+([\d,.]+)\s+KGS?/gi;

export function parseEmbeddedTextPackingList(
  pages: string[],
  originalPageNumbers: number[] = [],
): EmbeddedPackingListExtraction {
  const lines: EmbeddedPackingListExtraction["lines"] = [];
  const warnings: string[] = [];
  let candidateCount = 0;

  pages.forEach((pageText, pageIndex) => {
    if (!/PACKING\s+LIST|装\s*箱\s*单/i.test(pageText)) return;
    const physicalPage = originalPageNumbers[pageIndex] || pageIndex + 1;
    const pageLines = normalizeEmbeddedPackingPageLines(pageText);
    let pending: string | null = null;

    const flushPending = () => {
      if (!pending) return;
      const parsed = parseEmbeddedPackingRow(pending, lines.length + 1, physicalPage);
      if (parsed) lines.push(parsed);
      pending = null;
    };

    for (const line of pageLines) {
      const start = line.match(embeddedPackingRowStartPattern);
      if (
        start
        && isPlausibleEmbeddedInvoiceRowLabel(start[1])
        && !/^(?:pcs|pairs|sets|ctns?|cbm|kgs?)\b/i.test(start[2] || "")
      ) {
        flushPending();
        candidateCount += 1;
        pending = `${start[1]} ${start[2] || ""}`.trim();
        continue;
      }
      if (!pending) continue;
      if (isEmbeddedPackingDocumentBoundary(line)) {
        flushPending();
        continue;
      }
      pending = `${pending} ${line}`.replace(/\s+/g, " ").trim();
    }
    flushPending();
  });

  const rowsWithoutOwnMetrics = lines.filter((line) => line.box_count === null).length;
  if (rowsWithoutOwnMetrics) {
    warnings.push(`${rowsWithoutOwnMetrics} producto(s) no tienen empaque individual impreso; pueden compartir cajas con otras líneas y se conservaron sin distribuir valores arbitrariamente.`);
  }
  const documentTotals = parseEmbeddedPackingTotals(pages.join("\n"));
  const pageNumbers = uniqueEmbeddedInvoiceNumbers(lines.map((line) => line.source_page));
  return {
    lines,
    candidateCount,
    coverage: candidateCount > 0 ? lines.length / candidateCount : 0,
    pageCount: pages.length,
    pageNumbers,
    general: parseEmbeddedPackingGeneral(pages.join("\n")),
    documentTotals,
    warnings,
  };
}

function parseEmbeddedPackingRow(
  value: string,
  sourceIndex: number,
  sourcePage: number,
): EmbeddedPackingListExtraction["lines"][number] | null {
  const match = value.match(embeddedPackingRowPattern);
  if (!match) return null;
  const quantity = parseEmbeddedInvoiceNumber(match[3]);
  if (quantity === null) return null;
  const productName = match[2].replace(/\s+/g, " ").trim();
  if (!productName) return null;

  const metricGroups = [...match[5].matchAll(new RegExp(embeddedPackingMetricsPattern.source, "gi"))];
  const boxes = sumEmbeddedPackingMetric(metricGroups, 1);
  const cbmTotal = sumEmbeddedPackingMetric(metricGroups, 2);
  const grossWeight = sumEmbeddedPackingMetric(metricGroups, 3);
  const netWeight = sumEmbeddedPackingMetric(metricGroups, 4);
  const rowWarnings = metricGroups.length
    ? []
    : ["La línea no tiene cajas, CBM o pesos propios impresos; puede compartir embalaje con otra línea."];
  const model = extractEmbeddedPackingModel(productName);

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
    model,
    brand: null,
    technical_attributes: [`Unidad documental: ${match[4].toLowerCase()}`],
    quantity,
    quantity_per_box: boxes !== null && boxes > 0 ? roundEmbeddedPackingValue(quantity / boxes, 6) : null,
    box_count: boxes,
    currency: null,
    unit_price: null,
    total_price: null,
    unit_weight_kg: netWeight !== null && quantity > 0 ? roundEmbeddedPackingValue(netWeight / quantity, 9) : null,
    gross_weight_kg: grossWeight,
    net_weight_kg: netWeight,
    box_length_cm: null,
    box_width_cm: null,
    box_height_cm: null,
    cbm_per_box: cbmTotal !== null && boxes !== null && boxes > 0 ? roundEmbeddedPackingValue(cbmTotal / boxes, 9) : null,
    cbm_total: cbmTotal,
    country_of_origin: null,
    hs_code: null,
    confidence: metricGroups.length ? 0.995 : 0.94,
    warnings: rowWarnings,
  };
}

function normalizeEmbeddedPackingPageLines(value: string) {
  return value
    .replace(/KGS(?=\d{1,3}\s)/gi, "KGS\n")
    .replace(/\u00a0/g, " ")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function isEmbeddedPackingDocumentBoundary(value: string) {
  return /^(?:杭州|HANGZHOU|INVOICE|PACKING\s+LIST|DATE|CONTRACT|TO:|CONT\s+NO\.?|SEAL\s+NO\.?|RUT:|FONO:|NO\.\s+DESCRIPTION|N\/M\s+|[\d,.]+\s+CTNS?\s+[\d,.]+\s+CBM\b)/i.test(value);
}

function sumEmbeddedPackingMetric(groups: RegExpMatchArray[], index: number) {
  if (!groups.length) return null;
  const values = groups.map((group) => parseEmbeddedInvoiceNumber(group[index])).filter((value): value is number => value !== null);
  return values.length ? roundEmbeddedPackingValue(values.reduce((sum, value) => sum + value, 0), 6) : null;
}

function parseEmbeddedPackingTotals(value: string): EmbeddedPackingListExtraction["documentTotals"] {
  const matches = [...value.matchAll(/(?:^|\n)\s*([\d,.]+)\s+CTNS?\s+([\d,.]+)\s+CBM\s+([\d,.]+)\s+KGS?\s+([\d,.]+)\s+KGS?/gim)];
  const total = matches.at(-1);
  return {
    boxes: total ? parseEmbeddedInvoiceNumber(total[1]) : null,
    cbm_total: total ? parseEmbeddedInvoiceNumber(total[2]) : null,
    gross_weight_kg: total ? parseEmbeddedInvoiceNumber(total[3]) : null,
    net_weight_kg: total ? parseEmbeddedInvoiceNumber(total[4]) : null,
  };
}

function parseEmbeddedPackingGeneral(value: string): EmbeddedInvoiceExtraction["general"] {
  const base = parseEmbeddedInvoiceGeneral(value);
  const container = value.match(/\bCONT\s+NO\.?\s*([A-Z0-9-]+)/i)?.[1] || null;
  const seal = value.match(/\bSEAL\s+NO\.?\s*([A-Z0-9-]+)/i)?.[1] || null;
  const observations = [container ? `Contenedor ${container}` : "", seal ? `Sello ${seal}` : ""].filter(Boolean).join(" · ") || null;
  return {
    ...base,
    currency: null,
    observations,
  } as EmbeddedInvoiceExtraction["general"] & { observations: string | null };
}

function extractEmbeddedPackingModel(value: string) {
  const stModel = (value.match(/\bST[- ]?[A-Z0-9]+(?:-[A-Z0-9]+)*\b/gi) || [])
    .find((candidate) => candidate.toUpperCase() !== "STARS");
  return stModel?.replace(/\s+/g, "-").toUpperCase()
    || value.match(/\b(?:BTG|QD|PCEC|CT|RI|SCV)-[A-Z0-9+-]+\b/i)?.[0]?.toUpperCase()
    || null;
}

function roundEmbeddedPackingValue(value: number, digits: number) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

export function parseEmbeddedTextInvoice(
  pages: string[],
  originalPageNumbers: number[] = [],
): EmbeddedInvoiceExtraction {
  const lines: EmbeddedInvoiceLine[] = [];
  const warnings: string[] = [];
  let candidateCount = 0;

  pages.forEach((pageText, pageIndex) => {
    const physicalPage = originalPageNumbers[pageIndex] || pageIndex + 1;
    const pageLines = normalizeEmbeddedInvoicePageLines(pageText);
    let pending: { text: string } | null = null;

    const flushPending = () => {
      if (!pending) return;
      const parsed = parseEmbeddedInvoiceRow(pending.text, lines.length + 1, physicalPage);
      if (parsed) lines.push(parsed);
      pending = null;
    };

    for (const line of pageLines) {
      const start = line.match(embeddedInvoiceRowStartPattern);
      if (start && isPlausibleEmbeddedInvoiceRowLabel(start[1])) {
        flushPending();
        candidateCount += 1;
        pending = { text: line };
        if (embeddedInvoiceRowPattern.test(pending.text)) flushPending();
        continue;
      }

      if (!pending) continue;
      if (isEmbeddedInvoiceDocumentBoundary(line)) {
        flushPending();
        continue;
      }
      pending.text = `${pending.text} ${line}`.replace(/\s+/g, " ").trim();
      if (embeddedInvoiceRowPattern.test(pending.text)) flushPending();
    }
    flushPending();
  });

  const printedLabels = lines.map((line) => Number(line.source_row_label));
  const duplicates = uniqueEmbeddedInvoiceNumbers(printedLabels.filter((label, index) => printedLabels.indexOf(label) !== index));
  const skipped = missingEmbeddedInvoiceLabels(printedLabels);
  if (duplicates.length) {
    warnings.push(`El proveedor repitió los números de fila ${duplicates.join(", ")}; se conservaron como referencia y se usó el orden físico para importar.`);
  }
  if (skipped.length) {
    warnings.push(`El proveedor omitió los números de fila ${skipped.join(", ")}; no se descartaron productos y se usó el orden físico para importar.`);
  }

  const pageNumbers = uniqueEmbeddedInvoiceNumbers(lines.map((line) => line.source_page));
  const coverage = candidateCount > 0 ? lines.length / candidateCount : 0;
  return {
    lines,
    lineTotal: roundEmbeddedInvoiceMoney(lines.reduce((sum, line) => sum + line.total_price, 0)),
    candidateCount,
    coverage,
    pageCount: pages.length,
    pageNumbers,
    general: parseEmbeddedInvoiceGeneral(pages.join("\n")),
    warnings,
  };
}

function parseEmbeddedInvoiceRow(
  value: string,
  sourceIndex: number,
  sourcePage: number,
): EmbeddedInvoiceLine | null {
  const match = value.match(embeddedInvoiceRowPattern);
  if (!match) return null;
  const quantity = parseEmbeddedInvoiceNumber(match[3]);
  const unitPrice = parseEmbeddedInvoiceNumber(match[5]);
  const totalPrice = parseEmbeddedInvoiceNumber(match[6]);
  if (quantity === null || unitPrice === null || totalPrice === null) return null;
  const unit = match[4].toLowerCase();
  const productName = match[2].replace(/\s+/g, " ").trim();
  if (!productName) return null;
  const calculatedTotal = roundEmbeddedInvoiceMoney(quantity * unitPrice);
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

function parseEmbeddedInvoiceGeneral(value: string): EmbeddedInvoiceExtraction["general"] {
  const supplier = value.match(/([A-Z][A-Z\s.,&()-]{4,80}(?:CO\.?\s*,?\s*LTD|LIMITED))/i)?.[1]
    ?.replace(/\s+/g, " ")
    .trim() || null;
  const invoiceNumber = value.match(/\bINVOICE\s+([A-Z0-9][A-Z0-9._/-]{2,39})\b/i)?.[1] || null;
  const orderNumber = value.match(/\b(?:CONTRACT|ORDER)\s*(?:NO\.?|NUMBER)?\s*[:#]?\s*([A-Z0-9][A-Z0-9._/-]{2,39})\b/i)?.[1] || null;
  const dateValue = value.match(/\bDATE\s+([0-3]?\d[-/.][A-Za-z]{3}[-/.]\d{2,4}|[0-3]?\d[-/.][01]?\d[-/.]\d{2,4})\b/i)?.[1] || "";
  const route = value.match(/\bFROM\s+([^\n]+?)\s+TO:\s*([^\n]+)/i);
  const payment = value.match(/\bPAYMENT\s+BY\s+([^\n]+)/i)?.[1]?.trim() || null;
  const incoterm = value.match(/\b(EXW|FOB|CFR|CIF|DAP|DDP|FCA)\b/i)?.[1]?.toUpperCase() || null;
  const currency = /(?:US\$|USD|\$\s*\d)/i.test(value) ? "USD" : null;
  const documentDate = normalizeEmbeddedInvoiceDate(dateValue);
  const recognized = [supplier, invoiceNumber, documentDate, currency, orderNumber].filter(Boolean).length;
  return {
    supplier_name: supplier,
    proforma_number: invoiceNumber || orderNumber,
    document_date: documentDate,
    currency,
    incoterm,
    origin_port: route?.[1]?.replace(/\s+/g, " ").trim() || null,
    destination_port: route?.[2]?.replace(/\s+/g, " ").trim() || null,
    payment_terms: payment,
    order_number: orderNumber,
    confidence: Math.min(0.99, 0.75 + recognized * 0.045),
    warnings: [],
  };
}

function normalizeEmbeddedInvoiceDate(value: string) {
  if (!value) return null;
  const normalized = value.replace(/[/.]/g, "-");
  const textual = normalized.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2}|\d{4})$/);
  if (textual) {
    const month = ({ jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 } as Record<string, number>)[textual[2].toLowerCase()];
    const year = textual[3].length === 2 ? 2000 + Number(textual[3]) : Number(textual[3]);
    if (month) return `${year}-${String(month).padStart(2, "0")}-${String(Number(textual[1])).padStart(2, "0")}`;
  }
  const numericDate = normalized.match(/^(\d{1,2})-(\d{1,2})-(\d{2}|\d{4})$/);
  if (!numericDate) return null;
  const year = numericDate[3].length === 2 ? 2000 + Number(numericDate[3]) : Number(numericDate[3]);
  return `${year}-${String(Number(numericDate[2])).padStart(2, "0")}-${String(Number(numericDate[1])).padStart(2, "0")}`;
}

function normalizeEmbeddedInvoicePageLines(value: string) {
  return value
    .replace(/\u00a0/g, " ")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function isPlausibleEmbeddedInvoiceRowLabel(value: string) {
  const label = Number(value);
  return Number.isInteger(label) && label >= 1 && label <= 500;
}

function isEmbeddedInvoiceDocumentBoundary(value: string) {
  return /^(?:INVOICE|COMMERCIAL|PACKING|TOTAL|SUBTOTAL|DEPOSIT|BALANCE|HANGZHOU|杭州|NO\.\s+DESCRIPTION)/i.test(value);
}

function parseEmbeddedInvoiceNumber(value: string) {
  const normalized = value.replace(/,/g, "").trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function uniqueEmbeddedInvoiceNumbers(values: number[]) {
  return [...new Set(values)].sort((left, right) => left - right);
}

function missingEmbeddedInvoiceLabels(labels: number[]) {
  if (!labels.length) return [];
  const unique = new Set(labels);
  const minimum = Math.min(...labels);
  const maximum = Math.max(...labels);
  return Array.from({ length: maximum - minimum + 1 }, (_, index) => minimum + index)
    .filter((label) => !unique.has(label));
}

function roundEmbeddedInvoiceMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export const FOREIGN_TRADE_EXTRACTION_VERSION = "pdf_skill_v15_embedded_text_documents";
export const FOREIGN_TRADE_FUND_REQUEST_EXTRACTION_VERSION = "fund_request_v1";
export const FOREIGN_TRADE_AGENCY_SETTLEMENT_EXTRACTION_VERSION = "agency_settlement_v2_documentary_summary";
export const FOREIGN_TRADE_FREIGHT_DOCUMENT_EXTRACTION_VERSION = "freight_document_v1";

export type ExtractionWarning = {
  code: string;
  message: string;
  severity: "info" | "warning" | "error";
  line_index: number | null;
};

export type ExtractionRange = {
  start: number;
  end: number;
};

export type ExtractionLineBatch = ExtractionRange & {
  data: unknown;
};

export type ForeignTradeDocumentScope = {
  selected_document_type: string;
  detected: boolean;
  page_start: number | null;
  page_end: number | null;
  page_numbers: number[];
  total_pdf_pages: number | null;
  confidence: number | null;
  evidence: string[];
  warnings: string[];
};

export function normalizeForeignTradeDocumentScope(value: unknown, expectedDocumentType = ""): ForeignTradeDocumentScope {
  const source = asObject(value);
  const totalPdfPages = positiveInteger(source.total_pdf_pages);
  const pageStart = positiveInteger(source.page_start);
  const pageEnd = positiveInteger(source.page_end);
  const explicitPages = (Array.isArray(source.page_numbers) ? source.page_numbers : [])
    .map(positiveInteger)
    .filter((page): page is number => page !== null && (!totalPdfPages || page <= totalPdfPages));
  const rangedPages = pageStart && pageEnd && pageEnd >= pageStart
    ? Array.from({ length: Math.min(500, pageEnd - pageStart + 1) }, (_, index) => pageStart + index)
    : [];
  const pageNumbers = [...new Set(explicitPages.length ? explicitPages : rangedPages)].sort((left, right) => left - right);
  const detected = source.detected === true && pageNumbers.length > 0;
  return {
    selected_document_type: expectedDocumentType || nullableText(source.selected_document_type) || "other",
    detected,
    page_start: detected ? pageNumbers[0] : null,
    page_end: detected ? pageNumbers[pageNumbers.length - 1] || null : null,
    page_numbers: detected ? pageNumbers : [],
    total_pdf_pages: totalPdfPages,
    confidence: clamp(numeric(source.confidence), 0, 1),
    evidence: stringArray(source.evidence, 12),
    warnings: stringArray(source.warnings, 12),
  };
}

export function buildExtractionRanges(expectedLineCount: unknown, chunkSize = 40): ExtractionRange[] {
  const expected = integer(expectedLineCount);
  const safeChunkSize = Math.min(80, Math.max(10, Math.round(chunkSize)));
  if (expected === 0) return [];
  if (expected === null) return [{ start: 1, end: 500 }];
  const capped = Math.min(expected, 500);
  const ranges: ExtractionRange[] = [];
  for (let start = 1; start <= capped; start += safeChunkSize) {
    ranges.push({ start, end: Math.min(capped, start + safeChunkSize - 1) });
  }
  return ranges;
}

export function missingExtractionRanges(expectedLineCount: unknown, linesValue: unknown, chunkSize = 40): ExtractionRange[] {
  const expected = integer(expectedLineCount);
  if (!expected) return [];
  const present = new Set(
    (Array.isArray(linesValue) ? linesValue : [])
      .map((item) => integer(asObject(item).source_index))
      .filter((item): item is number => item !== null && item > 0 && item <= expected),
  );
  const missing = Array.from({ length: expected }, (_, index) => index + 1).filter((index) => !present.has(index));
  if (!missing.length) return [];
  const safeChunkSize = Math.min(80, Math.max(10, Math.round(chunkSize)));
  const ranges: ExtractionRange[] = [];
  let start = missing[0];
  let previous = missing[0];
  for (const index of missing.slice(1)) {
    if (index === previous + 1 && index - start + 1 <= safeChunkSize) {
      previous = index;
      continue;
    }
    ranges.push({ start, end: previous });
    start = index;
    previous = index;
  }
  ranges.push({ start, end: previous });
  return ranges;
}

export function mergeExtractionPasses(headerValue: unknown, batches: ExtractionLineBatch[]) {
  const header = asObject(headerValue);
  const documentTotals = asObject(header.document_totals);
  const expectedLineCount = integer(documentTotals.line_count);
  const linesByIndex = new Map<number, JsonRecord>();
  const warnings = stringArray(header.warnings, 30);

  for (const batch of batches) {
    const data = asObject(batch.data);
    const rows = Array.isArray(data.lines) ? data.lines : [];
    rows.forEach((item, position) => {
      const row = asObject(item);
      const reportedIndex = integer(row.source_index);
      const fallbackIndex = batch.start + position;
      const sourceIndex = reportedIndex && reportedIndex >= batch.start && reportedIndex <= batch.end
        ? reportedIndex
        : fallbackIndex;
      if (sourceIndex > batch.end || sourceIndex > 500) return;
      if (linesByIndex.has(sourceIndex)) {
        warnings.push(`La línea física ${sourceIndex} apareció duplicada durante la extracción por bloques.`);
        return;
      }
      linesByIndex.set(sourceIndex, { ...row, source_index: sourceIndex });
    });
    stringArray(data.warnings, 20).forEach((message) => warnings.push(message));
  }

  const lines = [...linesByIndex.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, row]) => row);
  if (expectedLineCount && lines.length !== expectedLineCount) {
    warnings.push(`Se reconocieron ${lines.length} de ${expectedLineCount} filas comerciales físicas detectadas en el documento.`);
  }
  return {
    document_scope: asObject(header.document_scope),
    general: asObject(header.general),
    document_totals: { ...documentTotals, line_count: expectedLineCount },
    lines,
    warnings: [...new Set(warnings)].slice(0, 30),
  };
}

export function mergeCompactVerification(baseValue: unknown, verificationValue: unknown) {
  const base = asObject(baseValue);
  const verification = asObject(verificationValue);
  const linesByIndex = new Map<number, JsonRecord>();
  const baseLines = Array.isArray(base.lines) ? base.lines : [];
  const verifiedLines = Array.isArray(verification.lines) ? verification.lines : [];

  baseLines.forEach((item, position) => {
    const row = asObject(item);
    const sourceIndex = integer(row.source_index) || position + 1;
    linesByIndex.set(sourceIndex, { ...row, source_index: sourceIndex });
  });
  verifiedLines.forEach((item) => {
    const row = asObject(item);
    const sourceIndex = integer(row.source_index);
    if (!sourceIndex || sourceIndex > 500) return;
    const existing = linesByIndex.get(sourceIndex) || {};
    const verifiedValues = Object.fromEntries(
      Object.entries(row).filter(([key, value]) => key === "source_index" || (value !== null && value !== undefined && value !== "")),
    );
    linesByIndex.set(sourceIndex, { ...existing, ...verifiedValues, source_index: sourceIndex });
  });

  let lines = [...linesByIndex.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, row]) => row);
  const documentTotals = asObject(base.document_totals);
  const reconciledCbm = removeLikelyDuplicateAggregate(lines, documentTotals.cbm_total, "cbm_total", "CBM");
  lines = reconciledCbm.lines;
  const expectedLineCount = integer(documentTotals.line_count);
  const verifiedLineCount = new Set(
    verifiedLines
      .map((item) => integer(asObject(item).source_index))
      .filter((item): item is number => item !== null && item > 0),
  ).size;
  const effectiveLineCount = verifiedLineCount >= (expectedLineCount || 0)
    ? Math.max(expectedLineCount || 0, verifiedLineCount)
    : expectedLineCount;

  return {
    ...base,
    document_totals: { ...documentTotals, line_count: effectiveLineCount },
    lines,
    warnings: [...new Set([
      ...stringArray(base.warnings, 30),
      ...stringArray(verification.warnings, 30),
      ...reconciledCbm.warnings,
    ])].slice(0, 30),
  };
}

export function mergeUnnumberedRows(baseValue: unknown, scanValue: unknown) {
  const base = asObject(baseValue);
  const scan = asObject(scanValue);
  let lines = (Array.isArray(base.lines) ? base.lines : []).map(asObject);
  const warnings = stringArray(base.warnings, 30);
  const candidates = (Array.isArray(scan.lines) ? scan.lines : [])
    .map(asObject)
    .filter((row) => nullableText(row.source_row_label) === null && Boolean(nullableText(row.product_name) || nullableText(row.description)))
    .sort((left, right) => (integer(left.source_index) || 500) - (integer(right.source_index) || 500));

  for (const candidate of candidates) {
    const candidateName = normalizedKey(candidate.product_name || candidate.description);
    const duplicate = lines.some((row) => (
      normalizedKey(row.product_name || row.description) === candidateName
      && nearlyEqual(numeric(row.quantity) || 0, numeric(candidate.quantity) || 0, 0.001)
      && nearlyEqual(numeric(row.unit_price) || 0, numeric(candidate.unit_price) || 0, 0.001)
    ));
    if (duplicate) continue;
    const requestedIndex = integer(candidate.source_index) || lines.length + 1;
    const insertIndex = Math.min(lines.length + 1, Math.max(1, requestedIndex));
    lines = lines.map((row, position) => ({
      ...row,
      source_index: position + 1 >= insertIndex ? position + 2 : position + 1,
    }));
    lines.splice(insertIndex - 1, 0, { ...candidate, source_index: insertIndex, source_row_label: null });
    warnings.push(`Se incorporó la fila física ${insertIndex} sin número impreso: ${nullableText(candidate.product_name) || nullableText(candidate.description)}.`);
  }

  const documentTotals = asObject(base.document_totals);
  return {
    ...base,
    document_totals: {
      ...documentTotals,
      line_count: Math.max(integer(documentTotals.line_count) || 0, lines.length),
    },
    lines,
    warnings: [...new Set([...warnings, ...stringArray(scan.warnings, 20)])].slice(0, 30),
  };
}

function removeLikelyDuplicateAggregate(lines: JsonRecord[], documentTotalValue: unknown, key: string, label: string) {
  const documentTotal = numeric(documentTotalValue);
  if (documentTotal === null) return { lines, warnings: [] as string[] };
  const present = lines
    .map((row, index) => ({ index, value: numeric(row[key]), confidence: numeric(row.confidence) || 0 }))
    .filter((item): item is { index: number; value: number; confidence: number } => item.value !== null && item.value > 0);
  const sum = present.reduce((total, item) => total + item.value, 0);
  if (sum <= documentTotal || nearlyEqual(sum, documentTotal, 0.015)) return { lines, warnings: [] as string[] };

  const duplicateGroups = present.reduce<Array<typeof present>>((groups, item) => {
    const group = groups.find((candidate) => nearlyEqual(candidate[0].value, item.value, 0.001));
    if (group) group.push(item);
    else groups.push([item]);
    return groups;
  }, []).filter((group) => group.length > 1);
  let removable: typeof present = [];
  for (const group of duplicateGroups) {
    const candidates = [...group].sort((left, right) => left.confidence - right.confidence || left.index - right.index);
    for (let count = 1; count < candidates.length; count += 1) {
      const selected = candidates.slice(0, count);
      const correctedSum = sum - selected.reduce((total, item) => total + item.value, 0);
      if (nearlyEqual(correctedSum, documentTotal, 0.015)) {
        removable = selected;
        break;
      }
    }
    if (removable.length) break;
  }
  if (!removable.length) return { lines, warnings: [] as string[] };

  const removableIndexes = new Set(removable.map((item) => item.index));
  const corrected = lines.map((row, index) => removableIndexes.has(index) ? { ...row, [key]: null } : row);
  return {
    lines: corrected,
    warnings: [`Se descartaron ${removable.length} valores ${label} duplicados (${removable.map((item) => `${item.value} en línea ${item.index + 1}`).join(", ")}); la suma corregida concilia con el total documental ${documentTotal}.`],
  };
}

export function prepareExtraction(value: unknown) {
  const source = asObject(value);
  const documentScope = normalizeForeignTradeDocumentScope(source.document_scope);
  const general = asObject(source.general);
  const documentTotals = asObject(source.document_totals);
  const sourceLines = Array.isArray(source.lines) ? source.lines.slice(0, 500) : [];
  const warnings: ExtractionWarning[] = [];

  const orderNumber = nullableText(general.order_number);
  const extractedProformaNumber = nullableText(general.proforma_number);
  const proformaNumber = extractedProformaNumber || orderNumber;

  if (!text(general.supplier_name)) warnings.push(warning("missing_supplier", "No se reconoció el proveedor.", "warning"));
  if (!text(general.currency)) warnings.push(warning("missing_currency", "No se reconoció la moneda.", "warning"));
  if (!proformaNumber) warnings.push(warning("missing_proforma_number", "No se reconoció el número de proforma.", "info"));
  if (!extractedProformaNumber && orderNumber) {
    warnings.push(warning("proforma_number_from_order", `Se usó el número de orden ${orderNumber} como identificador visible de la proforma.`, "info"));
  }
  if (!isoDate(general.document_date)) warnings.push(warning("missing_document_date", "No se reconoció una fecha documental inequívoca.", "warning"));

  const lines = sourceLines.map((item, index) => {
    const row = asObject(item);
    const sourceIndex = integer(row.source_index) || index + 1;
    const rowWarnings = stringArray(row.warnings, 20);
    const quantity = numeric(row.quantity);
    const unitPrice = numeric(row.unit_price);
    const totalPrice = numeric(row.total_price);
    const boxCount = numeric(row.box_count);
    const cbmPerBox = numeric(row.cbm_per_box);
    const cbmTotal = numeric(row.cbm_total);
    const length = numeric(row.box_length_cm);
    const width = numeric(row.box_width_cm);
    const height = numeric(row.box_height_cm);

    if (!text(row.product_name) && !text(row.description)) {
      rowWarnings.push("Falta una descripción que permita identificar el producto.");
      warnings.push(warning("missing_product_name", `La línea ${sourceIndex} no tiene producto identificable.`, "error", sourceIndex));
    }
    if (quantity === null) {
      rowWarnings.push("Cantidad no reconocida.");
      warnings.push(warning("missing_quantity", `Falta cantidad en la línea ${sourceIndex}.`, "warning", sourceIndex));
    }
    if (unitPrice === null) {
      rowWarnings.push("Precio unitario no reconocido.");
      warnings.push(warning("missing_unit_price", `Falta precio unitario en la línea ${sourceIndex}.`, "warning", sourceIndex));
    }
    if (quantity !== null && unitPrice !== null && totalPrice !== null) {
      const calculated = quantity * unitPrice;
      if (!nearlyEqual(calculated, totalPrice, 0.01)) {
        const message = `Total documento ${totalPrice} versus cantidad × precio ${round(calculated)}.`;
        rowWarnings.push(message);
        warnings.push(warning("line_total_mismatch", `Línea ${sourceIndex}: ${message}`, "warning", sourceIndex));
      }
    }

    const derivedCbmPerBox = cbmPerBox ?? (
      cbmTotal !== null && boxCount !== null && boxCount > 0 ? round(cbmTotal / boxCount) : null
    );
    const cbmPerUnit = cbmTotal !== null && quantity !== null && quantity > 0
      ? round(cbmTotal / quantity, 9)
      : null;
    let recalculatedCbm: number | null = null;
    if (length !== null && width !== null && height !== null) {
      recalculatedCbm = (length * width * height) / 1_000_000;
      if (boxCount !== null) recalculatedCbm *= boxCount;
      const documentCbm = boxCount !== null ? cbmTotal : derivedCbmPerBox;
      if (documentCbm !== null && !nearlyEqual(recalculatedCbm, documentCbm, 0.02)) {
        const message = `CBM documento ${round(documentCbm)} versus CBM recalculado ${round(recalculatedCbm)}.`;
        rowWarnings.push(message);
        warnings.push(warning("cbm_mismatch", `Línea ${sourceIndex}: ${message}`, "warning", sourceIndex));
      }
    }

    const descriptionOriginal = nullableText(row.description_original)
      || nullableText(row.description)
      || nullableText(row.product_name);
    const descriptionTranslated = nullableText(row.description_translated);
    const supplierProductCode = nullableText(row.supplier_product_code)
      || inferSupplierProductCode(
        row.supplier_sku,
        row.supplier_reference,
        row.model,
        row.sku,
        descriptionOriginal,
      );

    return {
      source_index: sourceIndex,
      source_page: integer(row.source_page),
      source_row_label: nullableText(row.source_row_label),
      include: true,
      content_product_id: null,
      remember_link: false,
      supplier_product_code: supplierProductCode,
      supplier_sku: nullableText(row.supplier_sku),
      supplier_reference: nullableText(row.supplier_reference),
      sku: nullableText(row.sku),
      product_name: nullableText(row.product_name) || nullableText(row.description) || "",
      description: nullableText(row.description),
      description_original: descriptionOriginal,
      description_translated: descriptionTranslated,
      description_normalized: normalizeProductDescription(descriptionTranslated || descriptionOriginal),
      model: nullableText(row.model),
      brand: nullableText(row.brand),
      technical_attributes: stringArray(row.technical_attributes, 30),
      quantity,
      quantity_per_box: numeric(row.quantity_per_box),
      box_count: boxCount,
      currency: nullableText(row.currency) || nullableText(general.currency),
      unit_price: unitPrice,
      total_price: totalPrice,
      exw_total: numeric(row.exw_total),
      fob_total: numeric(row.fob_total),
      cif_total: numeric(row.cif_total),
      discount_total: numeric(row.discount_total),
      supplier_charges_total: numeric(row.supplier_charges_total),
      unit_weight_kg: numeric(row.unit_weight_kg),
      gross_weight_kg: numeric(row.gross_weight_kg),
      net_weight_kg: numeric(row.net_weight_kg),
      box_length_cm: length,
      box_width_cm: width,
      box_height_cm: height,
      cbm_per_box: derivedCbmPerBox,
      cbm_total: cbmTotal,
      cbm_per_unit: cbmPerUnit,
      recalculated_cbm_total: recalculatedCbm === null ? null : round(recalculatedCbm),
      country_of_origin: nullableText(row.country_of_origin),
      hs_code: nullableText(row.hs_code),
      confidence: clamp(numeric(row.confidence), 0, 1),
      warnings: [...new Set(rowWarnings)].slice(0, 20),
    };
  });

  const lineCbmTotal = lines.reduce((sum, row) => sum + (row.cbm_total || 0), 0);
  const documentCbmTotal = numeric(documentTotals.cbm_total);
  const expectedLineCount = integer(documentTotals.line_count);
  if (expectedLineCount && lines.length !== expectedLineCount) {
    const coverage = lines.length / expectedLineCount;
    warnings.push(warning(
      "incomplete_line_extraction",
      `Se extrajeron ${lines.length} de ${expectedLineCount} filas comerciales detectadas (${Math.round(coverage * 100)}% de cobertura).`,
      coverage < 0.8 ? "error" : "warning",
    ));
  }
  if (documentCbmTotal !== null && lines.length > 0 && !nearlyEqual(documentCbmTotal, lineCbmTotal, 0.02)) {
    warnings.push(warning(
      "document_cbm_mismatch",
      `CBM total del documento ${round(documentCbmTotal)} versus suma de líneas ${round(lineCbmTotal)}.`,
      "warning",
    ));
  }
  stringArray(source.warnings, 30).forEach((message) => warnings.push(warning("model_warning", message, "info")));

  const confidenceValues = [
    clamp(numeric(general.confidence), 0, 1),
    ...lines.map((row) => row.confidence),
  ].filter((item): item is number => item !== null);
  const confidence = confidenceValues.length
    ? round(confidenceValues.reduce((sum, item) => sum + item, 0) / confidenceValues.length, 6)
    : null;

  return {
    extraction: {
      extraction_version: FOREIGN_TRADE_EXTRACTION_VERSION,
      pdf_skill_version: nullableText(source.pdf_skill_version),
      document_scope: documentScope,
      general: {
        supplier_id: null,
        supplier_name: nullableText(general.supplier_name),
        proforma_number: proformaNumber,
        document_date: isoDate(general.document_date),
        valid_until: isoDate(general.valid_until),
        currency: nullableText(general.currency)?.toUpperCase() || null,
        incoterm: nullableText(general.incoterm)?.toUpperCase() || null,
        origin_port: nullableText(general.origin_port),
        destination_port: nullableText(general.destination_port),
        payment_terms: nullableText(general.payment_terms),
        production_days: integer(general.production_days),
        order_number: orderNumber,
        observations: nullableText(general.observations),
        confidence: clamp(numeric(general.confidence), 0, 1),
        warnings: stringArray(general.warnings, 20),
      },
      lines,
      document_totals: {
        subtotal: numeric(documentTotals.subtotal),
        total: numeric(documentTotals.total),
        cbm_total: documentCbmTotal,
        gross_weight_kg: numeric(documentTotals.gross_weight_kg),
        net_weight_kg: numeric(documentTotals.net_weight_kg),
        boxes: numeric(documentTotals.boxes),
        line_count: expectedLineCount,
      },
      warnings: stringArray(source.warnings, 30),
    },
    confidence,
    warnings,
  };
}

function inferSupplierProductCode(...values: unknown[]) {
  for (const value of values.slice(0, 4)) {
    const explicit = nullableText(value);
    if (explicit && isUsefulSupplierCode(explicit)) return explicit;
  }
  const description = nullableText(values[4]);
  if (!description) return null;
  const candidates = description.toUpperCase().match(/[A-Z0-9][A-Z0-9._/-]{2,39}/g) || [];
  return candidates.find(isUsefulSupplierCode) || null;
}

function isUsefulSupplierCode(value: string) {
  const compact = value.trim().toUpperCase();
  if (!/[A-Z]/.test(compact) || !/[0-9]/.test(compact)) return false;
  if (/^\d+(?:\.\d+)?(?:V|VAC|VDC|HZ|W|KW|A|MM|CM|M|KG|G|L|ML|CFM|BTU)$/.test(compact)) return false;
  return compact.length >= 3 && compact.length <= 40;
}

function normalizeProductDescription(value: string | null) {
  if (!value) return null;
  return value.normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim() || null;
}

const reconciliationLineTypes = new Set([
  "operating_expense", "agency_fee", "customs_duty", "import_vat", "adjustment",
]);
const reconciliationCostCategories = new Set([
  "origin", "international_freight", "insurance", "chile_port", "storage",
  "customs_agency", "national_transport", "inspection", "certificate", "duties",
  "taxes", "supplier_charge", "other",
]);

export function prepareFundRequestExtraction(value: unknown) {
  const source = asObject(value);
  const sourceGeneral = asObject(source.general);
  const sourceTotals = asObject(source.totals);
  const sourceLines = Array.isArray(source.lines) ? source.lines.slice(0, 300) : [];
  const warnings: ExtractionWarning[] = [];
  const generalWarnings = stringArray(sourceGeneral.warnings, 20);

  const lines = sourceLines.map((item, index) => {
    const row = asObject(item);
    const sourceIndex = integer(row.source_index) || index + 1;
    const lineWarnings = stringArray(row.warnings, 20);
    const rawLineType = text(row.line_type);
    const lineType = reconciliationLineTypes.has(rawLineType) ? rawLineType : "operating_expense";
    const rawCategory = text(row.cost_category);
    const costCategory = reconciliationCostCategories.has(rawCategory) ? rawCategory : "other";
    const concept = nullableText(row.concept) || "";
    const currency = (/^[A-Z]{3}$/.test(text(row.currency).toUpperCase()) ? text(row.currency).toUpperCase() : "CLP");
    const amountOriginal = numeric(row.amount_original);
    const exchangeRate = currency === "CLP" ? 1 : numeric(row.exchange_rate_clp);
    const netClp = numeric(row.provision_net_clp);
    const vatClp = numeric(row.provision_vat_clp);
    const declaredTotalClp = numeric(row.provision_total_clp);
    const convertedTotal = amountOriginal !== null && exchangeRate !== null
      ? round(amountOriginal * exchangeRate, 2)
      : null;
    const totalClp = declaredTotalClp ?? (
      netClp !== null || vatClp !== null ? round((netClp || 0) + (vatClp || 0), 2) : convertedTotal
    );

    if (!concept) {
      lineWarnings.push("No se reconoció el concepto del cargo.");
      warnings.push(warning("missing_expense_concept", `La línea ${sourceIndex} no tiene un concepto identificable.`, "error", sourceIndex));
    }
    if (amountOriginal === null && totalClp === null) {
      lineWarnings.push("No se reconoció un monto.");
      warnings.push(warning("missing_expense_amount", `Falta el monto en la línea ${sourceIndex}.`, "error", sourceIndex));
    }
    if (currency !== "CLP" && amountOriginal !== null && exchangeRate === null && totalClp === null) {
      lineWarnings.push(`Falta el tipo de cambio para convertir ${currency} a CLP.`);
      warnings.push(warning("missing_exchange_rate", `Línea ${sourceIndex}: falta tipo de cambio ${currency}/CLP.`, "warning", sourceIndex));
    }
    if (rawLineType && rawLineType !== lineType) lineWarnings.push("La clasificación del concepto no fue reconocida y se dejó como gasto operacional.");
    if (rawCategory && rawCategory !== costCategory) lineWarnings.push("La categoría no fue reconocida y se dejó como Otro.");

    const isImportVat = lineType === "import_vat";
    return {
      source_index: sourceIndex,
      source_page: integer(row.source_page),
      include: row.include !== false,
      line_type: lineType,
      cost_category: lineType === "customs_duty" ? "duties" : isImportVat ? "taxes" : costCategory,
      concept,
      provider_name: nullableText(row.provider_name),
      document_number: nullableText(row.document_number),
      document_date: isoDate(row.document_date),
      provision_net_clp: netClp,
      provision_vat_clp: vatClp,
      provision_total_clp: totalClp,
      amount_original: amountOriginal ?? (currency === "CLP" ? totalClp : null),
      currency,
      exchange_rate_clp: exchangeRate,
      recoverable_tax: isImportVat ? true : row.recoverable_tax === true,
      include_in_costing: isImportVat ? false : row.include_in_costing !== false,
      confidence: clamp(numeric(row.confidence), 0, 1),
      warnings: [...new Set(lineWarnings)].slice(0, 20),
    };
  });

  const expensesClp = round(lines
    .filter((line) => !["customs_duty", "import_vat"].includes(line.line_type))
    .reduce((sum, line) => sum + (line.provision_total_clp || 0), 0), 2);
  const taxesClp = round(lines
    .filter((line) => ["customs_duty", "import_vat"].includes(line.line_type))
    .reduce((sum, line) => sum + (line.provision_total_clp || 0), 0), 2);
  const calculatedTotal = round(expensesClp + taxesClp, 2);
  const declaredTotal = numeric(sourceTotals.document_total_clp) ?? numeric(sourceGeneral.declared_total_clp);
  if (declaredTotal !== null && calculatedTotal > 0 && !nearlyEqual(declaredTotal, calculatedTotal, 0.01)) {
    warnings.push(warning(
      "fund_request_total_mismatch",
      `Total declarado ${round(declaredTotal, 2)} CLP versus suma de conceptos ${calculatedTotal} CLP.`,
      "warning",
    ));
  }
  if (!nullableText(sourceGeneral.reference)) warnings.push(warning("missing_fund_request_reference", "No se reconoció el número o referencia de la solicitud de fondos.", "warning"));
  if (!isoDate(sourceGeneral.document_date)) warnings.push(warning("missing_fund_request_date", "No se reconoció una fecha documental inequívoca.", "warning"));
  stringArray(source.warnings, 30).forEach((message) => warnings.push(warning("model_warning", message, "info")));

  const confidenceValues = [
    clamp(numeric(sourceGeneral.confidence), 0, 1),
    ...lines.map((line) => line.confidence),
  ].filter((item): item is number => item !== null);
  const confidence = confidenceValues.length
    ? round(confidenceValues.reduce((sum, item) => sum + item, 0) / confidenceValues.length, 6)
    : null;

  return {
    extraction: {
      extraction_version: FOREIGN_TRADE_FUND_REQUEST_EXTRACTION_VERSION,
      document_kind: "fund_request",
      general: {
        reference: nullableText(sourceGeneral.reference),
        agency_name: nullableText(sourceGeneral.agency_name),
        document_date: isoDate(sourceGeneral.document_date),
        currency: nullableText(sourceGeneral.currency)?.toUpperCase() || "CLP",
        declared_total_clp: declaredTotal,
        remittance_amount_clp: numeric(sourceGeneral.remittance_amount_clp) ?? declaredTotal ?? calculatedTotal,
        observations: nullableText(sourceGeneral.observations),
        confidence: clamp(numeric(sourceGeneral.confidence), 0, 1),
        warnings: generalWarnings,
      },
      lines,
      totals: {
        expenses_clp: numeric(sourceTotals.expenses_clp) ?? expensesClp,
        taxes_clp: numeric(sourceTotals.taxes_clp) ?? taxesClp,
        document_total_clp: declaredTotal ?? calculatedTotal,
        line_count: lines.length,
      },
      warnings: stringArray(source.warnings, 30),
    },
    confidence,
    warnings,
  };
}

function isAgencySettlementSummaryLabel(value: unknown) {
  const normalized = text(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .trim();
  return /^(?:(?:total|subtotal|suma)(?:desembolsos|gastos|rendicion|facturas?|documentos|general|facturaagencia|derechosaduana|aduana)?|remesa|pagodirecto|totalasufavor|saldoasufavor|devolucion)$/.test(normalized);
}

export function prepareFreightDocumentExtraction(value: unknown) {
  const source = asObject(value);
  const sourceGeneral = asObject(source.general);
  const sourceTotals = asObject(source.totals);
  const sourceLines = Array.isArray(source.lines) ? source.lines.slice(0, 100) : [];
  const warnings: ExtractionWarning[] = [];

  const lines = sourceLines.map((item, index) => {
    const row = asObject(item);
    const sourceIndex = integer(row.source_index) || index + 1;
    const lineWarnings = stringArray(row.warnings, 20);
    const rawCategory = text(row.cost_category);
    const costCategory = reconciliationCostCategories.has(rawCategory) && rawCategory !== "duties" && rawCategory !== "taxes"
      ? rawCategory
      : "international_freight";
    const concept = nullableText(row.concept) || "";
    const currency = /^[A-Z]{3}$/.test(text(row.currency).toUpperCase()) ? text(row.currency).toUpperCase() : "CLP";
    const amountOriginal = numeric(row.amount_original);
    const exchangeRate = currency === "CLP" ? 1 : numeric(row.exchange_rate_clp);
    const netClp = numeric(row.net_clp);
    const vatClp = numeric(row.vat_clp);
    const declaredTotal = numeric(row.total_clp);
    const convertedTotal = amountOriginal !== null && exchangeRate !== null
      ? round(amountOriginal * exchangeRate, 2)
      : null;
    const totalClp = declaredTotal ?? (
      netClp !== null || vatClp !== null ? round((netClp || 0) + (vatClp || 0), 2) : convertedTotal
    );

    if (!concept) {
      lineWarnings.push("No se reconoció el concepto del transporte.");
      warnings.push(warning("missing_freight_concept", `La línea ${sourceIndex} no tiene un concepto identificable.`, "error", sourceIndex));
    }
    if (amountOriginal === null && totalClp === null) {
      lineWarnings.push("No se reconoció un monto para el cargo.");
      warnings.push(warning("missing_freight_amount", `Falta el monto en la línea ${sourceIndex}.`, "error", sourceIndex));
    }
    if (currency !== "CLP" && amountOriginal !== null && exchangeRate === null && totalClp === null) {
      lineWarnings.push(`Falta el tipo de cambio para convertir ${currency} a CLP.`);
      warnings.push(warning("missing_freight_exchange_rate", `Línea ${sourceIndex}: falta tipo de cambio ${currency}/CLP.`, "warning", sourceIndex));
    }

    return {
      source_index: sourceIndex,
      source_page: integer(row.source_page),
      include: row.include !== false,
      cost_category: costCategory,
      concept,
      provider_name: nullableText(row.provider_name),
      document_number: nullableText(row.document_number),
      document_date: isoDate(row.document_date),
      net_clp: netClp,
      vat_clp: vatClp,
      total_clp: totalClp,
      amount_original: amountOriginal ?? (currency === "CLP" ? totalClp : null),
      currency,
      exchange_rate_clp: exchangeRate,
      recoverable_tax: row.recoverable_tax === true,
      include_in_costing: row.include_in_costing !== false,
      confidence: clamp(numeric(row.confidence), 0, 1),
      warnings: [...new Set(lineWarnings)].slice(0, 20),
    };
  });

  const calculatedNet = round(lines.reduce((sum, line) => sum + (line.net_clp || 0), 0), 2);
  const calculatedVat = round(lines.reduce((sum, line) => sum + (line.vat_clp || 0), 0), 2);
  const calculatedTotal = round(lines.reduce((sum, line) => sum + (line.total_clp || 0), 0), 2);
  const declaredTotal = numeric(sourceTotals.document_total_clp) ?? numeric(sourceGeneral.declared_total_clp);
  if (declaredTotal !== null && calculatedTotal > 0 && !nearlyEqual(declaredTotal, calculatedTotal, 0.01)) {
    warnings.push(warning(
      "freight_total_mismatch",
      `Total declarado ${round(declaredTotal, 2)} CLP versus suma de cargos ${calculatedTotal} CLP.`,
      "warning",
    ));
  }
  if (!nullableText(sourceGeneral.document_number)) warnings.push(warning("missing_freight_document_number", "No se reconoció el número de factura o cotización.", "warning"));
  if (!isoDate(sourceGeneral.document_date)) warnings.push(warning("missing_freight_document_date", "No se reconoció una fecha documental inequívoca.", "warning"));
  stringArray(source.warnings, 30).forEach((message) => warnings.push(warning("model_warning", message, "info")));

  const confidenceValues = [
    clamp(numeric(sourceGeneral.confidence), 0, 1),
    ...lines.map((line) => line.confidence),
  ].filter((item): item is number => item !== null);
  const confidence = confidenceValues.length
    ? round(confidenceValues.reduce((sum, item) => sum + item, 0) / confidenceValues.length, 4)
    : null;

  return {
    extraction: {
      extraction_version: FOREIGN_TRADE_FREIGHT_DOCUMENT_EXTRACTION_VERSION,
      document_kind: "freight_document",
      general: {
        reference: nullableText(sourceGeneral.reference),
        carrier_name: nullableText(sourceGeneral.carrier_name),
        document_number: nullableText(sourceGeneral.document_number),
        document_date: isoDate(sourceGeneral.document_date),
        currency: nullableText(sourceGeneral.currency)?.toUpperCase() || null,
        declared_total_clp: numeric(sourceGeneral.declared_total_clp) ?? declaredTotal,
        origin_port: nullableText(sourceGeneral.origin_port),
        destination_port: nullableText(sourceGeneral.destination_port),
        bill_of_lading: nullableText(sourceGeneral.bill_of_lading),
        observations: nullableText(sourceGeneral.observations),
        confidence: clamp(numeric(sourceGeneral.confidence), 0, 1),
        warnings: stringArray(sourceGeneral.warnings, 20),
      },
      lines,
      totals: {
        net_clp: numeric(sourceTotals.net_clp) ?? calculatedNet,
        vat_clp: numeric(sourceTotals.vat_clp) ?? calculatedVat,
        document_total_clp: declaredTotal ?? calculatedTotal,
        line_count: lines.length,
      },
      warnings: stringArray(source.warnings, 30),
    },
    confidence,
    warnings,
  };
}

export function prepareAgencySettlementExtraction(value: unknown) {
  const source = asObject(value);
  const sourceGeneral = asObject(source.general);
  const sourceTotals = asObject(source.totals);
  const sourceLines = Array.isArray(source.lines) ? source.lines.slice(0, 300) : [];
  const warnings: ExtractionWarning[] = [];
  const generalWarnings = stringArray(sourceGeneral.warnings, 20);

  const lines = sourceLines.map((item, index) => {
    const row = asObject(item);
    const sourceIndex = integer(row.source_index) || index + 1;
    const lineWarnings = stringArray(row.warnings, 20);
    const rawLineType = text(row.line_type);
    const lineType = reconciliationLineTypes.has(rawLineType) ? rawLineType : "operating_expense";
    const rawCategory = text(row.cost_category);
    const costCategory = reconciliationCostCategories.has(rawCategory) ? rawCategory : "other";
    const concept = nullableText(row.concept) || "";
    const isSummary = isAgencySettlementSummaryLabel(concept);
    const currency = /^[A-Z]{3}$/.test(text(row.currency).toUpperCase()) ? text(row.currency).toUpperCase() : "CLP";
    const amountOriginal = numeric(row.amount_original);
    const exchangeRate = currency === "CLP" ? 1 : numeric(row.exchange_rate_clp);
    const netClp = numeric(row.actual_net_clp);
    const vatClp = numeric(row.actual_vat_clp);
    const declaredTotalClp = numeric(row.actual_total_clp);
    const convertedTotal = amountOriginal !== null && exchangeRate !== null
      ? round(amountOriginal * exchangeRate, 2)
      : null;
    const totalClp = declaredTotalClp ?? (
      netClp !== null || vatClp !== null ? round((netClp || 0) + (vatClp || 0), 2) : convertedTotal
    );

    if (!concept) {
      lineWarnings.push("No se reconoció el concepto del cargo real.");
      warnings.push(warning("missing_actual_expense_concept", `La línea ${sourceIndex} no tiene un concepto identificable.`, "error", sourceIndex));
    }
    if (amountOriginal === null && totalClp === null) {
      lineWarnings.push("No se reconoció un monto real.");
      warnings.push(warning("missing_actual_expense_amount", `Falta el monto real en la línea ${sourceIndex}.`, "error", sourceIndex));
    }
    if (currency !== "CLP" && amountOriginal !== null && exchangeRate === null && totalClp === null) {
      lineWarnings.push(`Falta el tipo de cambio para convertir ${currency} a CLP.`);
      warnings.push(warning("missing_actual_exchange_rate", `Línea ${sourceIndex}: falta tipo de cambio ${currency}/CLP.`, "warning", sourceIndex));
    }
    if (isSummary) {
      lineWarnings.push("Resumen documental informativo; no se suma como un costo independiente.");
    }

    const isImportVat = lineType === "import_vat";
    return {
      source_index: sourceIndex,
      source_page: integer(row.source_page),
      include: !isSummary && row.include !== false,
      reconciliation_line_id: null,
      line_type: lineType,
      cost_category: lineType === "customs_duty" ? "duties" : isImportVat ? "taxes" : costCategory,
      concept,
      provider_name: nullableText(row.provider_name),
      document_number: nullableText(row.document_number),
      document_date: isoDate(row.document_date),
      actual_net_clp: netClp,
      actual_vat_clp: vatClp,
      actual_total_clp: totalClp,
      amount_original: amountOriginal ?? (currency === "CLP" ? totalClp : null),
      currency,
      exchange_rate_clp: exchangeRate,
      recoverable_tax: isImportVat ? true : row.recoverable_tax === true,
      include_in_costing: isSummary || isImportVat ? false : row.include_in_costing !== false,
      confidence: clamp(numeric(row.confidence), 0, 1),
      warnings: [...new Set(lineWarnings)].slice(0, 20),
    };
  });

  const expensesClp = round(lines
    .filter((line) => line.include && !["customs_duty", "import_vat"].includes(line.line_type))
    .reduce((sum, line) => sum + (line.actual_total_clp || 0), 0), 2);
  const taxesClp = round(lines
    .filter((line) => line.include && ["customs_duty", "import_vat"].includes(line.line_type))
    .reduce((sum, line) => sum + (line.actual_total_clp || 0), 0), 2);
  const calculatedTotal = round(expensesClp + taxesClp, 2);
  const agencyInvoiceTotal = numeric(sourceTotals.agency_invoice_total_clp);
  const disbursementsTotal = numeric(sourceTotals.disbursements_total_clp);
  const customsTotal = numeric(sourceTotals.customs_total_clp);
  const declaredTotal = numeric(sourceTotals.document_total_clp) ?? numeric(sourceGeneral.declared_total_clp);
  const remittance = numeric(sourceTotals.remittance_clp);
  const documentaryDirectPayment = numeric(sourceTotals.documentary_direct_payment_clp) ?? 0;
  const documentedRefund = numeric(sourceTotals.refund_due_clp);
  const componentValues = [agencyInvoiceTotal, disbursementsTotal, customsTotal];
  const hasDocumentaryComponents = componentValues.every((item) => item !== null);
  const documentaryComponentsTotal = hasDocumentaryComponents
    ? round(componentValues.reduce((sum, item) => sum + (item || 0), 0), 2)
    : null;
  const calculatedRefund = remittance !== null && declaredTotal !== null
    ? round(Math.max(remittance + documentaryDirectPayment - declaredTotal, 0), 2)
    : null;
  if (declaredTotal !== null && calculatedTotal > 0 && !nearlyEqual(declaredTotal, calculatedTotal, 0.01)) {
    warnings.push(warning(
      "agency_settlement_total_mismatch",
      `Total declarado ${round(declaredTotal, 2)} CLP versus suma de conceptos reales ${calculatedTotal} CLP.`,
      "warning",
    ));
  }
  if (documentaryComponentsTotal !== null && declaredTotal !== null && Math.abs(documentaryComponentsTotal - declaredTotal) > 1) {
    warnings.push(warning(
      "agency_settlement_documentary_components_mismatch",
      `Los subtotales documentales suman ${documentaryComponentsTotal} CLP, pero el total rendido declara ${declaredTotal} CLP.`,
      "error",
    ));
  }
  if (documentedRefund !== null && calculatedRefund !== null && Math.abs(Math.abs(documentedRefund) - calculatedRefund) > 1) {
    warnings.push(warning(
      "agency_settlement_refund_mismatch",
      `La devolución documentada es ${Math.abs(documentedRefund)} CLP, pero remesa menos rendición calcula ${calculatedRefund} CLP.`,
      "error",
    ));
  }
  if (!nullableText(sourceGeneral.reference)) warnings.push(warning("missing_agency_settlement_reference", "No se reconoció la referencia del despacho.", "warning"));
  if (!isoDate(sourceGeneral.document_date)) warnings.push(warning("missing_agency_settlement_date", "No se reconoció una fecha documental inequívoca.", "warning"));
  stringArray(source.warnings, 30).forEach((message) => warnings.push(warning("model_warning", message, "info")));

  const confidenceValues = [
    clamp(numeric(sourceGeneral.confidence), 0, 1),
    ...lines.map((line) => line.confidence),
  ].filter((item): item is number => item !== null);
  const confidence = confidenceValues.length
    ? round(confidenceValues.reduce((sum, item) => sum + item, 0) / confidenceValues.length, 6)
    : null;

  return {
    extraction: {
      extraction_version: FOREIGN_TRADE_AGENCY_SETTLEMENT_EXTRACTION_VERSION,
      document_kind: "agency_settlement",
      identity_confirmed: false,
      general: {
        reference: nullableText(sourceGeneral.reference),
        agency_name: nullableText(sourceGeneral.agency_name),
        invoice_number: nullableText(sourceGeneral.invoice_number),
        document_date: isoDate(sourceGeneral.document_date),
        currency: nullableText(sourceGeneral.currency)?.toUpperCase() || "CLP",
        declared_total_clp: declaredTotal,
        observations: nullableText(sourceGeneral.observations),
        confidence: clamp(numeric(sourceGeneral.confidence), 0, 1),
        warnings: generalWarnings,
      },
      lines,
      totals: {
        expenses_clp: numeric(sourceTotals.expenses_clp) ?? expensesClp,
        taxes_clp: numeric(sourceTotals.taxes_clp) ?? taxesClp,
        agency_invoice_total_clp: agencyInvoiceTotal,
        disbursements_total_clp: disbursementsTotal,
        customs_total_clp: customsTotal,
        document_total_clp: declaredTotal ?? calculatedTotal,
        remittance_clp: remittance,
        documentary_direct_payment_clp: documentaryDirectPayment,
        refund_due_clp: documentedRefund === null ? calculatedRefund : Math.abs(documentedRefund),
        line_count: lines.length,
      },
      warnings: stringArray(source.warnings, 30),
    },
    confidence,
    warnings,
  };
}

function warning(code: string, message: string, severity: ExtractionWarning["severity"], lineIndex: number | null = null): ExtractionWarning {
  return { code, message, severity, line_index: lineIndex };
}

function nearlyEqual(a: number, b: number, tolerance: number) {
  const scale = Math.max(Math.abs(a), Math.abs(b), 1);
  return Math.abs(a - b) / scale <= tolerance;
}

function normalizedKey(value: unknown) {
  return text(value).toLocaleLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function asObject(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function nullableText(value: unknown) {
  const result = text(value);
  return result || null;
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim().slice(0, 2000) : "";
}

function numeric(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const result = typeof value === "number" ? value : Number(String(value).replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(result) ? result : null;
}

function integer(value: unknown) {
  const result = numeric(value);
  return result === null ? null : Math.max(0, Math.round(result));
}

function positiveInteger(value: unknown) {
  const result = integer(value);
  return result !== null && result > 0 ? result : null;
}

function clamp(value: number | null, minimum: number, maximum: number) {
  return value === null ? null : Math.min(maximum, Math.max(minimum, value));
}

function isoDate(value: unknown) {
  const result = nullableText(value);
  return result && /^\d{4}-\d{2}-\d{2}$/.test(result) ? result : null;
}

function stringArray(value: unknown, limit: number) {
  return (Array.isArray(value) ? value : []).map(text).filter(Boolean).slice(0, limit);
}

function round(value: number, digits = 6) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
