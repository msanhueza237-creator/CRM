import { flattenResults, type CentralMessage } from "./copilotCentralApi";
import { Workbook } from "exceljs";

const textValue = (value: unknown) =>
  value == null
    ? "No disponible"
    : typeof value === "object"
      ? JSON.stringify(value)
      : String(value);
// Prevent spreadsheet formulas when business data begins with a formula marker.
export const spreadsheetText = (value: unknown) =>
  /^[=+@\-\t\r]/.test(textValue(value))
    ? `'${textValue(value)}`
    : textValue(value);
function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob),
    anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
export function customerPriceRows(message: CentralMessage) {
  const records = new Map<string, Record<string, unknown>>();
  for (const result of flattenResults(message.metadata?.results || [])) {
    if (result.toolName !== "get_price_list") continue;
    const list = (result.data as { client_price_list?: { complete?: boolean; records?: Record<string, unknown>[] } } | null)?.client_price_list;
    if (!list?.complete || !Array.isArray(list.records)) continue;
    for (const row of list.records) {
      if ((row.net !== null && (typeof row.net !== "number" || row.net <= 0 || !/^[A-Z]{3}$/.test(String(row.currency)) || !row.price_updated_at)) || typeof row.stock !== "number" || row.stock <= 0 || !row.sku || !row.name || !row.stock_updated_at) throw new Error("La lista contiene un precio, moneda o stock sin verificar. Vuelve a consultar.");
      const safe = Object.fromEntries(["sku", "name", "net", "stock", "currency", "list_id", "stock_updated_at", "price_updated_at"].map((key) => [key, row[key]]));
      const key = `${row.sku}|${row.currency}`;
      const previous = records.get(key);
      if (previous && JSON.stringify(previous) !== JSON.stringify(safe)) throw new Error("Hay versiones o listas distintas para el mismo SKU. Genera una nueva lista con una sola tarifa.");
      records.set(key, safe);
    }
  }
  return [...records.values()].sort((a, b) => String(a.name).localeCompare(String(b.name), "es"));
}

