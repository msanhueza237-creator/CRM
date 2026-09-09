import * as XLSX from "npm:xlsx@0.18.5";
import { bankMoney as money, bankIsoDate as isoDate } from "./bank-normalizers.ts";

export type FactoExcelProfile =
  | "facto_unpaid_documents"
  | "facto_checks_banco_estado"
  | "facto_cash"
  | "facto_cash_scotiabank"
  | "facto_cash_mercado_pago";

export type FactoExcelRow = {
  row_number: number;
  kind: "document_balance" | "check" | "payment_event";
  fingerprint: string;
  errors: string[];
  data: Record<string, unknown>;
  raw: Record<string, unknown>;
};

export type FactoExcelPreview = {
  profile: FactoExcelProfile;
  source_type: "COLLECTIONS" | "CHECKS" | "PAYMENTS";
  rows: FactoExcelRow[];
  warnings: string[];
  summary: Record<string, unknown>;
};

export async function parseFactoExcelWorkbook(bytes: Uint8Array, requestedProfile?: string): Promise<FactoExcelPreview> {
  const workbook = XLSX.read(bytes, { type: "array", cellDates: true, raw: false });
  const profile = detectProfile(workbook, requestedProfile);
  const parsed = profile === "facto_unpaid_documents"
    ? parseBalanceSheets(workbook, profile)
    : profile === "facto_checks_banco_estado"
    ? parseChecks(sheetRows(workbook), profile)
    : parseCash(sheetRows(workbook), profile);
  parsed.rows = await Promise.all(parsed.rows.map(async (row) => ({
    ...row,
    // The same payment may appear in the general cash ledger and in a
    // channel-specific export. The business fingerprint must not depend on
    // the workbook profile, otherwise the event would be duplicated.
    fingerprint: await sha256(canonicalFingerprint(row)),
  })));
  return parsed;
}

function detectProfile(workbook: XLSX.WorkBook, requested?: string): FactoExcelProfile {
  const normalized = normalizeText(requested || "");
  if (normalized && normalized !== "auto") {
    const allowed = new Set<FactoExcelProfile>([
      "facto_unpaid_documents",
      "facto_checks_banco_estado",
      "facto_cash",
      "facto_cash_scotiabank",
      "facto_cash_mercado_pago",
    ]);
    if (allowed.has(requested as FactoExcelProfile)) return requested as FactoExcelProfile;
  }
  const rows = workbook.SheetNames.flatMap((name) => sheetRows(workbook, 30, name));
  const header = rows.flat().map(normalizeText).join("|");
  if (header.includes("impago") && header.includes("emisor receptor")) return "facto_unpaid_documents";
  if (header.includes("numero cheque") || (header.includes("fecha cobro") && header.includes("rut emisor"))) return "facto_checks_banco_estado";
  if (header.includes("metodo de pago") && header.includes("valor")) return "facto_cash";
  throw new Error("No se reconoció esta planilla Facto. Selecciona el tipo de respaldo antes de previsualizar.");
}

function parseBalanceSheets(workbook: XLSX.WorkBook, profile: FactoExcelProfile): FactoExcelPreview {
  const results: FactoExcelPreview[] = [];
  let offset = 0;
  for (const name of workbook.SheetNames) {
    const rows = sheetRows(workbook, undefined, name, true);
    if (findHeader(rows, ["tipo documento", "numero", "emisor receptor", "total", "pagado", "impago"]) < 0) {
      if (rows.some((row) => row.some((cell) => documentDirection(String(cell || ""))))) {
        throw new Error(`La hoja ${name} contiene documentos sin un encabezado válido. No se omitirá esa información.`);
      }
      continue;
    }
    const result = parseBalances(rows, profile);
    for (const row of result.rows) {
      row.data.source_sheet = name;
      row.data.source_row = row.row_number;
      row.row_number += offset;
    }
    offset += rows.length;
    results.push(result);
  }
  if (!results.length) throw new Error("No se encontró el encabezado de documentos pendientes Facto.");
  const rows = results.flatMap((result) => result.rows);
  const seen = new Set<string>();
  for (const row of rows) {
    const identity = [row.data.direction, row.data.document_type, row.data.document_number,
      row.data.counterpart_tax_id || normalizeText(row.data.counterpart_name)].join("|");
    if (seen.has(identity)) row.errors.push("Documento repetido en el archivo. Revisa las hojas antes de confirmar.");
    seen.add(identity);
  }
  const summary: Record<string, unknown> = { sheets: results.length };
  for (const result of results) {
    for (const [key, value] of Object.entries(result.summary)) summary[key] = Number(summary[key] || 0) + Number(value || 0);
  }
  return { profile, source_type: "COLLECTIONS", rows, summary, warnings: results[0].warnings };
}

