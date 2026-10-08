import assert from 'node:assert/strict';
import {test} from 'node:test';
import {quoteTotals,validQuoteRut} from '../supabase/functions/_shared/crm-quote.ts';
import {prepareCrmQuote,registerCrmQuote} from '../supabase/functions/crm-agent/whatsapp-quote.ts';
import {scenario} from './whatsapp-automation-fixture.mjs';
const id='00000000-0000-4000-8000-000000000093';
function fixture(){
 const s=scenario();s.db.tables.interactions=[];const original=s.db.from;
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
 assert.equal(s.db.tables.interactions.length,1);assert.equal(JSON.parse(s.db.tables.interactions[0].result).total,64000);
 const retry=await registerCrmQuote(s.db,s.env,id,{...s.input,expected,confirm:true},s.fetcher);assert.equal(retry.alreadyRegistered,true);assert.equal(retry.quote.folio,r.quote.folio);assert.equal(s.db.tables.interactions.length,1);
});
test('price changes block registration until a new review',async()=>{const s=fixture(),expected=await prepareCrmQuote(s.db,s.env,s.input,s.fetcher);s.payload.variants[0].promotional_price='35000';await assert.rejects(registerCrmQuote(s.db,s.env,id,{...s.input,expected,confirm:true},s.fetcher),/cambiaron/);assert.equal(s.db.tables.interactions.length,0);});
test('missing customer, bad RUT, duplicate SKU, quantity and insufficient stock stop emission',async()=>{
 for(const edit of [p=>p.customer={...p.customer,rut:'15427713-1'},p=>p.issuer={...p.issuer,address:''},p=>p.lines=[...p.lines,...p.lines],p=>p.lines[0].quantity=0,p=>p.lines[0].quantity=3]){
  const s=fixture();edit(s.input);await assert.rejects(prepareCrmQuote(s.db,s.env,s.input,s.fetcher));assert.equal(s.db.tables.interactions.length,0);
 }
});
