import type { dashboardSalesEvidence } from "./dashboard-sales.ts";

type Sale = ReturnType<typeof dashboardSalesEvidence>[number];
const labels = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
const date = (year: number, month: number, day: number) => `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
const lastDay = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

export function previousSalesCutoff(asOf: string) {
  const [year, month, day] = asOf.split("-").map(Number);
  // A completed February compares with the entire prior February, including leap days.
  return date(year - 1, month, day === lastDay(year, month) ? lastDay(year - 1, month) : Math.min(day, lastDay(year - 1, month)));
}

export function dashboardSalesComparison(sales: Sale[], asOf: string) {
  const [year, month, day] = asOf.split("-").map(Number);
  const previousYear = year - 1;
  const previousTo = previousSalesCutoff(asOf);
  const summarize = (from: string, to: string) => {
    const documents = sales.filter(sale => sale.issuedOn >= from && sale.issuedOn <= to);
    return { from, to, netClp: documents.length ? documents.reduce((sum, sale) => sum + sale.netClp, 0) : null,
      documents: documents.length, creditNotes: documents.filter(sale => sale.creditNote).length };
  };
  const compare = (current: number | null, previous: number | null) => ({
    difference: current === null || previous === null ? null : current - previous,
    growth: current === null || previous === null || previous <= 0 ? null : (current - previous) / previous * 100,
  });
  const current = summarize(date(year, 1, 1), asOf);
  const previous = summarize(date(previousYear, 1, 1), previousTo);
  return {
    basis: "documentary_issue_date" as const, year, previousYear, asOf,
    current, previous, previousAnnual: summarize(date(previousYear, 1, 1), date(previousYear, 12, 31)),
    ...compare(current.netClp, previous.netClp),
    monthly: labels.map((label, index) => {
      const number = index + 1;
      const elapsed = number <= month;
      const partial = number === month && day < lastDay(year, month);
      const currentPeriod = elapsed ? summarize(date(year, number, 1), number === month ? asOf : date(year, number, lastDay(year, number))) : null;
      const previousFull = summarize(date(previousYear, number, 1), date(previousYear, number, lastDay(previousYear, number)));
      const previousPeriod = partial ? summarize(previousFull.from, previousTo) : previousFull;
      return { label, period: date(year, number, 1).slice(0, 7), elapsed, partial,
        current: currentPeriod, previous: previousPeriod, previousFull,
        ...compare(currentPeriod?.netClp ?? null, previousPeriod.netClp) };
    }),
  };
}
