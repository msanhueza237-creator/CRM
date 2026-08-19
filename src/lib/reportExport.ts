import type { CopilotReportSnapshot } from "./copilotApi";

const teal = "087F8C";
const deepTeal = "17464E";
const paleTeal = "EAF4F4";
const gold = "D39A2C";
const red = "C85A45";
const green = "3E8B62";
const gray = "6A7F84";

export async function exportReportPdf(report: CopilotReportSnapshot) {
  const { jsPDF } = await import("jspdf");
  const document = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait" });
  const pageWidth = document.internal.pageSize.getWidth();
  const pageHeight = document.internal.pageSize.getHeight();
  const margin = 14;
  const contentWidth = pageWidth - margin * 2;
  let y = 0;

  const addHeader = (continued = false) => {
    document.setFillColor(`#${deepTeal}`);
    document.rect(0, 0, pageWidth, 26, "F");
    document.setTextColor(255, 255, 255);
    document.setFont("helvetica", "bold");
    document.setFontSize(continued ? 12 : 17);
    document.text(continued ? `${report.title} - continuacion` : report.title, margin, continued ? 16 : 13);
    if (!continued) {
      document.setFont("helvetica", "normal");
      document.setFontSize(8.5);
      document.text(`${report.periodLabel} | Actualizado ${formatDateTime(report.generatedAt)}`, margin, 20);
    }
    y = 34;
  };

  const ensureSpace = (height: number) => {
    if (y + height <= pageHeight - 14) return;
    document.addPage();
    addHeader(true);
  };

  const sectionTitle = (title: string, subtitle?: string) => {
    ensureSpace(subtitle ? 18 : 12);
    document.setTextColor(`#${deepTeal}`);
    document.setFont("helvetica", "bold");
    document.setFontSize(12);
    document.text(title, margin, y);
    y += 5;
    if (subtitle) {
      document.setTextColor(`#${gray}`);
      document.setFont("helvetica", "normal");
      document.setFontSize(8);
      document.text(subtitle, margin, y);
      y += 6;
    } else {
      y += 4;
    }
  };

  const paragraph = (text: string, tone = gray) => {
    const lines = document.splitTextToSize(cleanText(text), contentWidth) as string[];
    const height = Math.max(lines.length * 4.2, 5);
    ensureSpace(height + 2);
    document.setTextColor(`#${tone}`);
    document.setFont("helvetica", "normal");
    document.setFontSize(8.5);
    document.text(lines, margin, y);
    y += height + 2;
  };

  addHeader();
  paragraph(report.subtitle);

  const kpis = [
    ["Empresas", report.kpis.companies],
    ["Clientes", report.kpis.clients],
    ["Conversion", `${report.kpis.conversionRate}%`],
    ["Interacciones", report.kpis.interactions],
    ["Envios", report.kpis.sent],
    ["Respuesta", `${report.kpis.replyRate}%`],
  ] as const;
  const gap = 3;
  const boxWidth = (contentWidth - gap * 2) / 3;
  kpis.forEach(([label, value], index) => {
    if (index === 3) y += 24;
    const column = index % 3;
    const x = margin + column * (boxWidth + gap);
    document.setFillColor(`#${paleTeal}`);
    document.roundedRect(x, y, boxWidth, 19, 1.5, 1.5, "F");
    document.setTextColor(`#${gray}`);
    document.setFont("helvetica", "bold");
    document.setFontSize(7);
    document.text(label.toUpperCase(), x + 4, y + 6);
    document.setTextColor(`#${deepTeal}`);
    document.setFontSize(14);
    document.text(String(value), x + 4, y + 14);
  });
  y += 27;

  sectionTitle("Lectura ejecutiva");
  report.insights.slice(0, 6).forEach((insight) => {
    ensureSpace(16);
    const color = insight.tone === "positive" ? green : insight.tone === "attention" ? gold : teal;
    document.setFillColor(`#${color}`);
    document.rect(margin, y - 3, 1.5, 12, "F");
    document.setTextColor(`#${deepTeal}`);
    document.setFont("helvetica", "bold");
    document.setFontSize(9);
    document.text(cleanText(insight.title), margin + 4, y);
    y += 4;
    paragraph(insight.detail);
  });

  if (report.financialAnalysis.available) {
    const financial = report.financialAnalysis;
    const resultValue = financial.profitabilityAvailable
      ? Number(financial.profitabilityValue)
      : financial.documentaryDifference;
    const resultLabel = financial.profitabilityAvailable ? "Utilidad contable" : "Diferencia documental";
    sectionTitle(
      `Lectura financiera de ${financial.monthLabel}`,
      financial.profitabilityAvailable ? "Rentabilidad certificada por cierre mensual" : "Lectura referencial; no corresponde a utilidad certificada",
    );
    ensureSpace(28);
    const financialKpis = [
      ["Ventas netas", financial.netSales, teal],
      ["Compras netas", financial.netPurchases, gold],
      [resultLabel, resultValue, resultValue < 0 ? red : green],
    ] as const;
    financialKpis.forEach(([label, value, color], index) => {
      const x = margin + index * (boxWidth + gap);
      document.setFillColor(`#${paleTeal}`);
      document.roundedRect(x, y, boxWidth, 20, 1.5, 1.5, "F");
      document.setFillColor(`#${color}`);
      document.rect(x, y, 1.6, 20, "F");
      document.setTextColor(`#${gray}`);
      document.setFont("helvetica", "bold");
      document.setFontSize(6.7);
      document.text(label.toUpperCase(), x + 4, y + 6);
      document.setTextColor(`#${deepTeal}`);
      document.setFontSize(10.5);
      document.text(formatCurrency(value), x + 4, y + 14, { maxWidth: boxWidth - 7 });
    });
    y += 26;
    paragraph(financial.explanation, deepTeal);
    if (financial.salesTrendPercent !== null) {
      paragraph(`Variacion de ventas frente al mes disponible anterior: ${financial.salesTrendPercent > 0 ? "+" : ""}${financial.salesTrendPercent}%.`);
    }
  }

  sectionTitle("Inteligencia de agentes", `${report.agentIntelligence.agentsWithData} de ${report.agentIntelligence.totalAgents} agentes con datos en el periodo`);
  const agentMax = Math.max(...report.agentIntelligence.agents.map((agent) => agent.completed + agent.failed + agent.pending + agent.running), 1);
  report.agentIntelligence.agents.forEach((agent) => {
    ensureSpace(18);
    const total = agent.completed + agent.failed + agent.pending + agent.running;
    document.setTextColor(`#${deepTeal}`);
    document.setFont("helvetica", "bold");
    document.setFontSize(8.5);
    document.text(agent.label, margin, y);
    document.setTextColor(`#${gray}`);
    document.setFont("helvetica", "normal");
    document.text(`${agent.successRate}% exito | ${total} ejecuciones`, margin + 52, y);
    y += 3;
    document.setFillColor(228, 235, 236);
    document.roundedRect(margin, y, contentWidth, 3, 1, 1, "F");
    document.setFillColor(`#${agent.status === "attention" ? red : agent.status === "running" ? gold : teal}`);
    document.roundedRect(margin, y, Math.max((total / agentMax) * contentWidth, total ? 4 : 0), 3, 1, 1, "F");
    y += 7;
    if (agent.summary) paragraph(agent.summary);
  });

  if (report.campaignAnalysis) {
    sectionTitle(`Campana: ${report.campaignAnalysis.name}`);
    paragraph(report.campaignAnalysis.diagnosis, deepTeal);
  }

  sectionTitle("Rendimiento de campanas");
  drawPdfTable(
    document,
    ["Campana", "Enviados", "Respuestas", "Tasa"],
    report.campaignPerformance.slice(0, 12).map((campaign) => [
      campaign.name,
      String(campaign.sent),
      String(campaign.replies),
      `${campaign.replyRate}%`,
    ]),
    margin,
    contentWidth,
    () => y,
    (nextY) => { y = nextY; },
    ensureSpace,
  );

  if (report.warnings.length) {
    sectionTitle("Alcance y advertencias");
    report.warnings.forEach((warning) => paragraph(`- ${warning}`, red));
  }

  addPdfFooters(document, report);
  document.save(reportFilename(report, "pdf"));
}

