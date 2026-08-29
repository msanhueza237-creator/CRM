import { getSupabaseFunctionUrl, isSupabaseConfigured, supabase } from "./supabase";
import type {
  AccountingBootstrap,
  AccountingFactoSyncResult,
  AccountingFactoExcelPreview,
  AccountingFactoExcelProfile,
  AccountingFactoExcelResult,
  AccountingImportPreview,
  AccountingJournalDraft,
  AccountingExactReconciliationPreview,
  AccountingLedgerCoverage,
  AccountingLedgerPrepareResult,
  AccountingReport,
} from "../types/accounting";
import { normalizeAccountingReconciliationProposal } from "../modules/accounting/reconciliationCompatibility";

type RequestOptions = { method?: "GET" | "POST"; body?: unknown };

async function accountingRequest<T>(route: string, options: RequestOptions = {}): Promise<T> {
  if (!isSupabaseConfigured || !supabase) throw new Error("Conecta Supabase para usar Finanzas y Contabilidad.");
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Tu sesión expiró. Vuelve a iniciar sesión.");
  let response: Response;
  try {
    response = await fetch(getSupabaseFunctionUrl("accounting-center", route), {
      method: options.method || "GET",
      cache: "no-store",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch {
    throw new Error("No se pudo contactar el servicio financiero.");
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(String(result.error || `El servicio respondió con error ${response.status}.`));
  return result as T;
}

export function getAccountingBootstrap() {
  return accountingRequest<AccountingBootstrap>("bootstrap");
}

export function syncAccountingFacto(input: { fromDate: string; toDate: string }) {
  return accountingRequest<AccountingFactoSyncResult>("facto/sync", { method: "POST", body: input });
}

export function previewAccountingFactoExcel(input: {
  entityId: string;
  profile: AccountingFactoExcelProfile;
  storagePath: string;
  fileName: string;
}) {
  return accountingRequest<AccountingFactoExcelPreview>("facto-excel/preview", { method: "POST", body: input });
}

export function confirmAccountingFactoExcel(batchId: string) {
  return accountingRequest<AccountingFactoExcelResult>("facto-excel/confirm", { method: "POST", body: { batchId } });
}

export async function downloadAccountingEvidence(storagePath: string, fileName: string) {
  if (!isSupabaseConfigured || !supabase) throw new Error("Conecta Supabase para descargar respaldos.");
  const { data, error } = await supabase.storage.from("accounting-evidence").download(storagePath);
  if (error || !data) throw new Error(`No se pudo descargar el respaldo: ${error?.message || "archivo no disponible"}`);
  downloadBlob(data, fileName);
}

export function syncAccountingForeignTrade() {
  return accountingRequest<{ operations: number; costs: number; inconsistent: number; posted: number; policy: string }>("foreign-trade/sync", {
    method: "POST",
    body: {},
  });
}

export function createAccountingAccount(input: {
  entityId: string;
  code: string;
  name: string;
  parentId?: string;
  accountType: "asset" | "liability" | "equity" | "income" | "cost" | "expense" | "result";
  classification: string;
  currency?: string;
  allowsPosting: boolean;
}) {
  return accountingRequest<{ id: string }>("accounts/create", { method: "POST", body: input });
}

export async function uploadAccountingEvidence(entityId: string, file: File) {
  if (!isSupabaseConfigured || !supabase) throw new Error("Conecta Supabase para cargar archivos.");
  const safeName = file.name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9._-]+/g, "-").slice(-160);
  const path = `${entityId}/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}-${safeName}`;
  const { error } = await supabase.storage.from("accounting-evidence").upload(path, file, {
    contentType: file.type || "application/octet-stream",
    upsert: false,
  });
  if (error) throw new Error(`No se pudo guardar la evidencia: ${error.message}`);
  return path;
}

export function previewAccountingImport(input: { entityId: string; profile: "auto" | "scotiabank" | "banco_estado" | "mercado_pago"; storagePath: string; fileName: string }) {
  return accountingRequest<AccountingImportPreview>("imports/preview", { method: "POST", body: input });
}

export function confirmAccountingImport(batchId: string, exchangeRate?: number) {
  return accountingRequest<{ imported: number; existing?: boolean }>("imports/confirm", { method: "POST", body: { batchId, exchangeRate } });
}

export async function proposeAccountingReconciliation(transactionId: string) {
  const result = await accountingRequest<unknown>("reconciliation/propose", {
    method: "POST",
    body: { transactionId },
  });
  return normalizeAccountingReconciliationProposal(result);
}

export function confirmAccountingReconciliation(input: { transactionId: string; links: Array<{ targetType: string; targetId: string; amount: number }>; note?: string }) {
  return accountingRequest<{ matched: number; allocated: number; remaining: number }>("reconciliation/confirm", { method: "POST", body: input });
}

export function previewExactAccountingReconciliations(input: { entityId: string; from: string; to: string }) {
  return accountingRequest<AccountingExactReconciliationPreview>("reconciliation/exact-preview", { method: "POST", body: input });
}

export function confirmExactAccountingReconciliations(input: AccountingExactReconciliationPreview) {
  return accountingRequest<{ confirmed: number; skipped: number; errors: Array<{ transactionId: string; error: string }> }>("reconciliation/exact-confirm", {
    method: "POST",
    body: { entityId: input.entityId, matches: input.matches },
  });
}

export function getAccountingLedgerCoverage(input: { entityId: string; from: string; to: string }) {
  return accountingRequest<AccountingLedgerCoverage>("ledger/coverage", { method: "POST", body: input });
}

export function prepareAccountingLedger(input: { entityId: string; from: string; to: string; batchSize?: number }) {
  return accountingRequest<AccountingLedgerPrepareResult>("ledger/prepare", { method: "POST", body: input });
}

export function createAccountingCheck(input: {
  entityId: string;
  receivableId?: string;
  customerName: string;
  bankName: string;
  checkNumber: string;
  amountClp: number;
  receivedOn: string;
  dueOn?: string;
  notes?: string;
}) {
  return accountingRequest<{ id: string }>("checks/create", { method: "POST", body: input });
}

export function createAccountingEntry(input: AccountingJournalDraft) {
  return accountingRequest<{ id: string }>("entries/create", { method: "POST", body: input });
}

export function postAccountingEntry(entryId: string) {
  return accountingRequest<{ id: string }>("entries/post", { method: "POST", body: { entryId } });
}

export function reverseAccountingEntry(entryId: string, date: string, reason: string) {
  return accountingRequest<{ id: string }>("entries/reverse", { method: "POST", body: { entryId, date, reason } });
}

export function closeAccountingPeriod(periodId: string, note: string) {
  return accountingRequest<{ id: string }>("periods/close", { method: "POST", body: { periodId, note } });
}

export function refreshAccountingControls(entityId: string) {
  return accountingRequest<{ count: number }>("controls/refresh", { method: "POST", body: { entityId } });
}

export function getAccountingReport(input: { entityId: string; kind: AccountingReport["kind"]; from: string; to: string; accountId?: string }) {
  const params = new URLSearchParams({ entityId: input.entityId, kind: input.kind, from: input.from, to: input.to });
  if (input.accountId) params.set("accountId", input.accountId);
  return accountingRequest<AccountingReport>(`reports?${params.toString()}`);
}

export async function exportAccountingExcel(report: AccountingReport, title: string) {
  const ExcelJS = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Clima Activa CRM";
  const sheet = workbook.addWorksheet("Informe");
  const keys = Object.keys(report.rows[0] || {});
  sheet.addRow([title]);
  sheet.mergeCells(1, 1, 1, Math.max(keys.length, 1));
  sheet.getRow(1).font = { bold: true, size: 16, color: { argb: "FF0B6670" } };
  sheet.addRow(keys.map(humanizeKey));
  sheet.getRow(2).font = { bold: true, color: { argb: "FFFFFFFF" } };
  sheet.getRow(2).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0B6670" } };
  report.rows.forEach((row) => sheet.addRow(keys.map((key) => row[key] ?? "")));
  sheet.columns.forEach((column) => { column.width = 18; });
  const buffer = await workbook.xlsx.writeBuffer();
  downloadBlob(new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), `${slug(title)}.xlsx`);
}

export async function exportAccountingPdf(report: AccountingReport, title: string) {
  const { jsPDF } = await import("jspdf");
  const pdf = new jsPDF({ unit: "mm", format: "a4", orientation: report.kind === "balance8" ? "landscape" : "portrait" });
  const keys = Object.keys(report.rows[0] || {});
  pdf.setFontSize(16);
  pdf.setTextColor(11, 102, 112);
  pdf.text(title, 14, 16);
  pdf.setFontSize(7);
  pdf.setTextColor(40, 55, 60);
  const pageWidth = pdf.internal.pageSize.getWidth();
  const cellWidth = Math.max((pageWidth - 28) / Math.max(keys.length, 1), 18);
  let y = 25;
  keys.forEach((key, index) => pdf.text(humanizeKey(key).slice(0, 18), 14 + index * cellWidth, y));
  y += 5;
  for (const row of report.rows) {
    if (y > pdf.internal.pageSize.getHeight() - 12) { pdf.addPage(); y = 14; }
    keys.forEach((key, index) => pdf.text(String(row[key] ?? "").slice(0, 22), 14 + index * cellWidth, y));
    y += 4.5;
  }
  pdf.save(`${slug(title)}.pdf`);
}

function humanizeKey(value: string) {
  return value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function slug(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}
