import type { Row, Worksheet } from "exceljs";
import type { ForeignTradeOperationDetail } from "../../types/foreignTrade";
import type {
  ForeignTradeCostingResult,
  ForeignTradeCostingSettings,
} from "./foreignTradeCostEngine";

const workbookMimeType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const darkTeal = "FF17464E";
const teal = "FF087F8C";
const paleTeal = "FFEAF4F4";
const paleGold = "FFFFF4D8";
const gray = "FF6A7F84";
const white = "FFFFFFFF";
const clpFormat = "$#,##0";
const decimalFormat = "#,##0.000";
const percentFormat = "0.00\"%\"";

export async function exportForeignTradeCostingExcel({
  detail,
  result,
  settings,
}: {
  detail: ForeignTradeOperationDetail;
  result: ForeignTradeCostingResult;
  settings: ForeignTradeCostingSettings;
}) {
  const ExcelJS = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "CRM LatinChile";
  workbook.created = new Date();
  workbook.modified = new Date();
  workbook.subject = `Costeo de importacion ${detail.operation.reference}`;

  addSummarySheet(workbook.addWorksheet("Resumen", { views: [{ state: "frozen", ySplit: 4 }] }), detail, result, settings);
  addProductsSheet(workbook.addWorksheet("Productos", { views: [{ state: "frozen", ySplit: 4 }] }), detail, result);
  addCostsSheet(workbook.addWorksheet("Gastos", { views: [{ state: "frozen", ySplit: 4 }] }), detail);

  const buffer = await workbook.xlsx.writeBuffer();
  downloadBlob(
    new Blob([buffer], { type: workbookMimeType }),
    `costeo-${safeFilename(detail.operation.reference || detail.operation.title)}-${dateStamp()}.xlsx`,
  );
}

function addSummarySheet(
  sheet: Worksheet,
  detail: ForeignTradeOperationDetail,
  result: ForeignTradeCostingResult,
  settings: ForeignTradeCostingSettings,
) {
  addTitle(
    sheet,
    `Costeo de importacion - ${detail.operation.reference}`,
    detail.operation.title,
    4,
  );
  sheet.addRow([]);
  addSectionTitle(sheet, "Operacion", 4);
  const operationRows = addKeyValueRows(sheet, [
    ["Proveedor", detail.supplier?.company_name || detail.supplier?.name || "Sin proveedor vinculado", "Estado", detail.operation.status],
    ["Incoterm", detail.operation.incoterm || "Sin informar", "Transporte", detail.operation.transport_type],
    ["Tipo de cambio USD/CLP", settings.exchangeRateClp, "Fuente", detail.operation.exchange_rate_source],
    ["Distribucion", allocationLabel(settings.allocationMethod), "Metodo de precio", pricingLabel(settings.pricingMethod)],
    ["Objetivo general", settings.targetPercent, "IVA importacion recuperable", settings.importVatRecoverable ? "Si" : "No"],
    ["Productos", detail.lines.length, "Unidades", detail.totals.units],
  ]);
  operationRows[2].getCell(2).numFmt = clpFormat;
  operationRows[4].getCell(2).numFmt = percentFormat;

  sheet.addRow([]);
  addSectionTitle(sheet, "Resultado del escenario", 4);
  const resultStart = sheet.rowCount + 1;
  addKeyValueRows(sheet, [
    ["Costo factura / mercaderia", sum(result.lines.map((line) => line.invoiceTotalClp)), "CIF aduanero", result.cifClp],
    ["Derechos", result.dutyClp, "IVA importacion", result.importVatClp],
    ["Gastos operativos economicos", result.operatingExpensesEconomicClp, "IVA recuperable total", result.recoverableVatClp],
    ["Costo total puesto en bodega", result.landedTotalClp, "Necesidad total de caja", result.totalCashRequirementClp],
    ["Venta neta proyectada", result.projectedNetSalesClp, "Venta final proyectada", result.projectedFinalSalesClp],
    ["Utilidad proyectada", result.projectedProfitClp, "Margen proyectado", result.projectedMarginPercent],
  ]);
  for (let row = resultStart; row <= sheet.rowCount; row += 1) {
    sheet.getCell(row, 2).numFmt = clpFormat;
    sheet.getCell(row, 4).numFmt = row === sheet.rowCount ? percentFormat : clpFormat;
  }

  sheet.addRow([]);
  addSectionTitle(sheet, "Advertencias y trazabilidad", 4);
  const warnings = result.missingInputs.length
    ? result.missingInputs
    : ["Escenario calculado sin datos pendientes detectados."];
  warnings.forEach((warning) => {
    const row = sheet.addRow([warning]);
    sheet.mergeCells(row.number, 1, row.number, 4);
    row.getCell(1).alignment = { vertical: "top", wrapText: true };
    row.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: result.missingInputs.length ? paleGold : paleTeal } };
  });
  const generated = sheet.addRow(["Exportado", new Date().toLocaleString("es-CL"), "Version de calculo", "cl_import_cost_v3_invoice_floor"]);
  styleKeyValueRow(generated);

  sheet.columns = [
    { width: 34 },
    { width: 24 },
    { width: 32 },
    { width: 24 },
  ];
}

