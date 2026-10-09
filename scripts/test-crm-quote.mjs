import assert from 'node:assert/strict';
import {test} from 'node:test';
import {quoteTotals,validQuoteRut,quotePendingFields} from '../supabase/functions/_shared/crm-quote.ts';
import {prepareCrmQuote,registerCrmQuote,readCrmQuote} from '../supabase/functions/crm-agent/whatsapp-quote.ts';
import {scenario} from './whatsapp-automation-fixture.mjs';
const id='00000000-0000-4000-8000-000000000093';
function fixture(){
 const s=scenario();s.db.tables.interactions=[];
 s.incoming.id='00000000-0000-4000-8000-000000000095';s.incoming.body='Quiero una cotización formal. RUT 15.427.713-7 Cliente sintético. Dirección sintética 100. Comuna de prueba';s.incoming.raw_payload.entry[0].changes[0].value.messages[0].text.body=s.incoming.body;
 s.db.tables.whatsapp_messages.push({...s.incoming,id:'out-question',direction:'outbound',status:'accepted',body:'Elegiste Manómetro R32 (código LX1030). ¿Cuántas unidades quieres?',occurred_at:new Date(Date.now()-120000).toISOString(),raw_payload:null},{...s.incoming,id:'in-quantity',direction:'inbound',body:'2',occurred_at:new Date(Date.now()-60000).toISOString(),raw_payload:null});const original=s.db.from;let nextNumber=100;
 s.db.rpc=async(_name,p)=>{const old=s.db.tables.interactions.find(r=>r.id===p.p_quote.id);if(old)return {data:{quote:JSON.parse(old.result),alreadyRegistered:true},error:null};const quote={...p.p_quote,quoteNumber:nextNumber,folio:'CRM-'+nextNumber++};s.db.tables.interactions.push({id:quote.id,company_id:p.p_company_id,type:'cotizacion',result:JSON.stringify(quote)});return {data:{quote,alreadyRegistered:false},error:null};};
 s.db.from=function(name){if(name!=='interactions')return original.call(this,name);let selected=id,inserted;
 const q={select(){return q},eq(k,v){selected=v;return q},insert(v){inserted=v;return q},async maybeSingle(){return {data:s.db.tables.interactions.find(r=>r.id===selected)||null,error:null}},then(resolve){if(inserted)s.db.tables.interactions.push(inserted);return Promise.resolve({error:null}).then(resolve)}};return q;};
 const party={name:'Cliente sintético',rut:'15.427.713-7',address:'Dirección sintética 100',commune:'Comuna de prueba'};
 const input={id,sourceMessageId:s.incoming.id,companyId:s.incoming.company_id,issuer:{...party},customer:{...party},lines:[{sku:'LX1030',quantity:2}],validDays:7,pricesIncludeVat:true,conditions:'Despacho no incluido.'};
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

test('formal quote rejects customer data missing from the conversation',async()=>{
 const s=fixture();s.incoming.body='Quiero una cotización formal';s.incoming.raw_payload.entry[0].changes[0].value.messages[0].text.body=s.incoming.body;
 await assert.rejects(prepareCrmQuote(s.db,s.env,s.input,s.fetcher),/cliente debe enviar/);assert.equal(s.db.tables.interactions.length,0);
 const changed=fixture();changed.input.customer.address='Inventada';await assert.rejects(prepareCrmQuote(changed.db,changed.env,changed.input,changed.fetcher),/coincidir/);
 const unselected=fixture();unselected.db.tables.whatsapp_messages=unselected.db.tables.whatsapp_messages.slice(0,1);await assert.rejects(prepareCrmQuote(unselected.db,unselected.env,unselected.input,unselected.fetcher),/elegir/);
});

test('bank details come from the issuer configuration and persist with blank observations',async()=>{
 const s=fixture();s.input.issuer.rut='77.724.382-9';s.input.bankDetails={accountNumber:'fake'};
 const q=await prepareCrmQuote(s.db,s.env,s.input,s.fetcher);assert.equal(q.bankDetails.accountNumber,'985659206');assert.equal(q.conditions,'');
 const saved=await registerCrmQuote(s.db,s.env,id,{...s.input,expected:q,confirm:true},s.fetcher);
 assert.deepEqual(saved.quote.bankDetails,q.bankDetails);
 const changed={...q,bankDetails:{...q.bankDetails,accountNumber:'fake'}};const other=fixture();other.input.issuer.rut='77.724.382-9';await assert.rejects(registerCrmQuote(other.db,other.env,id,{...other.input,expected:changed,confirm:true},other.fetcher),/cambiaron/);
});
test('quote contact phone comes from the source WhatsApp message, not client payload',async()=>{
 const s=fixture();s.input.customer.phone='+56900000000';const q=await prepareCrmQuote(s.db,s.env,s.input,s.fetcher);
 const source=s.db.tables.whatsapp_messages.find(m=>m.id===s.input.sourceMessageId);assert.equal(q.customer.phone,'+'+source.phone_number.replace(/\D/g,''));assert.notEqual(q.customer.phone,s.input.customer.phone);
});
test('formal quote automatically caps requested quantity to verified positive stock and records the difference',async()=>{
 const s=fixture();s.payload.variants[0].stock=1;const q=await prepareCrmQuote(s.db,s.env,s.input,s.fetcher);assert.equal(q.lines[0].quantity,1);assert.equal(q.lines[0].requestedQuantity,2);assert.equal(q.total,32000);
 s.payload.variants[0].stock=0;await assert.rejects(prepareCrmQuote(s.db,s.env,s.input,s.fetcher),/stock/);
});