function parseBalances(rows: unknown[][], profile: FactoExcelProfile): FactoExcelPreview {
  const headerIndex = findHeader(rows, ["tipo documento", "numero", "emisor receptor", "total", "pagado", "impago"]);
  if (headerIndex < 0) throw new Error("No se encontró el encabezado de documentos pendientes Facto.");
  let header = rows[headerIndex].map(normalizeText);
  const parsed: FactoExcelRow[] = [];
  for (let index = headerIndex + 1; index < rows.length; index += 1) {
    if (findHeader([rows[index]], ["tipo documento", "numero", "emisor receptor", "total", "pagado", "impago"]) === 0) {
      header = rows[index].map(normalizeText);
      continue;
    }
    const raw = rowObject(header, rows[index]);
    const documentTypeLabel = textAt(raw, "tipo documento");
    const documentNumber = textAt(raw, "numero");
    const issuedOn = isoDate(raw.fecha);
    const total = money(raw.total);
    if (!documentTypeLabel && !documentNumber && total === 0) continue;
    const paid = Math.max(0, money(raw.pagado));
    const reportedBalance = Math.max(0, money(raw.impago));
    const direction = documentDirection(documentTypeLabel);
    const documentType = normalizedDocumentType(documentTypeLabel);
    const balanceKind = openBalanceKind(direction, documentType);
    const errors: string[] = [];
    if (!documentNumber) errors.push("Número de documento faltante.");
    if (!textAt(raw, "emisor receptor")) errors.push("Contraparte faltante.");
    if (direction === "purchase" && !normalizeText(documentTypeLabel).includes("extranjera") && !textAt(raw, "rut")) errors.push("RUT del proveedor faltante.");
    if (["total", "pagado", "impago"].some((key) => !validAmount(raw[key]))) errors.push("Monto faltante o inválido.");
    if (money(raw.pagado) < 0 || money(raw.impago) < 0) errors.push("Pagado e impago no pueden ser negativos.");
    if (!issuedOn) errors.push("Fecha inválida.");
    if (!direction) errors.push("No se reconoció si el documento es emitido o recibido.");
    if (total <= 0 && !normalizeText(documentTypeLabel).includes("nota de credito")) errors.push("Total inválido.");
    if (total > 0 && Math.abs(total - paid - reportedBalance) > 2) errors.push("Pagado más impago no coincide con el total.");
    parsed.push({
      row_number: index + 1,
      kind: "document_balance",
      fingerprint: "",
      errors,
      data: {
        document_type_label: documentTypeLabel,
        document_type: documentType,
        direction,
        balance_kind: balanceKind,
        issued_on: issuedOn,
        document_number: documentNumber,
        counterpart_name: textAt(raw, "emisor receptor"),
        counterpart_tax_id: normalizeTaxId(textAt(raw, "rut")),
        net_clp: money(raw.neto),
        exempt_clp: money(raw.exento),
        tax_clp: money(raw.iva),
        other_taxes_clp: money(raw["otros impuestos"]),
        total_clp: total,
        reported_paid_clp: paid,
        reported_balance_clp: reportedBalance,
        salesperson: textAt(raw, "nombre vendedor"),
        phone: textAt(raw, "telefono"),
        district: textAt(raw, "comuna"),
        city: textAt(raw, "ciudad"),
        source_status: textAt(raw, "estado op documento"),
      },
      raw,
    });
  }
  return {
    profile,
    source_type: "COLLECTIONS",
    rows: parsed,
    warnings: [
      "Los saldos se registran como informados por Facto; la cartola bancaria confirmará los pagos.",
      "Las notas de crédito permanecen como evidencia documental y nunca se convierten en una cuenta por cobrar o pagar positiva.",
    ],
    summary: {
      total_clp: sum(parsed, "total_clp"),
      reported_paid_clp: sum(parsed, "reported_paid_clp"),
      reported_balance_clp: sum(parsed, "reported_balance_clp"),
      receivables_documents: parsed.filter((row) => row.data.balance_kind === "receivable").length,
      receivables_total_clp: parsed.filter((row) => row.data.balance_kind === "receivable").reduce((total, row) => total + Number(row.data.reported_balance_clp || 0), 0),
      payables_documents: parsed.filter((row) => row.data.balance_kind === "payable").length,
      payables_total_clp: parsed.filter((row) => row.data.balance_kind === "payable").reduce((total, row) => total + Number(row.data.reported_balance_clp || 0), 0),
      adjustment_documents: parsed.filter((row) => row.data.balance_kind === "adjustment").length,
    },
  };
}

