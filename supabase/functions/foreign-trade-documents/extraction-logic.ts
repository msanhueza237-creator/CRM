export type JsonRecord = Record<string, unknown>;

export const FOREIGN_TRADE_EXTRACTION_VERSION = "pdf_skill_v9";

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

  const duplicateCandidates = present
    .filter((item) => present.some((other) => other.index !== item.index && nearlyEqual(other.value, item.value, 0.001)))
    .sort((left, right) => left.confidence - right.confidence || left.index - right.index);
  const removable = duplicateCandidates.find((item) => nearlyEqual(sum - item.value, documentTotal, 0.015));
  if (!removable) return { lines, warnings: [] as string[] };

  const corrected = lines.map((row, index) => index === removable.index ? { ...row, [key]: null } : row);
  return {
    lines: corrected,
    warnings: [`Se descartó un ${label} duplicado de ${removable.value} en la línea física ${removable.index + 1}; la suma corregida concilia con el total documental ${documentTotal}.`],
  };
}

export function prepareExtraction(value: unknown) {
  const source = asObject(value);
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

    return {
      source_index: sourceIndex,
      source_page: integer(row.source_page),
      source_row_label: nullableText(row.source_row_label),
      include: true,
      content_product_id: null,
      remember_link: false,
      supplier_sku: nullableText(row.supplier_sku),
      sku: nullableText(row.sku),
      product_name: nullableText(row.product_name) || nullableText(row.description) || "",
      description: nullableText(row.description),
      model: nullableText(row.model),
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
