import { CopilotDataError, type Row } from "./contracts.ts";

export function todayChile(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Santiago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
function iso(date: Date) {
  return date.toISOString().slice(0, 10);
}
export function dateRange(
  args: Row,
  now = new Date(),
): { from: string; to: string } {
  const today = todayChile(now);
  const [year, month, day] = today.split("-").map(Number);
  let from = today,
    to = today;
  const period = String(args.period || "this_month");
  if (period === "this_month") from = `${today.slice(0, 7)}-01`;
  else if (period === "last_month") {
    from = iso(new Date(Date.UTC(year, month - 2, 1)));
    to = iso(new Date(Date.UTC(year, month - 1, 0)));
  } else if (period === "this_year") from = `${year}-01-01`;
  else if (period === "this_week" || period === "last_week") {
    const date = new Date(Date.UTC(year, month - 1, day));
    const mondayOffset = (date.getUTCDay() + 6) % 7;
    from = iso(
      new Date(
        Date.UTC(
          year,
          month - 1,
          day - mondayOffset - (period === "last_week" ? 7 : 0),
        ),
      ),
    );
    if (period === "last_week")
      to = iso(new Date(Date.UTC(year, month - 1, day - mondayOffset - 1)));
  } else if (period === "custom") {
    from = String(args.from || "");
    to = String(args.to || "");
  } else if (period !== "today" && period !== "all")
    throw new CopilotDataError("Periodo no reconocido.", "INVALID_ARGUMENTS");
  if (period === "all") from = "2000-01-01";
  for (const date of [from, to]) {
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(Date.parse(date)) ||
      iso(new Date(date)) !== date
    )
      throw new CopilotDataError("Fecha invalida.", "INVALID_ARGUMENTS");
  }
  if (from > to)
    throw new CopilotDataError(
      "La fecha inicial debe ser anterior al termino.",
      "INVALID_ARGUMENTS",
    );
  return { from, to };
}
export function localDate(value: unknown): string | null {
  const text = String(value || "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? todayChile(new Date(timestamp)) : null;
}
export function inRange(value: unknown, range: { from: string; to: string }) {
  const date = localDate(value);
  return Boolean(date && date >= range.from && date <= range.to);
}