function parseChecks(rows: unknown[][], profile: FactoExcelProfile): FactoExcelPreview {
  const headerIndex = findHeader(rows, ["nombre titular", "banco", "numero documento", "numero", "fecha cobro", "monto"]);
  if (headerIndex < 0) throw new Error("No se encontró el encabezado del listado de cheques Facto.");
  const header = rows[headerIndex].map(normalizeText);
  const parsed: FactoExcelRow[] = [];
  for (let index = headerIndex + 1; index < rows.length; index += 1) {
    const raw = rowObject(header, rows[index]);
    const checkNumber = textAt(raw, "numero");
    const amount = Math.abs(money(raw.monto));
    if (!checkNumber && amount === 0) continue;
    const receivedOn = isoDate(raw.fecha);
    const dueOn = isoDate(raw["fecha cobro"]);
    const errors: string[] = [];
    if (!checkNumber) errors.push("Número de cheque faltante.");
    if (!receivedOn) errors.push("Fecha de recepción inválida.");
    if (amount <= 0) errors.push("Monto inválido.");
    parsed.push({
      row_number: index + 1,
      kind: "check",
      fingerprint: "",
      errors,
      data: {
        customer_name: textAt(raw, "nombre titular") || textAt(raw, "razon social receptor"),
        customer_tax_id: normalizeTaxId(textAt(raw, "rut receptor")),
        issuer_bank: textAt(raw, "banco") || "Banco no informado",
        settlement_institution: "BancoEstado",
        received_on: receivedOn,
        due_on: dueOn,
        source_status: textAt(raw, "activo inactivo"),
        source_document_number: textAt(raw, "numero documento"),
        check_number: checkNumber,
        amount_clp: amount,
        document_type_label: textAt(raw, "tipo"),
        issuer_name: textAt(raw, "razon social emisor"),
        issuer_tax_id: normalizeTaxId(textAt(raw, "rut emisor")),
        detail: textAt(raw, "detalle"),
      },
      raw,
    });
  }
  return {
    profile,
    source_type: "CHECKS",
    rows: parsed,
    warnings: ["Los cheques quedan pendientes de confirmación contra la futura cartola de BancoEstado."],
    summary: { amount_clp: sum(parsed, "amount_clp"), settlement_institution: "BancoEstado" },
  };
}

function parseCash(rows: unknown[][], profile: FactoExcelProfile): FactoExcelPreview {
  const headerIndex = findHeader(rows, ["fecha", "hora", "tipo documento", "numero documento", "metodo de pago", "valor"]);
  if (headerIndex < 0) throw new Error("No se encontró el encabezado de movimientos de caja Facto.");
  const header = rows[headerIndex].map(normalizeText);
  const parsed: FactoExcelRow[] = [];
  for (let index = headerIndex + 1; index < rows.length; index += 1) {
    const raw = rowObject(header, rows[index]);
    const amountSigned = money(raw.valor);
    const documentTypeLabel = textAt(raw, "tipo documento");
    const documentNumber = textAt(raw, "numero documento");
    const eventDate = isoDate(raw.fecha);
    if (!eventDate && !documentNumber && amountSigned === 0) continue;
    const direction = paymentDirection(documentTypeLabel, amountSigned);
    const errors: string[] = [];
    if (!eventDate) errors.push("Fecha inválida.");
    if (amountSigned === 0) errors.push("Monto igual a cero.");
    const method = textAt(raw, "metodo de pago");
    parsed.push({
      row_number: index + 1,
      kind: "payment_event",
      fingerprint: "",
      errors,
      data: {
        event_date: eventDate,
        event_time: normalizeTime(raw.hora),
        direction,
        document_type_label: documentTypeLabel,
        document_type: normalizedDocumentType(documentTypeLabel),
        document_number: documentNumber,
        payment_method: method,
        responsible: textAt(raw, "encargado"),
        amount_clp: Math.abs(amountSigned),
        signed_amount_clp: amountSigned,
        expected_institution: expectedInstitution(profile, method),
      },
      raw,
    });
  }
  return {
    profile,
    source_type: "PAYMENTS",
    rows: parsed,
    warnings: ["Estos son eventos de pago Facto, no movimientos bancarios. Quedarán pendientes de conciliación con cartolas."],
    summary: {
      receipts_clp: parsed.filter((row) => row.data.direction === "receipt").reduce((total, row) => total + Number(row.data.amount_clp || 0), 0),
      payments_clp: parsed.filter((row) => row.data.direction === "payment").reduce((total, row) => total + Number(row.data.amount_clp || 0), 0),
    },
  };
}

