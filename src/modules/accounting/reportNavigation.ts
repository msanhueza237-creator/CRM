export function reportPeriod(params: URLSearchParams, defaultFrom: string, defaultTo: string) {
  const from = params.get("from") || "", to = params.get("to") || "";
  const valid = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  return valid(from) && valid(to) && from <= to ? { from, to } : { from: defaultFrom, to: defaultTo };
}

export function incomeReportLink(from?: string, to?: string) {
  const params = new URLSearchParams({ view: "reports", report: "income" });
  if (from && to) { params.set("from", from); params.set("to", to); }
  return `/finanzas-contabilidad?${params}`;
}
