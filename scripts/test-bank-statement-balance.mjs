import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
import {statementClosingBalance, readStatementClosings, validatedBankBalance} from '../supabase/functions/accounting-center/bank-statement-balance.ts';
import {parseBankControlNumber, bankControlValue} from '../src/modules/accounting/bankBalanceInput.ts';

const row = (row_number, transaction_date, amount, balance) => ({row_number,transaction_date,amount,balance,currency:'USD'});
const descending = [row(12,'2026-09-11',-11000,0.8),row(13,'2026-09-11',11000,11000.8),row(14,'2026-08-24',-23000,0.8),row(15,'2026-08-24',23000,23000.8)];
test('USD descending cartola closes after the outgoing invoice transfer, not the purchase of dollars',()=>{
  const result=statementClosingBalance(descending);
  assert.equal(result.order,'descending'); assert.equal(result.closing.balance,0.8); assert.equal(result.closing.row_number,12);
});
test('Ascending statements retain the last chronological balance',()=>{
  const rows=[...descending].reverse().map((r,i)=>({...r,row_number:i+1}));
  assert.equal(statementClosingBalance(rows).closing.balance,0.8);
  assert.equal(statementClosingBalance(rows).order,'ascending');
});
test('Uncertain same-day order, mixed dates, missing closing balance and inconsistent running balances fail closed',()=>{
  assert.equal(statementClosingBalance(descending.slice(0,2)).closing,null);
  assert.equal(statementClosingBalance(descending.map((r,i)=>({...r,balance:i===0?null:r.balance}))).closing,null);
  assert.equal(statementClosingBalance(descending.map((r,i)=>({...r,balance:i===0?80:r.balance}))).closing,null);
  assert.equal(statementClosingBalance([row(1,'2026-09-10',1,1),row(2,'2026-09-12',1,2),row(3,'2026-09-11',1,3)]).closing,null);
  assert.equal(statementClosingBalance([row(1,'2026-09-11',10,10)]).closing.balance,10);
});
test('Full imported rows include duplicate debits and replace the old intermediate balance read model', async()=>{
  const batch={id:'batch',row_count:4,created_at:'2026-09-15T01:12:41Z',summary:{currency:'USD'}};
  const transactions=[{id:'deposit',import_batch_id:'batch',bank_account_id:'usd',transaction_date:'2026-09-11',exchange_rate:956,balance:11000.8,metadata:{source_row:13}}];
  const result=await readStatementClosings(async query=>{
    assert.match(query,/accounting_import_rows/);
    return descending.map((r,i)=>({row_number:r.row_number,normalized_data:r,status:i===0?'duplicate':'imported'}));
  },[batch],transactions);
  assert.equal(result.closingRows[0].balance,0.8); assert.equal(result.closingRows[0].exchange_rate,956);
  assert.deepEqual(result.warnings,{}); assert.equal(result.excludedBatches.has('batch'),true);
});
test('An incomplete confirmed file is never advertised as a closing balance',async()=>{
  const result=await readStatementClosings(async()=>[],[{id:'batch',row_count:4,summary:{bank_account_id:'usd'}}],[]);
  assert.equal(result.closingRows.length,0); assert.match(result.warnings.usd,/todas sus filas/);
});
test('Uploading a historical file later does not regress the available balance date',async()=>{
  const batches=[{id:'old',row_count:1,created_at:'2026-09-16',summary:{bank_account_id:'usd',statement_balance:{transaction_date:'2026-08-01',exchange_rate:956}}},
    {id:'new',row_count:4,created_at:'2026-09-15',summary:{bank_account_id:'usd',statement_balance:{transaction_date:'2026-09-11',exchange_rate:956}}}];
  const result=await readStatementClosings(async query=>{
    assert.match(query,/batch_id=eq.new/); return descending.map(r=>({row_number:r.row_number,normalized_data:r,status:'imported'}));
  },batches,[]);
  assert.equal(result.closingRows[0].balance,0.8);
});
test('USD confirmation requires the explicit exchange rate, retains cents, and never turns garbage into zero',()=>{
  assert.deepEqual(validatedBankBalance(0.8,'USD',956),{balance:0.8,exchangeRate:956,balanceClp:764.8});
  assert.equal(validatedBankBalance(0,'USD',956).balance,0);
  assert.equal(validatedBankBalance(1000,'CLP',undefined).exchangeRate,1);
  for (const balance of ['',null,undefined,'bad',NaN,Infinity,-1]) assert.throws(()=>validatedBankBalance(balance,'USD',956));
  for (const rate of [undefined,null,0,-1,NaN,Infinity,'956']) assert.throws(()=>validatedBankBalance(0.8,'USD',rate),/tipo de cambio/);
});
test('Money input accepts Chilean cents and does not silently change invalid values into zero',()=>{
  for (const value of ['0,80','0.80']) assert.equal(parseBankControlNumber(value),0.8);
  assert.equal(parseBankControlNumber('11.000,80'),11000.8); assert.equal(parseBankControlNumber('1.000'),1000);
  assert.equal(parseBankControlNumber('80'),80); assert.equal(bankControlValue(0.8),'0,8');
  for (const value of ['','abc','1,2,3','USD 80','1.2.3']) assert.ok(Number.isNaN(parseBankControlNumber(value)));
});

const source=await readFile('supabase/functions/accounting-center/index.ts','utf8');
const tree=ts.createSourceFile('index.ts',source,ts.ScriptTarget.Latest,true);
const code=ts.transpileModule(tree.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='confirmBankBalance').getText(tree),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
test('Actual confirmation handler sends USD amount and conversion without creating journals or payments',async()=>{
  const writes=[];
  class HttpError extends Error {constructor(status,message){super(message);this.status=status;}}
  const deps={requiredUuid:x=>x,requiredDate:x=>x,accountingToday:()=> '2026-09-15',HttpError,validatedBankBalance,optionalText:x=>x,
    selectRows:async()=>[{currency:'USD'}],upsertRows:async(_,table,rows)=>{writes.push({table,rows});return [{id:'snapshot'}];},
    insertRows:async(_,table,rows)=>{writes.push({table,rows});return [];}};
  const fn=new Function(...Object.keys(deps),`${code};return confirmBankBalance`)(...Object.values(deps));
  const input={entityId:'entity',bankAccountId:'usd',asOfDate:'2026-09-15',balance:0.8,exchangeRate:956};
  await fn({}, {id:'user'},input);
  assert.deepEqual(writes.map(w=>w.table),['accounting_bank_balance_snapshots','accounting_audit_events']);
  assert.equal(writes[0].rows[0].balance,0.8);assert.equal(writes[0].rows[0].balance_clp,764.8);
  assert.ok(writes[0].rows[0].updated_at);
  writes.length=0;
  await assert.rejects(()=>fn({}, {id:'user'},{...input,exchangeRate:undefined}),e=>e.status===400);
  await assert.rejects(()=>fn({}, {id:'user'},{...input,balance:'abc'}),e=>e.status===400);
  await assert.rejects(()=>fn({}, {id:'user'},{...input,asOfDate:'2026-09-16'}),e=>e.status===400);
  assert.equal(writes.length,0);
});