function canonicalFingerprint(row: FactoExcelRow) {
  const data = row.data;
  if (row.kind === "document_balance") return [data.direction, data.document_type, data.document_number, data.counterpart_tax_id, data.total_clp, data.reported_paid_clp, data.reported_balance_clp].join("|");
  if (row.kind === "check") return [data.check_number, data.due_on, data.amount_clp, data.customer_tax_id, normalizeText(data.customer_name)].join("|");
  return [data.event_date, data.event_time, data.direction, data.document_type, data.document_number, data.amount_clp, normalizeText(data.payment_method)].join("|");
}

function expectedInstitution(profile: FactoExcelProfile, method: string) {
  if (profile === "facto_cash_scotiabank") return "Scotiabank";
  if (profile === "facto_cash_mercado_pago" || normalizeText(method).includes("mercado pago") || normalizeText(method).includes("automatico api")) return "Mercado Pago";
  if (normalizeText(method).includes("cheque")) return "BancoEstado";
  return null;
}

function documentDirection(label: string) {
  const value = normalizeText(label);
  if (value.includes("emitida")) return "sale";
  if (value.includes("recibida") || value.includes("extranjera")) return "purchase";
  return null;
}

function paymentDirection(label: string, amount: number) {
  const normalized = normalizeText(label);
  if (normalized.includes("nota de credito") || normalized.includes("nota de debito")) return "adjustment";
  const direction = documentDirection(label);
  if (direction === "sale") return amount < 0 ? "adjustment" : "receipt";
  if (direction === "purchase") return amount < 0 ? "payment" : "payment";
  return amount >= 0 ? "receipt" : "payment";
}

function normalizedDocumentType(label: string) {
  const value = normalizeText(label);
  const direction = value.includes("emitida") ? "sales" : value.includes("recibida") || value.includes("extranjera") ? "purchase" : "other";
  if (value.includes("nota de credito")) return `${direction}_credit_note`;
  if (value.includes("nota de debito")) return `${direction}_debit_note`;
  if (value.includes("boleta") && value.includes("exenta")) return `${direction}_exempt_receipt`;
  if (value.includes("boleta")) return `${direction}_receipt`;
  if (value.includes("factura") && value.includes("exenta")) return `${direction}_exempt_invoice`;
  if (value.includes("factura")) return `${direction}_invoice`;
  return `${direction}_document`;
}

function openBalanceKind(direction: string | null, documentType: string) {
  if (documentType.endsWith("_credit_note")) return "adjustment";
  if (documentType.endsWith("_receipt") || documentType.endsWith("_exempt_receipt")) return "informational";
  if (direction === "sale") return "receivable";
  if (direction === "purchase") return "payable";
  return "informational";
}

function sheetRows(workbook: XLSX.WorkBook, maxRows?: number, sheetName = workbook.SheetNames[0], raw = false): unknown[][] {
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) return [];
  return XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw, range: maxRows ? `A1:ZZ${maxRows}` : undefined }) as unknown[][];
}

function findHeader(rows: unknown[][], required: string[]) {
  return rows.findIndex((row) => {
    const normalized = row.map(normalizeText);
    return required.every((label) => normalized.some((cell) => cell.includes(normalizeText(label))));
  });
}

function rowObject(header: string[], row: unknown[]) {
  return Object.fromEntries(header.map((name, index) => [name || `col_${index + 1}`, row[index]]));
}

function textAt(row: Record<string, unknown>, key: string) {
  return String(row[normalizeText(key)] ?? "").trim();
}

function normalizeText(value: unknown) {
  return String(value ?? "")
    .replace(/n[�\uFFFD]\s*mero/gi, "numero")
    .replace(/raz[�\uFFFD]\s*n/gi, "razon")
    .replace(/m[�\uFFFD]\s*todo/gi, "metodo")
    .replace(/electr[�\uFFFD]\s*nica/gi, "electronica")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizeTaxId(value: string) {
  return value.toUpperCase().replace(/[^0-9K]/g, "");
}

function validAmount(value: unknown) {
  if (typeof value === "number") return Number.isFinite(value);
  return /^-?(?:\d{1,3}(?:[.,]\d{3})+|\d+)(?:[.,]\d{1,2})?$/.test(String(value ?? "").replace(/CLP|\$|\s/gi, ""));
}

function normalizeTime(value: unknown) {
  const text = String(value ?? "").trim();
  const match = text.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  return match ? `${match[1].padStart(2, "0")}:${match[2]}:${match[3] || "00"}` : null;
}

function sum(rows: FactoExcelRow[], field: string) {
  return rows.reduce((total, row) => total + Number(row.data[field] || 0), 0);
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
