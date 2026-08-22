export type JsonRecord = Record<string, unknown>;

export type ExtractionWarning = {
  code: string;
  message: string;
  severity: "info" | "warning" | "error";
  line_index: number | null;
};

export function prepareExtraction(value: unknown) {
  const source = asObject(value);
  const general = asObject(source.general);
  const documentTotals = asObject(source.document_totals);
  const sourceLines = Array.isArray(source.lines) ? source.lines.slice(0, 500) : [];
  const warnings: ExtractionWarning[] = [];

  if (!text(general.supplier_name)) warnings.push(warning("missing_supplier", "No se reconoció el proveedor.", "warning"));
  if (!text(general.currency)) warnings.push(warning("missing_currency", "No se reconoció la moneda.", "warning"));
  if (!text(general.proforma_number)) warnings.push(warning("missing_proforma_number", "No se reconoció el número de proforma.", "info"));

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

    let recalculatedCbm: number | null = null;
    if (length !== null && width !== null && height !== null) {
      recalculatedCbm = (length * width * height) / 1_000_000;
      if (boxCount !== null) recalculatedCbm *= boxCount;
      const documentCbm = boxCount !== null ? cbmTotal : cbmPerBox;
      if (documentCbm !== null && !nearlyEqual(recalculatedCbm, documentCbm, 0.02)) {
        const message = `CBM documento ${round(documentCbm)} versus CBM recalculado ${round(recalculatedCbm)}.`;
        rowWarnings.push(message);
        warnings.push(warning("cbm_mismatch", `Línea ${sourceIndex}: ${message}`, "warning", sourceIndex));
      }
    }

    return {
      source_index: sourceIndex,
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
      cbm_per_box: cbmPerBox,
      cbm_total: cbmTotal,
      recalculated_cbm_total: recalculatedCbm === null ? null : round(recalculatedCbm),
      country_of_origin: nullableText(row.country_of_origin),
      hs_code: nullableText(row.hs_code),
      confidence: clamp(numeric(row.confidence), 0, 1),
      warnings: [...new Set(rowWarnings)].slice(0, 20),
    };
  });

  const lineCbmTotal = lines.reduce((sum, row) => sum + (row.cbm_total || 0), 0);
  const documentCbmTotal = numeric(documentTotals.cbm_total);
  if (documentCbmTotal !== null && lineCbmTotal > 0 && !nearlyEqual(documentCbmTotal, lineCbmTotal, 0.02)) {
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
      general: {
        supplier_id: null,
        supplier_name: nullableText(general.supplier_name),
        proforma_number: nullableText(general.proforma_number),
        document_date: isoDate(general.document_date),
        valid_until: isoDate(general.valid_until),
        currency: nullableText(general.currency)?.toUpperCase() || null,
        incoterm: nullableText(general.incoterm)?.toUpperCase() || null,
        origin_port: nullableText(general.origin_port),
        destination_port: nullableText(general.destination_port),
        payment_terms: nullableText(general.payment_terms),
        production_days: integer(general.production_days),
        order_number: nullableText(general.order_number),
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