export async function exportReportExcel(report: CopilotReportSnapshot) {
  const ExcelJS = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "CRM LatinChile";
  workbook.created = new Date();
  workbook.modified = new Date();
  workbook.subject = report.title;

  const summary = workbook.addWorksheet("Resumen", { views: [{ state: "frozen", ySplit: 4 }] });
  addWorkbookTitle(summary, report.title, report.subtitle, report.periodLabel, report.generatedAt, 4);
  summary.addRow([]);
  summary.addRow(["Indicador", "Valor"]);
  const summaryIndicators: Array<[string, string | number]> = [
    ["Empresas", report.kpis.companies],
    ["Clientes", report.kpis.clients],
    ["Conversion (%)", report.kpis.conversionRate],
    ["Interacciones", report.kpis.interactions],
    ["Campanas", report.kpis.campaigns],
    ["Destinatarios", report.kpis.recipients],
    ["Enviados", report.kpis.sent],
    ["Respuestas", report.kpis.replies],
    ["Tasa de respuesta (%)", report.kpis.replyRate],
    ["Interesados", report.kpis.interested],
  ];
  if (report.financialAnalysis.available) {
    const financial = report.financialAnalysis;
    summaryIndicators.push(
      [`Ventas netas (${financial.monthLabel})`, financial.netSales],
      [`Compras netas (${financial.monthLabel})`, financial.netPurchases],
      [financial.profitabilityAvailable ? "Utilidad contable" : "Diferencia documental", financial.profitabilityAvailable ? Number(financial.profitabilityValue) : financial.documentaryDifference],
      ["Rentabilidad certificada", financial.profitabilityAvailable ? "Si" : "No"],
    );
  }
  summaryIndicators.forEach((row) => summary.addRow(row));
  summary.addRow([]);
  summary.addRow(["Hallazgo", "Detalle", "Tono"]);
  report.insights.forEach((insight) => summary.addRow([insight.title, insight.detail, insight.tone]));
  styleWorksheet(summary, [34, 95, 18]);

  if (report.financialAnalysis.available) {
    const financial = report.financialAnalysis;
    const finances = workbook.addWorksheet("Finanzas", { views: [{ state: "frozen", ySplit: 1 }] });
    finances.addRow(["Indicador", "Valor", "Contexto"]);
    [
      ["Periodo", financial.monthLabel, financial.isCurrentMonth ? "Mes actual" : "Ultimo mes disponible"],
      ["Ventas netas", financial.netSales, `${financial.salesDocuments} documentos`],
      ["IVA ventas", financial.salesTax, "Impuesto informado por Facto"],
      ["Ventas brutas", financial.grossSales, "Neto mas impuestos"],
      ["Compras netas", financial.netPurchases, `${financial.purchaseDocuments} documentos`],
      ["IVA compras", financial.purchaseTax, "Credito fiscal informado por Facto"],
      ["Compras brutas", financial.grossPurchases, "Neto mas impuestos"],
      ["Diferencia documental", financial.documentaryDifference, "Ventas netas menos compras netas; no equivale a utilidad"],
      ["Diferencia sobre ventas (%)", financial.documentaryMarginRate, "Indicador documental"],
      ["Variacion mensual de ventas (%)", financial.salesTrendPercent ?? "Sin base", "Contra el mes disponible anterior"],
      ["Utilidad contable", financial.profitabilityAvailable ? Number(financial.profitabilityValue) : "No certificada", financial.accountingPeriodLabel],
      ["Rentabilidad contable (%)", financial.profitabilityAvailable ? Number(financial.profitabilityRate) : "No certificada", `Estado contable: ${financial.accountingStatus}`],
      ["Actualizacion financiera", financial.updatedAt ? formatDateTime(financial.updatedAt) : "Sin registro", "Origen: snapshot financiero Facto"],
      ["Explicacion", financial.explanation, "Alcance contable"],
      ["Advertencias", financial.warnings.join(" | ") || "Sin advertencias adicionales", "Validaciones del backend"],
    ].forEach((row) => finances.addRow(row));
    styleWorksheet(finances, [34, 34, 92]);
    for (let row = 2; row <= 10; row += 1) finances.getCell(row, 2).numFmt = "#,##0";
  }

  const agents = workbook.addWorksheet("Agentes", { views: [{ state: "frozen", ySplit: 1 }] });
  agents.addRow(["Agente", "Estado", "Exito (%)", "Completadas", "Fallidas", "Pendientes", "En curso", "Ultimo analisis", "Resumen", "Advertencias"]);
  report.agentIntelligence.agents.forEach((agent) => agents.addRow([
    agent.label,
    agentStatusLabel(agent.status),
    agent.successRate,
    agent.completed,
    agent.failed,
    agent.pending,
    agent.running,
    agent.lastRunAt ? formatDateTime(agent.lastRunAt) : "Sin registro",
    agent.summary,
    agent.warnings.join(" | "),
  ]));
  styleWorksheet(agents, [22, 16, 12, 13, 11, 12, 10, 22, 80, 60]);

  const agentMetrics = workbook.addWorksheet("Metricas de agentes", { views: [{ state: "frozen", ySplit: 1 }] });
  agentMetrics.addRow(["Agente", "Metrica", "Valor", "Ultimo analisis"]);
  report.agentIntelligence.agents.forEach((agent) => {
    agent.metrics.forEach((metric) => agentMetrics.addRow([
      agent.label,
      metric.label,
      metric.value,
      agent.lastRunAt ? formatDateTime(agent.lastRunAt) : "Sin registro",
    ]));
  });
  styleWorksheet(agentMetrics, [24, 36, 24, 24]);

  const trends = workbook.addWorksheet("Tendencias", { views: [{ state: "frozen", ySplit: 1 }] });
  trends.addRow(["Periodo", "Interacciones", "Campanas", "Respuestas", "Agentes completadas", "Agentes fallidas", "Agentes pendientes"]);
  const agentTrend = new Map(report.agentIntelligence.taskTrend.map((item) => [item.key, item]));
  report.trend.forEach((item) => {
    const task = agentTrend.get(item.key);
    trends.addRow([item.label, item.interactions, item.campaigns, item.replies, task?.completed ?? 0, task?.failed ?? 0, task?.pending ?? 0]);
  });
  styleWorksheet(trends, [18, 16, 14, 14, 20, 18, 20]);

  const campaigns = workbook.addWorksheet("Campanas", { views: [{ state: "frozen", ySplit: 1 }] });
  campaigns.addRow(["Campana", "Estado", "Canal", "Destinatarios", "Enviados", "Respuestas", "Interesados", "Tasa respuesta (%)"]);
  report.campaignPerformance.forEach((campaign) => campaigns.addRow([
    campaign.name,
    campaign.status,
    campaign.channel,
    campaign.recipients,
    campaign.sent,
    campaign.replies,
    campaign.interested,
    campaign.replyRate,
  ]));
  styleWorksheet(campaigns, [48, 18, 16, 16, 14, 14, 14, 20]);

  const segmentation = workbook.addWorksheet("Segmentacion", { views: [{ state: "frozen", ySplit: 1 }] });
  segmentation.addRow(["Dimension", "Categoria", "Cantidad", "Porcentaje"]);
  [
    ["Etapa comercial", report.funnel],
    ["Tipo de empresa", report.companyTypes],
    ["Origen", report.sources],
    ["Estado de tareas agente", report.agentIntelligence.taskStatus],
    ["Riesgo de propuestas", report.agentIntelligence.proposalRisk],
    ["Severidad de alertas", report.agentIntelligence.alertSeverity],
    ["Salud de integraciones", report.agentIntelligence.integrationStatus],
  ].forEach(([dimension, rows]) => {
    (rows as CopilotReportSnapshot["funnel"]).forEach((row) => segmentation.addRow([dimension, row.label, row.value, row.percentage]));
  });
  styleWorksheet(segmentation, [28, 30, 14, 14]);

  const buffer = await workbook.xlsx.writeBuffer();
  downloadBlob(
    new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
    reportFilename(report, "xlsx"),
  );
}

