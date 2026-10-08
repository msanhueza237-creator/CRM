import assert from 'node:assert/strict';
import {test} from 'node:test';
import {quoteTotals,validQuoteRut,quotePendingFields} from '../supabase/functions/_shared/crm-quote.ts';
import {prepareCrmQuote,registerCrmQuote,readCrmQuote} from '../supabase/functions/crm-agent/whatsapp-quote.ts';
import {scenario} from './whatsapp-automation-fixture.mjs';
const id='00000000-0000-4000-8000-000000000093';
function fixture(){
 const s=scenario();s.db.tables.interactions=[];const original=s.db.from;let nextNumber=100;
 s.db.rpc=async(_name,p)=>{const old=s.db.tables.interactions.find(r=>r.id===p.p_quote.id);if(old)return {data:{quote:JSON.parse(old.result),alreadyRegistered:true},error:null};const quote={...p.p_quote,quoteNumber:nextNumber,folio:'CRM-'+nextNumber++};s.db.tables.interactions.push({id:quote.id,company_id:p.p_company_id,type:'cotizacion',result:JSON.stringify(quote)});return {data:{quote,alreadyRegistered:false},error:null};};
 s.db.from=function(name){if(name!=='interactions')return original.call(this,name);let selected=id,inserted;
 const q={select(){return q},eq(k,v){selected=v;return q},insert(v){inserted=v;return q},async maybeSingle(){return {data:s.db.tables.interactions.find(r=>r.id===selected)||null,error:null}},then(resolve){if(inserted)s.db.tables.interactions.push(inserted);return Promise.resolve({error:null}).then(resolve)}};return q;};
 const party={name:'Cliente sintético',rut:'15.427.713-7',address:'Dirección sintética 100',commune:'Comuna de prueba'};
 const input={id,companyId:s.incoming.company_id,issuer:party,customer:party,lines:[{sku:'LX1030',quantity:2}],validDays:7,pricesIncludeVat:true,conditions:'Despacho no incluido.'};
 return {...s,input};
}
test('RUT validates digit rather than accepting any text',()=>{assert.equal(validQuoteRut('15427713-7'),true);assert.equal(validQuoteRut('15427713-1'),false);});
test('VAT inclusive is separated once and exclusive VAT is added once',()=>{assert.deepEqual(quoteTotals([{unitPrice:11900,quantity:2}],true),{net:20000,vat:3800,total:23800});assert.deepEqual(quoteTotals([{unitPrice:10000,quantity:2}],false),{net:20000,vat:3800,total:23800});});
test('preview refreshes promotional variant price and does not register or send',async()=>{const s=fixture(),q=await prepareCrmQuote(s.db,s.env,s.input,s.fetcher);assert.equal(q.total,64000);assert.equal(q.net+q.vat,q.total);assert.equal(q.lines[0].unitPrice,32000);assert.equal(s.calls.length,1);assert.equal(s.db.tables.interactions.length,0);});
test('registration requires review, preserves snapshot and is idempotent',async()=>{const s=fixture(),expected=await prepareCrmQuote(s.db,s.env,s.input,s.fetcher);
 await assert.rejects(registerCrmQuote(s.db,s.env,id,s.input,s.fetcher),/Revisa/);
 const r=await registerCrmQuote(s.db,s.env,id,{...s.input,expected,confirm:true},s.fetcher);
 assert.equal(r.quote.quoteNumber,100);assert.equal(r.quote.folio,'CRM-100');assert.equal(s.db.tables.interactions.length,1);assert.equal(JSON.parse(s.db.tables.interactions[0].result).total,64000);
 const retry=await registerCrmQuote(s.db,s.env,id,{...s.input,expected,confirm:true},s.fetcher);assert.equal(retry.alreadyRegistered,true);assert.equal(retry.quote.folio,r.quote.folio);assert.equal(s.db.tables.interactions.length,1);
});
test('price changes block registration until a new review',async()=>{const s=fixture(),expected=await prepareCrmQuote(s.db,s.env,s.input,s.fetcher);s.payload.variants[0].promotional_price='35000';await assert.rejects(registerCrmQuote(s.db,s.env,id,{...s.input,expected,confirm:true},s.fetcher),/cambiaron/);assert.equal(s.db.tables.interactions.length,0);});
test('duplicate SKU, quantity and insufficient stock stop emission',async()=>{
 for(const edit of [p=>p.lines=[...p.lines,...p.lines],p=>p.lines[0].quantity=0,p=>p.lines[0].quantity=3]){
  const s=fixture();edit(s.input);await assert.rejects(prepareCrmQuote(s.db,s.env,s.input,s.fetcher));assert.equal(s.db.tables.interactions.length,0);
 }
});

test('saved quote retrieval preserves long snapshots rather than a history excerpt',async()=>{
 const s=fixture();s.input.conditions='Condiciones de prueba '.repeat(70);
 const expected=await prepareCrmQuote(s.db,s.env,s.input,s.fetcher);await registerCrmQuote(s.db,s.env,id,{...s.input,expected,confirm:true},s.fetcher);
 assert.equal(expected.conditions,'');
 const legacy={...JSON.parse(s.db.tables.interactions[0].result),conditions:'Condiciones históricas de prueba '.repeat(70)};s.db.tables.interactions[0].result=JSON.stringify(legacy);assert.ok(s.db.tables.interactions[0].result.length>1500);
 const result=await readCrmQuote(s.db,id);assert.equal(result.quote.conditions,legacy.conditions);assert.equal(result.quote.lines[0].quantity,2);
 await assert.rejects(readCrmQuote(s.db,'bad-id'),/inválido/);
});

test('incomplete parties can be prepared and saved with pending fields preserved',async()=>{
 const s=fixture();s.input.customer={name:'',rut:'15427713-1',address:'',commune:''};s.input.issuer.address='';
 const expected=await prepareCrmQuote(s.db,s.env,s.input,s.fetcher);
 assert.deepEqual(quotePendingFields(expected),['Emisor: dirección pendiente','Cliente: nombre pendiente','Cliente: RUT por verificar','Cliente: dirección pendiente','Cliente: comuna pendiente']);
 const result=await registerCrmQuote(s.db,s.env,id,{...s.input,expected,confirm:true},s.fetcher);
 assert.equal(result.quote.customer.rut,'15427713-1');assert.equal(result.quote.total,64000);assert.equal(s.db.tables.interactions.length,1);
});

test('bank details come from the issuer configuration and persist with blank observations',async()=>{
 const s=fixture();s.input.issuer.rut='77.724.382-9';s.input.bankDetails={accountNumber:'fake'};
 const q=await prepareCrmQuote(s.db,s.env,s.input,s.fetcher);assert.equal(q.bankDetails.accountNumber,'985659206');assert.equal(q.conditions,'');
 const saved=await registerCrmQuote(s.db,s.env,id,{...s.input,expected:q,confirm:true},s.fetcher);
 assert.deepEqual(saved.quote.bankDetails,q.bankDetails);
 const changed={...q,bankDetails:{...q.bankDetails,accountNumber:'fake'}};const other=fixture();other.input.issuer.rut='77.724.382-9';await assert.rejects(registerCrmQuote(other.db,other.env,id,{...other.input,expected:changed,confirm:true},other.fetcher),/cambiaron/);
});
