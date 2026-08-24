import {
  buildExtractionRanges,
  type ExtractionRange,
  type JsonRecord,
} from "./extraction-logic.ts";

export const FOREIGN_TRADE_PDF_SKILL_VERSION = "foreign_trade_pdf_reader_v1";

export type ForeignTradePdfDocumentType =
  | "proforma"
  | "purchase_order"
  | "commercial_invoice"
  | "packing_list"
  | string;

export type ForeignTradePdfReadingSkill = {
  version: string;
  documentType: ForeignTradePdfDocumentType;
  headerPrompt: string;
  linePrompt: (range: ExtractionRange, mode: "extract" | "recover" | "verify") => string;
};

export type PdfExtractionQuality = {
  score: number;
  coverage: number | null;
  expectedLineCount: number | null;
  extractedLineCount: number;
  requiresVerification: boolean;
  critical: boolean;
  warnings: string[];
  verificationRanges: ExtractionRange[];
};

const documentProfiles: Record<string, { label: string; headerRules: string; lineRules: string }> = {
  proforma: {
    label: "proforma invoice",
    headerRules: "Prioriza PI No., Proforma No. o Invoice No. Si no existen y aparece Order No., conserva Order No. y úsalo como referencia secundaria sin inventar otra numeración.",
    lineRules: "Los precios suelen ser EXW, FOB o CIF. Respeta exactamente la base comercial y las columnas TOTAL CTNS, TOTAL G.W. y TOTAL CBM.",
  },
  purchase_order: {
    label: "purchase order",
    headerRules: "Prioriza PO No., Purchase Order No. u Order No. como referencia documental.",
    lineRules: "Conserva cantidades ordenadas, unidades de empaque, precio pactado y referencia del proveedor. No confundas cantidades pendientes con cantidades compradas.",
  },
  commercial_invoice: {
    label: "commercial invoice",
    headerRules: "Prioriza Invoice No. y la fecha de factura. Separa el número de orden o contrato si también aparece.",
    lineRules: "Extrae únicamente importes facturados y respeta la moneda. No conviertas montos ni agregues impuestos que no estén impresos.",
  },
  packing_list: {
    label: "packing list",
    headerRules: "Prioriza Packing List No., Shipment No. o la referencia de embarque. Los precios pueden no existir y deben permanecer null.",
    lineRules: "Prioriza cantidad, cajas, peso neto, peso bruto, dimensiones y CBM. No interpretes peso o volumen como precio.",
  },
};

export function createForeignTradePdfReadingSkill(documentType: ForeignTradePdfDocumentType): ForeignTradePdfReadingSkill {
  const profile = documentProfiles[documentType] || {
    label: "documento de comercio exterior",
    headerRules: "Conserva la referencia documental exactamente como aparece y no sustituyas campos ausentes.",
    lineRules: "Respeta literalmente los encabezados y unidades de cada columna.",
  };

  return {
    version: FOREIGN_TRADE_PDF_SKILL_VERSION,
    documentType,
    headerPrompt: `Actúa como lector documental especializado en comercio exterior. Analiza visual y textualmente
todas las páginas u hojas de este ${profile.label}; no leas solo la primera página ni una muestra.

Objetivo de esta pasada:
1. Extraer encabezado, condiciones y totales impresos.
2. Contar el número EXACTO de filas comerciales físicas del documento.
3. Conservar la trazabilidad y señalar datos ausentes o ambiguos.

Cuenta cada producto real una vez aunque su descripción continúe en otra línea. Incluye productos sin
número impreso. No incluyas encabezados repetidos, subtotales, pies de página ni líneas de transporte como
productos. ${profile.headerRules}

Usa exclusivamente datos visibles. Nunca inventes fechas, vigencias, puertos, referencias, condiciones,
pesos, precios, cantidades ni totales. Convierte fechas inequívocas a YYYY-MM-DD. La fecha impresa en el
documento prevalece sobre el nombre del archivo. TOTAL CTNS, TOTAL G.W., TOTAL N.W. y TOTAL CBM son
totales documentales. Usa null cuando un dato no aparezca. No calcules en esta pasada valores faltantes.`,
    linePrompt: (range, mode) => buildLinePrompt(profile.label, profile.lineRules, range, mode),
  };
}

