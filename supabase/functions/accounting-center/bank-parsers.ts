import * as XLSX from "npm:xlsx@0.18.5";
import {
  bancoEstadoStatementRange,
  bankIsoDate,
  bankMoney,
  type BankStatementDateRange,
} from "./bank-normalizers.ts";

export type NormalizedBankRow = {
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

export type BankPreview = {
  profile: "scotiabank" | "banco_estado" | "mercado_pago";
  currency: string;
  account_hint: string;
  rows: NormalizedBankRow[];
  warnings: string[];
};

export async function parseBankWorkbook(bytes: Uint8Array, requestedProfile?: string): Promise<BankPreview> {
  const workbook = XLSX.read(bytes, { type: "array", cellDates: true, raw: false });
  const profile = detectProfile(workbook, requestedProfile);
  const result = profile === "scotiabank"
    ? parseScotiabank(workbook)
    : profile === "banco_estado"
    ? parseBancoEstado(workbook)
    : parseMercadoPago(workbook);
  result.rows = await Promise.all(result.rows.map(async (row) => ({
    ...row,
    fingerprint: await sha256([
      result.profile,
      result.account_hint,
      row.transaction_date,
      row.operation_number || "",
      row.reference || "",
      row.amount.toFixed(4),
      normalizeText(row.description),
    ].join("|")),
  })));
  return result;
}

function detectProfile(workbook: XLSX.WorkBook, requested?: string): BankPreview["profile"] {
  const normalized = normalizeText(requested || "");
  if (normalized.includes("scotia")) return "scotiabank";
  if (normalized.includes("estado")) return "banco_estado";
  if (normalized.includes("mercado")) return "mercado_pago";

  const names = workbook.SheetNames.map(normalizeText).join(" ");
  if (names.includes("movimientos") && names.includes("resumen")) return "banco_estado";
  const first = sheetRows(workbook, workbook.SheetNames[0], 30).flat().map(normalizeText).join(" ");
  if (first.includes("release date") || first.includes("transaction net amount")) return "mercado_pago";
  if (first.includes("cartola") || first.includes("n doc") || first.includes("cargos abonos saldo")) return "scotiabank";
  throw new Error("No se reconoció el formato. Selecciona Scotiabank, BancoEstado o Mercado Pago.");
}

function parseBancoEstado(workbook: XLSX.WorkBook): BankPreview {
  const rows = sheetRows(workbook, findSheet(workbook, "movimientos"));
  const statementRange = bancoEstadoStatementRange(sheetRows(workbook, findSheet(workbook, "resumen")));
  const headerIndex = findHeader(rows, ["fecha", "descripcion", "cheques cargos", "depositos abonos"]);
  if (headerIndex < 0) throw new Error("No se encontró el encabezado de movimientos de BancoEstado.");
  const header = rows[headerIndex].map(normalizeText);
  const accountColumn = columnIndex(header, "n cuenta");
  const accountHint = String(rows[headerIndex + 1]?.[accountColumn] || "BancoEstado").trim();
  return {
    profile: "banco_estado",
    currency: "CLP",
    account_hint: accountHint,
    warnings: [],
    rows: parseRows(rows, headerIndex, {
      date: columnIndex(header, "fecha"),
      description: columnIndex(header, "descripcion"),
      operation: columnIndex(header, "n operacion"),
      debit: columnIndex(header, "cheques cargos"),
      credit: columnIndex(header, "depositos abonos"),
      balance: columnIndex(header, "saldo"),
    }, "CLP", statementRange),
  };
}

function parseScotiabank(workbook: XLSX.WorkBook): BankPreview {
  const rows = sheetRows(workbook, findSheet(workbook, "data"));
  const headerIndex = findHeader(rows, ["fecha", "descripcion", "cargo", "abono", "saldo"]);
  if (headerIndex < 0) throw new Error("No se encontró el encabezado de movimientos de Scotiabank.");
  const header = rows[headerIndex].map(normalizeText);
  const preamble = rows.slice(0, headerIndex).flat().map((value) => String(value || "")).join(" ");
  const currency = /\bUSD\b|DOLAR/i.test(preamble) ? "USD" : "CLP";
  const accountMatch = preamble.match(/(?:cuenta|account)\D{0,15}([\d-]{5,})/i);
  return {
    profile: "scotiabank",
    currency,
    account_hint: accountMatch?.[1] || `Scotiabank ${currency}`,
    warnings: [],
    rows: parseRows(rows, headerIndex, {
      date: columnIndex(header, "fecha"),
      description: columnIndex(header, "descripcion"),
      operation: columnIndexAny(header, ["n doc", "numero documento", "documento"]),
      debit: columnIndex(header, "cargo"),
      credit: columnIndex(header, "abono"),
      balance: columnIndex(header, "saldo"),
    }, currency),
  };
}

function parseMercadoPago(workbook: XLSX.WorkBook): BankPreview {
  const rows = sheetRows(workbook, workbook.SheetNames[0]);
  const headerIndex = findHeader(rows, ["release date", "movement type", "transaction id", "transaction net amount"]);
  if (headerIndex < 0) throw new Error("No se encontró el encabezado de movimientos de Mercado Pago.");
  const header = rows[headerIndex].map(normalizeText);
  const dateColumn = columnIndex(header, "release date");
  const descriptionColumn = columnIndex(header, "transaction type");
  const movementColumn = columnIndex(header, "movement type");
  const operationColumn = columnIndex(header, "transaction id");
  const amountColumn = columnIndex(header, "transaction net amount");
  const currencyColumn = columnIndex(header, "currency description");
  const feeColumn = columnIndex(header, "mp processing fee");
  const storeColumn = columnIndex(header, "store name");
  const parsed: NormalizedBankRow[] = [];
  for (let index = headerIndex + 1; index < rows.length; index += 1) {
    const source = rows[index];
    const amount = bankMoney(source[amountColumn]);
    const date = bankIsoDate(source[dateColumn]);
    if (!date || !Number.isFinite(amount) || amount === 0) continue;
    const movement = String(source[movementColumn] || "Movimiento").trim();
    const transaction = String(source[descriptionColumn] || "").trim();
    const store = String(source[storeColumn] || "").trim();
    const currency = String(source[currencyColumn] || "CLP").trim().toUpperCase().slice(0, 3);
    parsed.push({
      row_number: index + 1,
      transaction_date: date,
      value_date: null,
      description: [movement, transaction, store].filter(Boolean).join(" - "),
      reference: feeColumn >= 0 ? `Comisión: ${bankMoney(source[feeColumn])}` : null,
      operation_number: String(source[operationColumn] || "").trim() || null,
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
  return { profile: "mercado_pago", currency: "CLP", account_hint: "Mercado Pago", rows: parsed, warnings: [] };
}

function parseRows(
  rows: unknown[][],
  headerIndex: number,
  columns: { date: number; description: number; operation: number; debit: number; credit: number; balance: number },
  currency: string,
  dateRange?: BankStatementDateRange,
) {
  const parsed: NormalizedBankRow[] = [];
  const header = rows[headerIndex].map(normalizeText);
  for (let index = headerIndex + 1; index < rows.length; index += 1) {
    const source = rows[index];
    const date = bankIsoDate(source[columns.date], dateRange);
    const debit = Math.abs(bankMoney(source[columns.debit]));
    const credit = Math.abs(bankMoney(source[columns.credit]));
    const description = String(source[columns.description] || "").trim();
    if (!date || !description || (debit === 0 && credit === 0)) continue;
    const errors: string[] = [];
    if (debit > 0 && credit > 0) errors.push("La fila contiene cargo y abono simultáneamente.");
    parsed.push({
      row_number: index + 1,
      transaction_date: date,
      value_date: null,
      description,
      reference: null,
      operation_number: String(source[columns.operation] || "").trim() || null,
      debit,
      credit,
      amount: credit - debit,
      balance: columns.balance >= 0 ? nullableMoney(source[columns.balance]) : null,
      currency,
      fingerprint: "",
      raw: rowObject(header, source),
      errors,
    });
  }
  return parsed;
}

function sheetRows(workbook: XLSX.WorkBook, sheetName: string, maxRows?: number): unknown[][] {
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) return [];
  return XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: false, range: maxRows ? `A1:ZZ${maxRows}` : undefined }) as unknown[][];
}

function findSheet(workbook: XLSX.WorkBook, expected: string) {
  return workbook.SheetNames.find((name) => normalizeText(name).includes(normalizeText(expected))) || workbook.SheetNames[0];
}

function findHeader(rows: unknown[][], required: string[]) {
  return rows.findIndex((row) => {
    const normalized = row.map(normalizeText);
    return required.every((label) => normalized.some((cell) => cell.includes(normalizeText(label))));
  });
}

function columnIndex(header: string[], label: string) {
  return header.findIndex((cell) => cell.includes(normalizeText(label)));
}

function columnIndexAny(header: string[], labels: string[]) {
  for (const label of labels) {
    const index = columnIndex(header, label);
    if (index >= 0) return index;
  }
  return -1;
}

function rowObject(header: string[], row: unknown[]) {
  return Object.fromEntries(header.map((name, index) => [name || `col_${index + 1}`, row[index]]));
}

function normalizeText(value: unknown) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function nullableMoney(value: unknown) {
  const text = String(value || "").trim();
  return text ? bankMoney(value) : null;
}

async function sha256(text: string) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