function addProductsSheet(sheet: Worksheet, detail: ForeignTradeOperationDetail, result: ForeignTradeCostingResult) {
  addTitle(sheet, "Tabla dinamica por producto", `${detail.operation.reference} - ${result.lines.length} productos`, 24);
  sheet.addRow([]);
  const headers = [
    "Linea",
    "Producto",
    "SKU",
    "Cantidad",
    "Moneda origen",
    "Costo fabrica unit. origen",
    "Costo factura unit. CLP",
    "Costo factura total CLP",
    "CIF asignado total CLP",
    "CIF unitario CLP",
    "Derecho %",
    "Derecho CLP",
    "IVA importacion CLP",
    "Gastos total CLP",
    "Gastos unitarios CLP",
    "Costo bodega total CLP",
    "Costo bodega unit. CLP",
    "Objetivo %",
    "Precio neto unit. CLP",
    "IVA venta unit. CLP",
    "Precio final unit. CLP",
    "Venta final total CLP",
    "Utilidad unit. CLP",
    "Utilidad total CLP",
    "Markup %",
    "Margen %",
  ];
  const headerRow = sheet.addRow(headers);
  styleHeader(headerRow);

  const sourceById = new Map(detail.lines.map((line) => [line.id, line]));
  result.lines.forEach((line) => {
    const source = sourceById.get(line.lineId);
    const quantity = Number(line.quantity || 0);
    const row = sheet.addRow([
      source?.line_number || "",
      line.productName,
      line.sku || line.supplierCode || line.supplierModel || source?.supplier_sku || "",
      quantity,
      source?.currency || detail.operation.base_currency,
      Number(source?.unit_factory_cost || 0),
      line.invoiceUnitClp,
      line.invoiceTotalClp,
      line.cifClp,
      quantity ? line.cifClp / quantity : 0,
      line.dutyPercent,
      line.dutyClp,
      line.importVatClp,
      line.allocatedExpensesClp,
      quantity ? line.allocatedExpensesClp / quantity : 0,
      line.landedTotalClp,
      line.landedUnitClp,
      line.targetPercent,
      line.netSaleUnitClp,
      line.salesVatUnitClp,
      line.finalSaleUnitClp,
      line.finalSaleUnitClp * quantity,
      line.profitUnitClp,
      line.profitUnitClp * quantity,
      line.markupPercent,
      line.marginPercent,
    ]);
    styleDataRow(row);
    [7, 8, 9, 10, 12, 13, 14, 15, 16, 17, 19, 20, 21, 22, 23, 24].forEach((column) => {
      row.getCell(column).numFmt = clpFormat;
    });
    [11, 18, 25, 26].forEach((column) => {
      row.getCell(column).numFmt = percentFormat;
    });
    row.getCell(6).numFmt = decimalFormat;
  });

  const totalRow = sheet.addRow([
    "",
    "TOTALES",
    "",
    sum(result.lines.map((line) => line.quantity)),
    "",
    "",
    "",
    sum(result.lines.map((line) => line.invoiceTotalClp)),
    result.cifClp,
    "",
    "",
    result.dutyClp,
    result.importVatClp,
    result.operatingExpensesEconomicClp,
    "",
    result.landedTotalClp,
    "",
    "",
    "",
    "",
    "",
    result.projectedFinalSalesClp,
    "",
    result.projectedProfitClp,
    "",
    result.projectedMarginPercent,
  ]);
  totalRow.font = { bold: true, color: { argb: darkTeal } };
  totalRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: paleTeal } };
  [8, 9, 12, 13, 14, 16, 22, 24].forEach((column) => { totalRow.getCell(column).numFmt = clpFormat; });
  totalRow.getCell(26).numFmt = percentFormat;

  sheet.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4, column: headers.length } };
  sheet.columns = headers.map((header, index) => ({
    width: index === 1 ? 38 : index === 2 ? 18 : Math.max(13, Math.min(24, header.length + 2)),
  }));
}