function addWorkbookTitle(
  worksheet: import("exceljs").Worksheet,
  title: string,
  subtitle: string,
  period: string,
  generatedAt: string,
  columns: number,
) {
  worksheet.mergeCells(1, 1, 1, columns);
  worksheet.getCell(1, 1).value = title;
  worksheet.getCell(1, 1).font = { bold: true, color: { argb: "FFFFFFFF" }, size: 18 };
  worksheet.getCell(1, 1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${deepTeal}` } };
  worksheet.getCell(1, 1).alignment = { vertical: "middle" };
  worksheet.getRow(1).height = 30;
  worksheet.mergeCells(2, 1, 2, columns);
  worksheet.getCell(2, 1).value = subtitle;
  worksheet.mergeCells(3, 1, 3, columns);
  worksheet.getCell(3, 1).value = `${period} | Actualizado ${formatDateTime(generatedAt)}`;
  worksheet.getCell(3, 1).font = { italic: true, color: { argb: `FF${gray}` } };
}

function styleWorksheet(worksheet: import("exceljs").Worksheet, widths: number[]) {
  const headerRows: number[] = [];
  worksheet.eachRow((row, rowNumber) => {
    const firstCell = String(row.getCell(1).value ?? "");
    if (worksheet.name === "Resumen" ? ["Indicador", "Hallazgo"].includes(firstCell) : rowNumber === 1) {
      headerRows.push(rowNumber);
    }
  });
  headerRows.forEach((rowNumber) => {
    const row = worksheet.getRow(rowNumber);
    row.font = { bold: true, color: { argb: "FFFFFFFF" } };
    row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${teal}` } };
    row.alignment = { vertical: "middle" };
  });
  widths.forEach((width, index) => { worksheet.getColumn(index + 1).width = width; });
  worksheet.eachRow((row) => {
    row.alignment = { ...row.alignment, vertical: "top", wrapText: true };
    row.eachCell((cell) => {
      cell.border = {
        bottom: { style: "hair", color: { argb: "FFD8E4E6" } },
      };
    });
  });
  worksheet.autoFilter = worksheet.name === "Resumen" ? undefined : {
    from: { row: 1, column: 1 },
    to: { row: Math.max(worksheet.rowCount, 1), column: Math.max(worksheet.columnCount, 1) },
  };
}

