type Row = Record<string, unknown>;
const object = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const number = (value: unknown) => value === null || value === undefined || value === '' ? NaN : Number(value);

export function statementClosingBalance(input: Row[]) {
  const rows = input.filter(row => /^\d{4}-\d{2}-\d{2}$/.test(String(row.transaction_date || '')))
    .sort((a,b) => number(a.row_number) - number(b.row_number));
  if (!rows.length || rows.some(row => !Number.isFinite(number(row.row_number)))) return { closing:null, order:'unknown', warning:'Cartola sin secuencia verificable.' };
  const changes = new Set(rows.slice(1).map((row,i) => String(row.transaction_date).localeCompare(String(rows[i].transaction_date))).filter(Boolean).map(Math.sign));
  const latestDate = rows.map(row => String(row.transaction_date)).sort().at(-1);
  const latest = rows.filter(row => row.transaction_date === latestDate);
  const valid = (sequence: Row[]) => sequence.every((row,i) => Number.isFinite(number(row.balance)) && (!i
    || (Number.isFinite(number(row.amount)) && Math.abs(number(sequence[i-1].balance) + number(row.amount) - number(row.balance)) < 0.005)));
  let ordered: Row[] | null = null;
  let order = 'unknown';
  if (changes.size === 1) {
    order = changes.has(1) ? 'ascending' : 'descending';
    ordered = order === 'ascending' ? latest : [...latest].reverse();
    if (!valid(ordered)) ordered = null;
  } else if (changes.size === 0) {
    const forward = valid(latest), backward = valid([...latest].reverse());
    if (forward && !backward) { ordered=latest; order='ascending'; }
    else if (backward && !forward) { ordered=[...latest].reverse(); order='descending'; }
    else if (forward && backward && number(latest[0].balance) === number(latest.at(-1)!.balance)) ordered=latest;
  }
  if (!ordered) return { closing:null, order, warning:'El orden de los movimientos no permite confirmar el saldo final de la cartola.' };
  return { closing:ordered.at(-1)!, order, warning:null };
}

// Re-read complete import rows, including duplicates: a closing debit may not be a new transaction.
export async function readStatementClosings(read: (query: string) => Promise<Row[]>, batches: Row[], transactions: Row[]) {
  const closingRows: Row[] = [], warnings: Record<string,string> = {};
  const inspected = new Set<string>();
  const excludedBatches = new Set<string>();
  const latestDate = (batch: Row) => String(object(object(batch.summary).statement_balance).transaction_date || transactions.filter(row => row.import_batch_id === batch.id).map(row => String(row.transaction_date)).sort().at(-1) || '');
  const orderedBatches = [...batches].sort((a,b) => latestDate(b).localeCompare(latestDate(a)) || String(object(b.summary).confirmed_at || b.created_at).localeCompare(String(object(a.summary).confirmed_at || a.created_at)));
  for (const batch of orderedBatches) {
    const summary = object(batch.summary);
    const linkedAccounts = [...new Set(transactions.filter(row => row.import_batch_id === batch.id).map(row => String(row.bank_account_id)))];
    const accountId = String(summary.bank_account_id || (linkedAccounts.length === 1 ? linkedAccounts[0] : ''));
    if (!accountId || inspected.has(accountId)) continue;
    inspected.add(accountId);
    for (const same of batches) {
      if (String(object(same.summary).bank_account_id || '') === accountId || transactions.some(t => t.import_batch_id === same.id && String(t.bank_account_id) === accountId)) excludedBatches.add(String(same.id));
    }
    const imported = await read(`accounting_import_rows?select=row_number,normalized_data,status&batch_id=eq.${batch.id}&order=row_number.asc`);
    if (!imported.length || imported.length !== Number(batch.row_count) || imported.some(row => !['imported','duplicate'].includes(String(row.status)))) {
      warnings[accountId] = 'La ultima cartola no tiene todas sus filas confirmadas.';
      continue;
    }
    const result = statementClosingBalance(imported.map(row => ({...object(row.normalized_data),row_number:row.row_number})));
    if (!result.closing) { warnings[accountId]=result.warning || 'Saldo final por verificar.'; continue; }
    const closing = result.closing;
    const currencies = new Set(imported.map(row => String(object(row.normalized_data).currency || summary.currency || 'CLP')));
    if (currencies.size !== 1) { warnings[accountId]='Cartola con monedas mezcladas.'; continue; }
    const currency = [...currencies][0];
    const documentedRate = number(closing.exchange_rate);
    const batchTransactions = transactions.filter(row => row.import_batch_id === batch.id && String(row.bank_account_id) === accountId && Number(row.exchange_rate)>0);
    const rates = [...new Set(batchTransactions.map(row => Number(row.exchange_rate)))];
    const matchingRate = number(batchTransactions.find(row => Number(object(row.metadata).source_row) === Number(closing.row_number))?.exchange_rate);
    const closingRate = number(object(summary.statement_balance).exchange_rate);
    const rate = currency === 'CLP' ? 1 : documentedRate>0 ? documentedRate : closingRate>0 ? closingRate : matchingRate>0 ? matchingRate : rates.length===1 ? rates[0] : null;
    if (rate === null) { warnings[accountId]='Falta un tipo de cambio verificable para la cartola.'; continue; }
    closingRows.push({...closing, id:`statement-${batch.id}`, bank_account_id:accountId, import_batch_id:batch.id,
      currency, exchange_rate:rate, created_at:String(summary.confirmed_at || batch.created_at), metadata:{source_row:closing.row_number,statement_order:result.order}});
  }
  return { closingRows, warnings, excludedBatches };
}

export function validatedBankBalance(balance: unknown, currency: string, exchangeRate: unknown) {
  if (typeof balance !== 'number' || !Number.isFinite(balance) || balance < 0 || !Number.isSafeInteger(Math.round(balance*10000))) throw new Error('Ingresa un saldo bancario valido.');
  const rate = currency === 'CLP' ? 1 : exchangeRate;
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) throw new Error(`Ingresa un tipo de cambio ${currency}/CLP valido para confirmar el saldo.`);
  const balanceClp = Math.round(balance*rate*10000)/10000;
  if (!Number.isSafeInteger(Math.round(balanceClp*10000))) throw new Error('El equivalente en CLP excede el limite permitido.');
  return {balance:Math.round(balance*10000)/10000,exchangeRate:rate,balanceClp};
}
