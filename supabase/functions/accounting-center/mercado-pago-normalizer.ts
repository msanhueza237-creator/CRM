import { bankIsoDate, bankMoney } from "./bank-normalizers.ts";

export type MercadoPagoBankRow = {
  row_number: number;
  transaction_date: string;
  value_date: string | null;
  description: string;
  reference: string | null;
  operation_number: string | null;
  debit: number;
  credit: number;
  amount: number;
  balance: number | null;
  currency: string;
  fingerprint: string;
  raw: Record<string, unknown>;
  errors: string[];
};

export type MercadoPagoSheet = {
  name: string;
  rows: unknown[][];
};

export type MercadoPagoParseResult = {
  currency: string;
  rows: MercadoPagoBankRow[];
  warnings: string[];
};

const HEADER_ALIASES = {
  date: ["release date", "fecha de pago", "fecha de liberacion"],
  description: ["transaction type", "movement type", "tipo de operacion", "tipo de movimiento"],
  operation: ["transaction id", "numero de movimiento", "id de transaccion", "numero de operacion"],
  related: ["source id", "related operation", "operacion relacionada"],
  amount: ["transaction net amount", "importe neto", "monto neto", "importe"],
  currency: ["currency description", "moneda"],
  fee: ["mp processing fee", "comision mercado pago", "comision"],
  store: ["store name", "nombre de tienda", "tienda"],
} as const;

export function looksLikeMercadoPagoExport(values: unknown[]) {
  const sample = values.map(normalizeText).filter(Boolean);
  return hasAlias(sample, HEADER_ALIASES.date)
    && hasAlias(sample, HEADER_ALIASES.description)
    && hasAlias(sample, HEADER_ALIASES.operation)
    && hasAlias(sample, HEADER_ALIASES.amount);
}

export function parseMercadoPagoSheets(sheets: MercadoPagoSheet[]): MercadoPagoParseResult {
  for (const sheet of orderedSheets(sheets)) {
    const headerIndex = findHeaderIndex(sheet.rows);
    if (headerIndex < 0) continue;

    const header = sheet.rows[headerIndex].map(normalizeText);
    const columns = {
      date: columnIndexAny(header, HEADER_ALIASES.date),
      description: columnIndexAny(header, ["transaction type", "tipo de operacion"]),
      movement: columnIndexAny(header, ["movement type", "tipo de movimiento"]),
      operation: columnIndexAny(header, HEADER_ALIASES.operation),
      related: columnIndexAny(header, HEADER_ALIASES.related),
      amount: columnIndexAny(header, HEADER_ALIASES.amount),
      currency: columnIndexAny(header, HEADER_ALIASES.currency),
      fee: columnIndexAny(header, HEADER_ALIASES.fee),
      store: columnIndexAny(header, HEADER_ALIASES.store),
    };
    const parsed: MercadoPagoBankRow[] = [];

    for (let index = headerIndex + 1; index < sheet.rows.length; index += 1) {
      const source = sheet.rows[index];
      const amount = bankMoney(source[columns.amount]);
      const date = bankIsoDate(source[columns.date]);
      if (!date || !Number.isFinite(amount) || amount === 0) continue;

      const transaction = cellText(source, columns.description);
      const movement = cellText(source, columns.movement);
      const store = cellText(source, columns.store);
      const related = cellText(source, columns.related);
      const fee = columns.fee >= 0 ? bankMoney(source[columns.fee]) : 0;
      const currency = mercadoPagoCurrency(cellText(source, columns.currency));

      parsed.push({
        row_number: index + 1,
        transaction_date: date,
        value_date: null,
        description: uniqueParts([movement, transaction, store]).join(" - ") || "Movimiento Mercado Pago",
        reference: related || (columns.fee >= 0 ? `Comisión: ${fee}` : null),
        operation_number: cellText(source, columns.operation) || null,
        debit: amount < 0 ? Math.abs(amount) : 0,
        credit: amount > 0 ? amount : 0,
        amount,
        balance: null,
        currency,
        fingerprint: "",
        raw: rowObject(header, source),
        errors: [],
      });
    }

    const currencies = [...new Set(parsed.map((row) => row.currency))];
    const currency = currencies.length === 1 ? currencies[0] : "CLP";
    const warnings = currencies.length > 1
      ? ["La cartola contiene más de una moneda. Revisa los movimientos antes de confirmar."]
      : [];
    return { currency, rows: parsed, warnings };
  }

  throw new Error("No se encontró el encabezado de movimientos de Mercado Pago. Se admiten las exportaciones en español e inglés.");
}

function orderedSheets(sheets: MercadoPagoSheet[]) {
  const preferred = sheets.filter((sheet) => /movimientos|registros|release|sheet|data/i.test(normalizeText(sheet.name)));
  return [...preferred, ...sheets.filter((sheet) => !preferred.includes(sheet))];
}

function findHeaderIndex(rows: unknown[][]) {
  return rows.findIndex((row) => {
    const normalized = row.map(normalizeText);
    return hasAlias(normalized, HEADER_ALIASES.date)
      && hasAlias(normalized, HEADER_ALIASES.description)
      && hasAlias(normalized, HEADER_ALIASES.operation)
      && hasAlias(normalized, HEADER_ALIASES.amount);
  });
}

function hasAlias(values: string[], aliases: readonly string[]) {
  return aliases.some((alias) => values.some((value) => value.includes(normalizeText(alias))));
}

function columnIndexAny(header: string[], aliases: readonly string[]) {
  for (const alias of aliases) {
    const expected = normalizeText(alias);
    const index = header.findIndex((cell) => cell.includes(expected));
    if (index >= 0) return index;
  }
  return -1;
}

function cellText(row: unknown[], index: number) {
  return index >= 0 ? String(row[index] || "").trim() : "";
}

function mercadoPagoCurrency(value: string) {
  const normalized = normalizeText(value);
  if (normalized.includes("usd") || normalized.includes("dolar")) return "USD";
  return "CLP";
}

function uniqueParts(values: string[]) {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = normalizeText(value);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function rowObject(header: string[], row: unknown[]) {
  return Object.fromEntries(header.map((name, index) => [name || `col_${index + 1}`, row[index]]));
}

function normalizeText(value: unknown) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
