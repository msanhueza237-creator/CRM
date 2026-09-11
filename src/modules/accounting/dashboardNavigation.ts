import type { AccountingDashboardAnalytics } from "../../types/accounting";

export const dashboardMetrics = {
  "sales-pending": "Ventas sin asiento de ingreso",
  "cost-missing": "Ventas sin costo confirmado",
  "cost-confirmed": "Ventas con costo confirmado",
  "sales-issued": "Ventas emitidas",
  "sales-issued-credit": "Notas de credito emitidas",
  "sales-period-net": "Ventas netas por fecha de emision",
  "sales-credit": "Notas de credito en resultado",
  "prior-credit": "Notas de credito de otros periodos",
  "sales-adjustments": "Otras regularizaciones de ventas",
  "sales-ledger": "Ventas contabilizadas",
  "sales-result": "Ventas netas en resultado",
  costs: "Costo de ventas",
  expenses: "Gastos operacionales",
  "gross-profit": "Margen bruto",
  "operating-profit": "Resultado operativo",
  purchases: "Compras netas",
  domestic: "Compras nacionales",
  international: "Compras internacionales",
  "purchase-credit": "Notas de credito de compra",
} as const;
export type DashboardMetric = keyof typeof dashboardMetrics;
export function dashboardDetailLink(metric: DashboardMetric, from?: string, to?: string) {
  const params = new URLSearchParams({ view: "detail", metric });
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  return `/finanzas-contabilidad?${params}`;
}
export function exactDocumentLink(id: string, issuedOn?: string) {
  const params = new URLSearchParams({ view: "facto", document: id });
  if (issuedOn) { params.set("from", issuedOn); params.set("to", issuedOn); }
  return `/finanzas-contabilidad?${params}`;
}
export type DetailRow = { key: string; sourceId?: string; date: string; issuedOn?: string; label: string; counterpart: string; status: string; amount: number };

// Membership comes from the same ledger/document evidence as the dashboard,
// never from a text search or the presence of an unrelated payment/cost entry.
export function dashboardDetailRows(analytics: AccountingDashboardAnalytics, metric: DashboardMetric, from: string, to: string): DetailRow[] | null {
  const detail = analytics.detail;
  if (!detail || from > to) return null;
  if (!detail.ledgerAvailable && ["sales-pending", "cost-missing", "cost-confirmed", "sales-credit", "prior-credit"].includes(metric)) return null;
  const inPeriod = (date: string) => Boolean(date) && date >= from && date <= to;
  const issued = detail.sales.filter(row => inPeriod(row.issuedOn));
  const documentRow = (row: typeof detail.sales[number], recognized = false): DetailRow => ({
    key: `source:${row.id}`, sourceId: row.id, date: recognized ? row.recognizedOn : row.issuedOn, issuedOn: row.issuedOn,
    label: `${row.creditNote ? "Nota de credito" : "Documento"} ${row.folio}`, counterpart: row.counterpart,
    status: row.posted ? "Contabilizado" : "Sin asiento de ingreso", amount: row.netClp,
  });
  const ledger = (types: string[]) => detail.ledger.filter(row => inPeriod(row.date) && types.includes(row.accountType)).map(row => ({
    key: `line:${row.id}`, sourceId: row.sourceId || undefined, date: row.date, issuedOn: row.issuedOn || undefined,
    label: `Asiento ${row.entryNumber} · ${row.accountCode} ${row.accountName}`, counterpart: row.description,
    status: row.status === "reversed" ? "Reversado" : "Contabilizado", amount: ["income", "result"].includes(row.accountType) ? row.credit - row.debit : row.debit - row.credit,
  }));
  const pending = issued.filter(row => !row.posted).map(row => documentRow(row));
  if (metric === "sales-pending") return pending;
  if (metric === "cost-missing" || metric === "cost-confirmed") return issued.filter(row => !row.creditNote && row.exactCost === (metric === "cost-confirmed")).map(row => ({ ...documentRow(row), status: row.exactCost ? "Costo confirmado" : "Costo pendiente" }));
  if (metric === "sales-issued") return issued.filter(row => !row.creditNote).map(row => documentRow(row));
  if (metric === "sales-issued-credit") return issued.filter(row => row.creditNote).map(row => documentRow(row));
  if (metric === "sales-period-net") return issued.map(row => documentRow(row));
  if (metric === "sales-credit" || metric === "prior-credit") return detail.sales.filter(row => row.creditNote && inPeriod(row.recognizedOn)
    && (metric !== "prior-credit" || (row.posted && !inPeriod(row.issuedOn)))).map(row => documentRow(row, true));
  if (["purchases", "domestic", "international", "purchase-credit"].includes(metric)) return (analytics.purchaseDocuments || []).filter(row => inPeriod(row.issuedOn)
    && (metric === "purchases" || metric === row.kind || (metric === "purchase-credit" && row.netClp < 0))).map(row => ({
      key: `source:${row.id}`, sourceId: row.id, date: row.issuedOn, issuedOn: row.issuedOn,
      label: `Documento ${row.folio}`, counterpart: row.counterpart, status: row.kind === "international" ? "Internacional" : "Nacional", amount: row.netClp,
    }));
  if (!detail.ledgerAvailable) return null;
  if (metric === "sales-ledger") return ledger(["income"]);
  if (metric === "costs") return ledger(["cost"]);
  if (metric === "expenses") return ledger(["expense"]);
  const sales = [...ledger(["income"]), ...pending];
  if (metric === "sales-result") return sales;
  if (metric === "gross-profit" || metric === "operating-profit") return [...sales, ...ledger(metric === "gross-profit" ? ["cost"] : ["cost", "expense"]).map(row => ({ ...row, amount: -row.amount })), ...(metric === "operating-profit" ? ledger(["result"]) : [])];
  if (metric === "sales-adjustments") return [...sales, ...issued.map(row => ({ ...documentRow(row), key: `deduct:${row.id}`, label: `Descuento de emision · ${row.folio}`, amount: -row.netClp })),
    ...detail.sales.filter(row => row.creditNote && row.posted && inPeriod(row.recognizedOn) && !inPeriod(row.issuedOn)).map(row => ({ ...documentRow(row, true), key: `prior:${row.id}`, label: `Descuento de ajuste previo · ${row.folio}`, amount: -row.netClp }))];
  return [];
}