export function assessPdfExtractionQuality(value: unknown, chunkSize = 30): PdfExtractionQuality {
  const source = asObject(value);
  const totals = asObject(source.document_totals);
  const lines = Array.isArray(source.lines) ? source.lines.map(asObject) : [];
  const expectedLineCount = integer(totals.line_count);
  const coverage = expectedLineCount && expectedLineCount > 0 ? lines.length / expectedLineCount : null;
  const warnings: string[] = [];
  let penalty = 0;

  if (coverage !== null && coverage < 1) {
    warnings.push(`Cobertura documental: ${lines.length} de ${expectedLineCount} filas (${Math.round(coverage * 100)}%).`);
    penalty += (1 - coverage) * 100;
  }

  const checks: Array<{ label: string; totalKey: string; lineKey: string; tolerance: number }> = [
    { label: "importe", totalKey: "total", lineKey: "total_price", tolerance: 0.01 },
    { label: "cajas", totalKey: "boxes", lineKey: "box_count", tolerance: 0.01 },
    { label: "peso bruto", totalKey: "gross_weight_kg", lineKey: "gross_weight_kg", tolerance: 0.02 },
    { label: "CBM", totalKey: "cbm_total", lineKey: "cbm_total", tolerance: 0.015 },
  ];
  for (const check of checks) {
    const documentValue = number(totals[check.totalKey]);
    if (documentValue === null) continue;
    const present = lines.map((line) => number(line[check.lineKey])).filter((item): item is number => item !== null);
    if (!present.length) {
      warnings.push(`El documento informa ${check.label} total, pero no se reconocieron valores por producto.`);
      penalty += 10;
      continue;
    }
    const sum = round(present.reduce((total, item) => total + item, 0), 9);
    const difference = relativeDifference(documentValue, sum);
    if (difference > check.tolerance) {
      warnings.push(`No concilia ${check.label}: total documental ${documentValue} versus suma de filas ${sum}.`);
      penalty += Math.min(20, difference * 100);
    }
  }

  const missingEvidence = lines.filter((line) => integer(line.source_page) === null).length;
  if (lines.length && missingEvidence) {
    warnings.push(`${missingEvidence} fila(s) no tienen página de evidencia identificada.`);
    penalty += Math.min(10, missingEvidence / lines.length * 10);
  }

  const critical = coverage !== null && coverage < 0.8;
  const requiresVerification = Boolean(warnings.length);
  return {
    score: Math.max(0, round((coverage ?? 1) * 100 - penalty, 3)),
    coverage,
    expectedLineCount,
    extractedLineCount: lines.length,
    requiresVerification,
    critical,
    warnings,
    verificationRanges: buildExtractionRanges(expectedLineCount, chunkSize),
  };
}

function buildLinePrompt(label: string, lineRules: string, range: ExtractionRange, mode: "extract" | "recover" | "verify") {
  const allRows = range.end >= 500;
  const target = allRows
    ? "todas las filas comerciales físicas del documento, desde la primera hasta la última"
    : `las filas comerciales físicas ordinales ${range.start} a ${range.end}, ambas incluidas`;
  const modeInstruction = mode === "verify"
    ? "Esta es una lectura independiente de verificación. Relee cada celda numérica y corrige errores de columna, decimal o fila; no copies una respuesta anterior."
    : mode === "recover"
      ? "Esta es una pasada de recuperación. Localiza todas las posiciones solicitadas y no omitas ninguna."
      : "Realiza una extracción completa del rango solicitado, sin muestras ni filas representativas.";

  return `Actúa como lector documental especializado en ${label}. Analiza visual y textualmente todas las
páginas u hojas y extrae ${target}.

${modeInstruction}

Reglas obligatorias:
- source_index es la posición física global del producto comenzando en 1.
- source_page es el número de página PDF donde comienza la fila; comienza en 1.
- source_row_label conserva el número o etiqueta impresa de la fila, incluso si difiere de source_index.
- Una fila sin número impreso también cuenta y desplaza las posiciones siguientes.
- Si el rango solicitado supera la última fila real, devuelve solo las filas que existan; nunca inventes filas para llenar el rango.
- Une descripciones partidas en varias líneas y asocia sus cifras con el producto correcto.
- Conserva la descripción original literalmente en description_original. Si no está en español,
  tradúcela fielmente en description_translated sin agregar prestaciones ni corregir el producto.
- Busca la identidad comercial en Item No., Product Code, Supplier Code, Reference, Model y dentro de
  la descripción. supplier_product_code es el código principal del proveedor; supplier_reference y
  model conservan sus campos propios. No asumas que una columna SKU contiene el SKU interno del CRM.
- No interpretes voltajes, frecuencias, potencias, capacidades o dimensiones aisladas como códigos.
  Conserva esos datos visibles en technical_attributes para validar compatibilidad entre productos.
- Ignora encabezados repetidos, subtotales, totales y pies de página como productos.
- Conserva ceros impresos; no los conviertas en null.
- Mantén puntos decimales y no interpretes separadores de millares como decimales.
- TOTAL CBM es el volumen TOTAL de la fila y va en cbm_total, nunca en cbm_per_box.
- cbm_per_box solo se usa si el documento identifica expresamente volumen por caja.
- No traslades un CBM, peso o importe de una línea de continuación a otro producto.
- unit_price y total_price conservan la base comercial visible, sin calcular impuestos ni conversiones.
- ${lineRules}
- Usa null para datos ausentes. No inventes ni completes hechos con conocimiento externo.

Antes de responder, comprueba visualmente la primera y la última fila del rango y verifica que no existan
saltos en source_index.`;
}

function asObject(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function number(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const result = typeof value === "number" ? value : Number(String(value).replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(result) ? result : null;
}

function integer(value: unknown) {
  const result = number(value);
  return result === null ? null : Math.max(0, Math.round(result));
}

function relativeDifference(left: number, right: number) {
  return Math.abs(left - right) / Math.max(Math.abs(left), Math.abs(right), 1);
}

function round(value: number, digits = 6) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