function drawPdfTable(
  document: import("jspdf").jsPDF,
  headers: string[],
  rows: string[][],
  margin: number,
  width: number,
  getY: () => number,
  setY: (value: number) => void,
  ensureSpace: (height: number) => void,
) {
  const widths = [width * 0.55, width * 0.15, width * 0.15, width * 0.15];
  const drawRow = (cells: string[], header = false) => {
    ensureSpace(9);
    let x = margin;
    const y = getY();
    if (header) {
      document.setFillColor(`#${teal}`);
      document.rect(margin, y - 4.5, width, 7, "F");
      document.setTextColor(255, 255, 255);
      document.setFont("helvetica", "bold");
    } else {
      document.setTextColor(`#${deepTeal}`);
      document.setFont("helvetica", "normal");
    }
    document.setFontSize(7.5);
    cells.forEach((cell, index) => {
      document.text(cleanText(cell).slice(0, index === 0 ? 75 : 18), x + 2, y, { maxWidth: widths[index] - 4 });
      x += widths[index];
    });
    setY(y + 8);
  };
  drawRow(headers, true);
  rows.forEach((row) => drawRow(row));
}

function addPdfFooters(document: import("jspdf").jsPDF, report: CopilotReportSnapshot) {
  const pageCount = document.getNumberOfPages();
  for (let page = 1; page <= pageCount; page += 1) {
    document.setPage(page);
    document.setTextColor(`#${gray}`);
    document.setFont("helvetica", "normal");
    document.setFontSize(7);
    document.text("CRM LatinChile | Informe generado desde datos de solo lectura", 14, 290);
    document.text(`${page}/${pageCount} | ${formatDateTime(report.generatedAt)}`, 196, 290, { align: "right" });
  }
}

function agentStatusLabel(status: CopilotReportSnapshot["agentIntelligence"]["agents"][number]["status"]) {
  return status === "healthy" ? "Actualizado" : status === "attention" ? "Atencion" : status === "running" ? "En curso" : "Sin datos";
}

function reportFilename(report: CopilotReportSnapshot, extension: "pdf" | "xlsx") {
  const name = report.title.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 70);
  return `${name || "informe-crm"}-${new Date().toISOString().slice(0, 10)}.${extension}`;
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function formatDateTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Sin registro" : date.toLocaleString("es-CL", { dateStyle: "medium", timeStyle: "short" });
}

function cleanText(value: string) {
  return value.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
}

function formatCurrency(value: number) {
  return new Intl.NumberFormat("es-CL", {
    style: "currency",
    currency: "CLP",
    maximumFractionDigits: 0,
  }).format(value);
}