export async function exportCustomerPriceList(message: CentralMessage) {
  const records = customerPriceRows(message);
  if (!records.length) throw new Error("No hay productos con precio y stock verificados para enviar a clientes.");
  const book = new Workbook();
  book.creator = "CLIMACTIVA";
  for (const currency of [...new Set(records.map((r) => String(r.currency || "Por confirmar")))]) {
    const selected = records.filter((r) => (r.currency || "Por confirmar") === currency);
    const sheet = book.addWorksheet(`Precios ${currency}`, { views: [{ state: "frozen", ySplit: 4 }], pageSetup: { paperSize: 9, orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
    sheet.columns = [{ width: 25 }, { width: 78 }, { width: 23 }, { width: 19 }];
    sheet.mergeCells("A1:D1"); sheet.getCell("A1").value = "CLIMACTIVA | Lista de precios";
    sheet.getCell("A1").font = { size: 18, bold: true, color: { argb: "FF087B89" } }; sheet.getRow(1).height = 32;
    sheet.mergeCells("A2:D2"); sheet.getCell("A2").value = `Precios netos en ${currency}, sin IVA. Stock registrado sujeto a confirmacion. Lista Facto ${[...new Set(selected.map((r) => r.list_id))].join(", ")}.`;
    const dates = selected.flatMap((r) => [r.stock_updated_at, r.price_updated_at].filter(Boolean).map(String)).sort();
    sheet.mergeCells("A3:D3"); sheet.getCell("A3").value = `Fuente: Facto. Datos observados entre ${dates[0].slice(0, 10)} y ${dates[dates.length - 1].slice(0, 10)}. ${selected.length} productos.`;
    sheet.getRow(4).values = ["SKU", "Nombre", `Precio neto ${currency}`, "Stock registrado"];
    sheet.getRow(4).font = { bold: true, color: { argb: "FFFFFFFF" } };
    sheet.getRow(4).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF087B89" } }; sheet.getRow(4).height = 25;
    for (const record of selected) {
      const row = sheet.addRow([spreadsheetText(record.sku), spreadsheetText(record.name), record.net ?? "Por confirmar", record.stock]);
      row.alignment = { wrapText: true, vertical: "middle" }; row.height = Math.max(32, Math.ceil(String(record.name).length / 70) * 16 + 8);
      const priceDecimals = Math.max(2, String(record.net).split(".")[1]?.length || 0);
      const stockDecimals = String(record.stock).split(".")[1]?.length || 0;
      row.getCell(3).numFmt = `#,##0.${"0".repeat(priceDecimals)}`;
      row.getCell(4).numFmt = `#,##0${stockDecimals ? "." + "0".repeat(stockDecimals) : ""}`;
      row.getCell(1).note = `Precio observado: ${record.price_updated_at}\nStock observado: ${record.stock_updated_at}`;
      if (row.number % 2) row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF1F7F8" } };
    }
    sheet.autoFilter = "A4:D4";
    sheet.pageSetup.printTitlesRow = "1:4";
  }
  download(new Blob([await book.xlsx.writeBuffer()], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), `CLIMACTIVA-lista-precios-${new Date().toISOString().slice(0, 10)}.xlsx`);
}
export async function exportCentralMessage(
  message: CentralMessage,
  format: "excel" | "pdf" | "csv",
) {
  const results = flattenResults(message.metadata?.results || []),
    tables = results.filter((r) => r.table);
  const filename = `copiloto-${message.id.slice(0, 12)}`;
  const provenance = results.flatMap((r) => [
    r.summary,
    `Consulta: ${r.freshness.fetchedAt}. Fuente: ${r.freshness.sourceObservedAt || "Fecha no disponible"}.`,
    `Cobertura: ${r.coverage.returned} filas de ${r.coverage.totalMatched ?? "total desconocido"}.`,
    ...r.warnings,
    ...r.evidence.map((e) => `${e.label}: ${e.path}`),
  ]);
  if (format === "csv") {
    const lines: string[][] = [
      ["Respuesta"],
      [message.content],
      ["Fuentes y cobertura"],
      ...provenance.map((p) => [p]),
    ];
    for (const result of tables) {
      lines.push(
        [],
        [result.table!.title],
        result.table!.columns.map((c) => c.label),
      );
      lines.push(
        ...result.table!.rows.map((row) =>
          result.table!.columns.map((c) => textValue(row[c.key])),
        ),
      );
    }
    download(
      new Blob(
        [
          "\ufeff" +
            lines
              .map((row) =>
                row
                  .map(
                    (cell) => `"${spreadsheetText(cell).replace(/"/g, '""')}"`,
                  )
                  .join(";"),
              )
              .join("\r\n"),
        ],
        { type: "text/csv;charset=utf-8" },
      ),
      `${filename}.csv`,
    );
    return;
  }
  if (format === "excel") {
    const workbook = new Workbook();
    workbook.creator = "Latin Chile CRM";
    const summary = workbook.addWorksheet("Resumen");
    summary.columns = [{ width: 105 }];
    summary.addRows([
      ["COPILOTO LATIN CHILE"],
      [message.content],
      ["Trazabilidad"],
      ...provenance.map((p) => [p]),
    ]);
    summary.eachRow((row) => {
      row.alignment = { wrapText: true, vertical: "top" };
    });
    for (const [index, result] of tables.entries()) {
      const table = result.table!,
        sheet = workbook.addWorksheet(`Datos ${index + 1}`, {
          views: [{ state: "frozen", ySplit: 3 }],
        });
      sheet.addRow([table.title]);
      sheet.addRow([
        `${result.coverage.returned} de ${result.coverage.totalMatched ?? "?"} registros; exportacion de la pagina consultada.`,
      ]);
      sheet.addRow(table.columns.map((c) => c.label));
      for (const row of table.rows)
        sheet.addRow(
          table.columns.map((c) =>
            typeof row[c.key] === "number"
              ? row[c.key]
              : spreadsheetText(row[c.key]),
          ),
        );
      sheet.columns.forEach((column) => {
        column.width = 27;
        column.alignment = { wrapText: true, vertical: "top" };
      });
      sheet.getRow(3).font = { bold: true, color: { argb: "FFFFFFFF" } };
      sheet.getRow(3).fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FF087B89" },
      };
      sheet.autoFilter = {
        from: { row: 3, column: 1 },
        to: { row: 3, column: table.columns.length },
      };
    }
    download(
      new Blob([await workbook.xlsx.writeBuffer()], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
      `${filename}.xlsx`,
    );
    return;
  }
  const { jsPDF } = await import("jspdf");
  const pdf = new jsPDF();
  let y = 18;
  const line = (value: string, bold = false) => {
    pdf.setFont("helvetica", bold ? "bold" : "normal");
    pdf.setFontSize(bold ? 12 : 10);
    for (const wrapped of pdf.splitTextToSize(
      value.replace(/\*\*/g, "").replace(/^#+\s/gm, ""),
      176,
    )) {
      if (y > 275) {
        pdf.addPage();
        y = 18;
      }
      pdf.text(wrapped, 17, y);
      y += 5;
    }
    y += 3;
  };
  line("LATIN CHILE | Copiloto", true);
  line(message.content);
  for (const result of tables) {
    line(result.table!.title, true);
    for (const row of result.table!.rows)
      line(
        result
          .table!.columns.map((c) => `${c.label}: ${textValue(row[c.key])}`)
          .join(" | "),
      );
  }
  line("Fuentes y cobertura", true);
  provenance.forEach((p) => line(p));
  pdf.save(`${filename}.pdf`);
}
