export type BankStatementDateRange = {
  from: string;
  to: string;
  defaultYear: number | null;
};

export function bancoEstadoStatementRange(rows: unknown[][]): BankStatementDateRange {
  let from = "";
  let to = "";

  for (const row of rows) {
    const label = normalizeLabel(row[0]);
    const value = row.slice(1).find((cell) => String(cell || "").trim()) || "";
    if (label.includes("fecha inicio")) from = bankIsoDate(value);
    if (label.includes("fecha final")) to = bankIsoDate(value);
  }

  const defaultYear = Number((to || from).slice(0, 4));
  return { from, to, defaultYear: Number.isInteger(defaultYear) && defaultYear > 1900 ? defaultYear : null };
}

export function bankMoney(value: unknown) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;

  const original = String(value || "").trim();
  const negative = original.includes("-") || /^\(.*\)$/.test(original);
  let text = original.replace(/[^\d,.]/g, "");
  if (!text) return 0;

  const commaCount = (text.match(/,/g) || []).length;
  const dotCount = (text.match(/\./g) || []).length;
  const lastComma = text.lastIndexOf(",");
  const lastDot = text.lastIndexOf(".");
  const lastSeparator = Math.max(lastComma, lastDot);
  const decimals = lastSeparator >= 0 ? text.length - lastSeparator - 1 : 0;

  if (commaCount && dotCount) {
    const decimalSeparator = lastComma > lastDot ? "," : ".";
    const thousandsSeparator = decimalSeparator === "," ? "." : ",";
    text = text.split(thousandsSeparator).join("");
    text = decimals <= 2 ? text.replace(decimalSeparator, ".") : text.split(decimalSeparator).join("");
  } else if (commaCount || dotCount) {
    const separator = commaCount ? "," : ".";
    const count = commaCount || dotCount;
    if (count > 1 || decimals === 3) text = text.split(separator).join("");
    else text = text.replace(separator, ".");
  }

  const number = Number(text);
  if (!Number.isFinite(number)) return 0;
  return negative ? -Math.abs(number) : number;
}

export function bankIsoDate(value: unknown, range?: BankStatementDateRange) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  const text = String(value || "").trim();
  if (!text) return "";

  const complete = text.match(/^(\d{1,4})[\/-](\d{1,2})[\/-](\d{1,4})/);
  if (complete) {
    const yearFirst = complete[1].length === 4;
    const year = Number(yearFirst ? complete[1] : complete[3]);
    const month = Number(complete[2]);
    const day = Number(yearFirst ? complete[3] : complete[1]);
    return validDate(year, month, day) ? formatDate(year, month, day) : "";
  }

  const partial = text.match(/^(\d{1,2})[\/-](\d{1,2})$/);
  if (partial && range?.defaultYear) {
    const day = Number(partial[1]);
    const month = Number(partial[2]);
    const fromYear = Number(range.from.slice(0, 4)) || range.defaultYear;
    const toYear = Number(range.to.slice(0, 4)) || range.defaultYear;
    const firstYear = Math.min(fromYear, toYear);
    const lastYear = Math.max(fromYear, toYear);

    for (let year = firstYear; year <= lastYear; year += 1) {
      if (!validDate(year, month, day)) continue;
      const candidate = formatDate(year, month, day);
      if ((!range.from || candidate >= range.from) && (!range.to || candidate <= range.to)) return candidate;
    }

    return validDate(range.defaultYear, month, day) ? formatDate(range.defaultYear, month, day) : "";
  }

  return "";
}

function validDate(year: number, month: number, day: number) {
  if (!Number.isInteger(year) || year <= 1900 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function formatDate(year: number, month: number, day: number) {
  return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
}

function normalizeLabel(value: unknown) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
