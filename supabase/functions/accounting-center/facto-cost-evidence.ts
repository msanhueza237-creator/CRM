type Row = Record<string, unknown>;

// A source-linked posted cost is evidence, regardless of which importer created it.
// Require its inventory counterpart; a payment, income line or reversed cost is not enough.
export function confirmedCostSourceIds(lines: Row[], accounts: Row[], asOf: string): Set<string> {
  const accountMap = new Map(accounts.map(account => [String(account.id), account]));
  const entries = new Map<string, { sourceId: string; cost: number; inventory: number }>();
  for (const line of lines) {
    const entry = line.accounting_journal_entries as Row | undefined;
    const account = accountMap.get(String(line.account_id));
    if (!entry || !account || !entry.source_document_id || !entry.id
      || !["posted", "reversed"].includes(String(entry.status))
      || !entry.entry_date || String(entry.entry_date) > asOf) continue;
    const value = Number(line.debit_clp) - Number(line.credit_clp);
    if (!Number.isFinite(value)) continue;
    const key = String(entry.id);
    const total = entries.get(key) || { sourceId: String(entry.source_document_id), cost: 0, inventory: 0 };
    if (account.classification === "cost_of_sales") total.cost += value;
    if (account.classification === "inventory") total.inventory += value;
    entries.set(key, total);
  }
  const bySource = new Map<string, { amount: number; complete: boolean }>();
  for (const entry of entries.values()) {
    if (!entry.cost && !entry.inventory) continue;
    const total = bySource.get(entry.sourceId) || { amount: 0, complete: true };
    total.amount += entry.cost;
    total.complete &&= Math.abs(entry.cost + entry.inventory) < 0.005;
    bySource.set(entry.sourceId, total);
  }
  return new Set([...bySource].filter(([, total]) => total.complete && total.amount > 0.005).map(([id]) => id));
}

export function assertExistingFactoCost(
  entry: Row, lines: Row[], costAccountId: string, inventoryAccountId: string,
  expectedAmount: number, creditNote: boolean,
): number {
  if (entry.status !== "posted") throw new Error("El costo existente no esta contabilizado vigente. Requiere revision antes de reintentar.");
  if (lines.length !== 2) throw new Error("El asiento de costo existente tiene una estructura distinta. Requiere revision.");
  const sign = creditNote ? -1 : 1;
  const cost = lines.find(line => String(line.account_id) === costAccountId);
  const inventory = lines.find(line => String(line.account_id) === inventoryAccountId);
  const actual = cost ? (Number(cost.debit_clp) - Number(cost.credit_clp)) * sign : NaN;
  const inventoryAmount = inventory ? (Number(inventory.credit_clp) - Number(inventory.debit_clp)) * sign : NaN;
  if (!Number.isFinite(actual) || !Number.isFinite(inventoryAmount) || actual <= 0
    || Math.abs(actual - inventoryAmount) >= 0.005 || Math.abs(actual - expectedAmount) >= 0.005) {
    throw new Error("El costo recibido difiere del asiento guardado. No se marco como actualizado ni se sobrescribio: requiere rectificacion contable.");
  }
  return actual;
}