function addCostsSheet(sheet: Worksheet, detail: ForeignTradeOperationDetail) {
  addTitle(sheet, "Gastos y tributos registrados", `${detail.operation.reference} - ${detail.costs.length} registros`, 15);
  sheet.addRow([]);
  const headers = [
    "Concepto",
    "Categoria",
    "Monto original",
    "Moneda",
    "Tipo cambio CLP",
    "Monto CLP",
    "Distribucion",
    "Base monto",
    "IVA CLP",
    "Total bruto CLP",
    "Impuesto recuperable",
    "Incluido en costeo",
    "Fuente",
    "Producto asociado",
    "Notas",
  ];
  const headerRow = sheet.addRow(headers);
  styleHeader(headerRow);
  const productById = new Map(detail.lines.map((line) => [line.id, line.product_name]));

  detail.costs.forEach((cost) => {
    const row = sheet.addRow([
      cost.name,
      categoryLabel(cost.category),
      cost.amount_original,
      cost.currency,
      cost.exchange_rate_clp || "",
      cost.amount_clp || 0,
      allocationLabel(cost.allocation_method),
      String(cost.metadata?.amount_basis || "net"),
      Number(cost.metadata?.vat_amount_clp || 0),
      Number(cost.metadata?.gross_amount_clp || 0),
      cost.recoverable_tax ? "Si" : "No",
      cost.metadata?.excluded_from_costing ? "No" : "Si",
      cost.source_type,
      cost.operation_line_id ? productById.get(cost.operation_line_id) || cost.operation_line_id : "Operacion completa",
      cost.notes || "",
    ]);
    styleDataRow(row);
    row.getCell(3).numFmt = decimalFormat;
    [5, 6, 9, 10].forEach((column) => { row.getCell(column).numFmt = clpFormat; });
  });

  const totalRow = sheet.addRow(["TOTALES", "", "", "", "", sum(detail.costs.map((cost) => Number(cost.amount_clp || 0)))]);
  totalRow.font = { bold: true, color: { argb: darkTeal } };
  totalRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: paleTeal } };
  totalRow.getCell(6).numFmt = clpFormat;
  sheet.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4, column: headers.length } };
  sheet.columns = headers.map((header, index) => ({ width: index === 0 || index === 13 || index === 14 ? 34 : Math.max(13, Math.min(24, header.length + 2)) }));
}

function addTitle(sheet: Worksheet, title: string, subtitle: string, columns: number) {
  sheet.mergeCells(1, 1, 1, columns);
  const titleCell = sheet.getCell(1, 1);
  titleCell.value = title;
  titleCell.font = { bold: true, color: { argb: white }, size: 16 };
  titleCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: darkTeal } };
  titleCell.alignment = { vertical: "middle" };
  sheet.getRow(1).height = 28;
  sheet.mergeCells(2, 1, 2, columns);
  const subtitleCell = sheet.getCell(2, 1);
  subtitleCell.value = subtitle;
  subtitleCell.font = { color: { argb: gray }, italic: true };
}

function addSectionTitle(sheet: Worksheet, title: string, columns: number) {
  const row = sheet.addRow([title]);
  sheet.mergeCells(row.number, 1, row.number, columns);
  row.getCell(1).font = { bold: true, color: { argb: white } };
  row.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: teal } };
}

function addKeyValueRows(sheet: Worksheet, values: Array<[string, string | number, string, string | number]>) {
  return values.map((valuesForRow) => {
    const row = sheet.addRow(valuesForRow);
    styleKeyValueRow(row);
    return row;
  });
}

function styleKeyValueRow(row: Row) {
  [1, 3].forEach((column) => {
    row.getCell(column).font = { bold: true, color: { argb: darkTeal } };
    row.getCell(column).fill = { type: "pattern", pattern: "solid", fgColor: { argb: paleTeal } };
  });
  row.alignment = { vertical: "middle", wrapText: true };
}

function styleHeader(row: Row) {
  row.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: white }, size: 9 };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: teal } };
    cell.alignment = { vertical: "middle", wrapText: true };
  });
  row.height = 34;
}

function styleDataRow(row: Row) {
  row.alignment = { vertical: "middle", wrapText: true };
  row.eachCell((cell) => {
    cell.border = { bottom: { style: "hair", color: { argb: "FFDDE7E8" } } };
  });
}

function allocationLabel(method: string) {
  return ({
    operation: "Operacion completa",
    fob_value: "Valor FOB",
    cif_value: "Valor CIF",
    units: "Unidades",
    weight: "Peso bruto",
    cbm: "CBM",
    manual: "Manual",
    combined: "Combinacion equilibrada",
  } as Record<string, string>)[method] || method;
}

function pricingLabel(method: ForeignTradeCostingSettings["pricingMethod"]) {
  return method === "margin_on_sale" ? "Margen sobre venta" : "Markup sobre costo";
}

function categoryLabel(category: string) {
  return ({
    merchandise: "Mercaderia",
    origin: "Gastos en origen",
    international_freight: "Flete internacional",
    insurance: "Seguro",
    chile_port: "Puerto Chile",
    storage: "Almacenaje",
    customs_agency: "Agencia de aduana",
    national_transport: "Transporte nacional",
    inspection: "Inspeccion",
    certificate: "Certificados",
    duties: "Derechos",
    taxes: "Impuestos",
    supplier_charge: "Cargo proveedor",
    other: "Otro",
  } as Record<string, string>)[category] || category;
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + Number(value || 0), 0);
}

function safeFilename(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70) || "operacion";
}

function dateStamp() {
  return new Date().toISOString().slice(0, 10);
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
