type Row = Record<string, unknown>;

const object = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const ids = (value: unknown): string[] => Array.isArray(value) ? value.map(String) : [];

// A confirmed workbook is a reporting scope, not permission to close absent cheques.
export function buildCheckPortfolio(batch: Row | null, importRows: Row[], checks: Row[]) {
  const base = {
    batchId: batch ? String(batch.id) : null,
    fileName: batch ? String(batch.file_name || "") : null,
    reportedAt: batch ? String(batch.created_at || "") : null,
    verified: false,
    checkIds: [] as string[],
    amountClp: null as number | null,
    count: 0,
    issue: null as string | null,
  };
  if (!batch) return base;
  const invalid = (issue: string) => ({ ...base, issue });
  if (batch.status !== "imported" || Number(batch.error_count) !== 0 || !importRows.length || importRows.length !== Number(batch.row_count)) {
    return invalid("El ultimo informe aplicado esta incompleto o contiene errores. La cartera requiere revision.");
  }
  const rows = new Map(importRows.map(row => [String(row.id), row]));
  if (rows.size !== importRows.length || importRows.some(row => !["imported", "duplicate"].includes(String(row.status)) || ids(row.validation_errors).length)) {
    return invalid("Las filas del informe no estan completamente aplicadas.");
  }
  const included = checks.filter(check => check.import_batch_id === batch.id);
  const covered = new Set<string>();
  for (const check of included) {
    const metadata = object(check.metadata);
    const sourceIds = [...new Set([...ids(metadata.source_row_ids), ...(check.source_row_id ? [String(check.source_row_id)] : [])])];
    if (!sourceIds.length || sourceIds.some(id => !rows.has(id) || covered.has(id))) return invalid("Hay cheques sin respaldo unico dentro del informe aplicado.");
    let amount = 0;
    for (const id of sourceIds) {
      const data = object(rows.get(id)?.normalized_data);
      if (data.kind !== "check" || String(data.check_number) !== String(check.check_number) || !Number.isFinite(Number(data.amount_clp)) || Number(data.amount_clp) <= 0) {
        return invalid("Un cheque no coincide con el respaldo aplicado.");
      }
      amount += Number(data.amount_clp);
      covered.add(id);
    }
    if (amount !== Number(check.amount_clp)) return invalid("El monto de un cheque difiere del informe aplicado.");
  }
  if (covered.size !== rows.size) return invalid("Faltan cheques del informe aplicado en el CRM.");
  const portfolio = included.filter(check => check.status === "portfolio");
  return {
    ...base,
    verified: true,
    checkIds: included.map(check => String(check.id)),
    amountClp: portfolio.reduce((sum, check) => sum + Number(check.amount_clp), 0),
    count: portfolio.length,
  };
}
