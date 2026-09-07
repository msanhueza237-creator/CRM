import { flattenResults, type CentralMessage } from "./copilotCentralApi";

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
    const { Workbook } = await import("exceljs");
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
