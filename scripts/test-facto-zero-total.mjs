import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {normalizeFactoDocument as normalize} from '../supabase/functions/accounting-center/facto-document-normalization.ts';
import {planFactoDocumentMirror} from '../supabase/functions/crm-agent/facto-document-mirror.ts';
const cases=JSON.parse(await readFile(new URL('./fixtures/facto-zero-total-cases.json',import.meta.url),'utf8'));
const review='non_billable_accounting_review_required';
const xmlFor=c=>`<?xml version="1.0"?><DTE xmlns="http://www.sii.cl/SiiDte"><Documento ID="fixture"><Encabezado><IdDoc><TipoDTE>${c.total===0?34:33}</TipoDTE><Folio>${c.folio}</Folio><FchEmis>${c.date}</FchEmis></IdDoc><Emisor><RUTEmisor>11111111-1</RUTEmisor></Emisor><Receptor><RUTRecep>22222222-2</RUTRecep></Receptor><Totales>${Object.entries(c.xmlTotals).filter(([,v])=>v!==null).map(([k,v])=>`<${k}>${v}</${k}>`).join('')}</Totales></Encabezado>${c.lines.map((l,i)=>`<Detalle><NroLinDet>${i+1}</NroLinDet>${l.nonBillable?'<IndExe>2</IndExe>':''}<MontoItem>${l.amount}</MontoItem></Detalle>`).join('')}</Documento></DTE>`;
const payload=c=>({document_number:c.folio,issue_date:c.date,document_type_taxbureau:c.total===0?'34':'33',received_issued_flag:0,currency_id:39,issuer_legal_name:'Emisor sintético',issuer_tax_id_code:'11111111-1',receiver_tax_id_code:'22222222-2',net_amount:c.net,taxes_amount:c.tax,total_amount:c.total,electronic_document:{document_xml:Buffer.from(xmlFor(c)).toString('base64')}});
const bank=cases.filter(c=>c.total===0),fuel=cases.filter(c=>c.total>0);
assert.equal(bank.length,8);assert.equal(fuel.length,4);
for(const c of bank)test(`Recorded zero/non-billable shape ${c.caseId}: preserve amounts and block posting`,()=>{
  const p=payload(c),before=structuredClone(p),r=normalize(p,true,'fixture');
  assert.deepEqual(r.errors,[review]);assert.equal(r.nonBillableEvidence.nonBillableAmount,Number(c.xmlTotals.MontoNF));
  assert.equal(r.nonBillableEvidence.periodAmount,Number(c.xmlTotals.MontoPeriodo));assert.equal(r.nonBillableEvidence.detailCount,c.lines.length);
  assert.deepEqual([r.net,r.tax,r.exempt,r.total,r.totalClp],[0,0,0,0,0]);assert.deepEqual(p,before);
  assert.equal(planFactoDocumentMirror({external_id:'fixture',payload:p},'purchase_documents',[{id:'entity',tax_id:'22222222-2'}],[]).skip,'invalid_document');
});
for(const c of fuel)test(`Fuel discrepancy ${c.caseId} remains blocked`,()=>{
 const r=normalize(payload(c),true,'fixture');assert.ok(r.errors.includes('totals_mismatch'));assert.equal(r.nonBillableEvidence,null);
 assert.deepEqual([r.net,r.tax,r.total],[c.net,c.tax,c.total]);
});
test('Missing, malformed and unsupported zero are distinct; no truthiness coercion',()=>{
 for(const value of [undefined,null,'','   ']){const p=payload(bank[0]);p.total_amount=value;const r=normalize(p,true,'x');assert.ok(r.errors.includes('total_missing'));assert.equal(r.nonBillableEvidence,null);}
 for(const value of [false,true,{},[],NaN,Infinity,'garbage','0garbage','0..0','0.0.0','--0','0,']){const p=payload(bank[0]);p.total_amount=value;const r=normalize(p,true,'x');assert.ok(r.errors.includes('total_invalid'),String(value));assert.equal(r.nonBillableEvidence,null);}
 for(const value of [0,'0','0.00','0,00']){const p=payload(bank[0]);p.total_amount=value;assert.deepEqual(normalize(p,true,'x').errors,[review]);delete p.electronic_document;assert.deepEqual(normalize(p,true,'x').errors,['zero_total_evidence_required']);}
});
test('No issuer exception and no implicit permission for sales, unknown currency, type or direction',()=>{
 const base=payload(bank[0]);assert.ok(normalize(base,false,'x').errors.includes('zero_total_evidence_required'));
 for(const patch of [{currency_id:1},{currency_id:undefined},{currency:'USD'},{exchange_rate_value:2},{document_type_taxbureau:'33'},{received_issued_flag:1},{received_issued_flag:undefined},{issuer_tax_id_code:'33333333-3'},{receiver_tax_id_code:'33333333-3'},{document_number:'999'},{issue_date:'2026-02-30'},{net_amount:undefined},{taxes_amount:null},{exempt_amount:1},{net_amount:'bad'},{taxes_amount:false},{total:10}]){
  const r=normalize({...base,...patch},true,'x');assert.equal(r.nonBillableEvidence,null,JSON.stringify(patch));assert.ok(r.errors.length);
 }
 const noName=normalize({...base,issuer_legal_name:''},true,'x');assert.ok(noName.errors.includes('counterpart_missing'));
});
test('Nested Facto detail wrapper and plain XML retain the same evidence',()=>{
 const p=payload(bank[0]);p.electronic_document.document_xml=xmlFor(bank[0]);
 assert.deepEqual(normalize({data:{document:{header:p}}},true,'x').errors,[review]);
});
const malformedXml=[
 ['mixed content',x=>x.replace('<Documento ID=', 'garbage<Documento ID=')],['invalid declaration',x=>x.replace('version="1.0"','broken="yes"')],['unknown entity attr',x=>x.replace('ID="fixture"','ID="&unknown;"')],
 ['unclosed',x=>x.replace('</Documento>','')],['duplicate header',x=>x.replace('</Encabezado>','</Encabezado><Encabezado/>')],
 ['wrong namespace',x=>x.replace('http://www.sii.cl/SiiDte','urn:other')],['overridden namespace',x=>x.replace('<Totales>','<Totales xmlns="urn:other">')],
 ['duplicate total',x=>x.replace('</Totales>','<MntTotal>0</MntTotal></Totales>')],['missing total',x=>x.replace('<MntTotal>0</MntTotal>','')],
 ['missing nonbillable',x=>x.replace(/<MontoNF>.*?<\/MontoNF>/,'')],['period mismatch',x=>x.replace(/<MontoPeriodo>.*?<\/MontoPeriodo>/,'<MontoPeriodo>1</MontoPeriodo>')],
 ['missing period',x=>x.replace(/<MontoPeriodo>.*?<\/MontoPeriodo>/,'')],['nonbillable malformed',x=>x.replace(/<MontoNF>.*?<\/MontoNF>/,'<MontoNF>bad</MontoNF>')],
 ['negative nonbillable',x=>x.replace(/<MontoNF>.*?<\/MontoNF>/,'<MontoNF>-1</MontoNF>')],['nonzero exempt',x=>x.replace('<MntExe>0</MntExe>','<MntExe>1</MntExe>')],
 ['additional tax',x=>x.replace('</Totales>','<ImptoReten><MontoImp>1</MontoImp></ImptoReten></Totales>')],
 ['line mismatch',x=>x.replace(/<MontoItem>.*?<\/MontoItem>/,'<MontoItem>1</MontoItem>')],['taxable line',x=>x.replace('<IndExe>2</IndExe>','<IndExe>1</IndExe>')],
 ['missing lines',x=>x.replace(/<Detalle>[\s\S]*?<\/Detalle>/g,'')],['wrong date',x=>x.replace(/<FchEmis>.*?<\/FchEmis>/,'<FchEmis>2026-01-01</FchEmis>')],
 ['DTD',x=>'<!DOCTYPE DTE [<!ENTITY x SYSTEM "file:///no-read">]>'+x],['comment decoy',x=>'<!--'+x+'-->'],
 ['duplicate attr',x=>x.replace('ID="fixture"','ID="a" ID="b"')],['trailing garbage',x=>x+'garbage'],['nested total',x=>x.replace('<MntTotal>0</MntTotal>','<MntTotal><x>0</x></MntTotal>')],
 ['duplicate line',x=>x.replace('</Documento>',x.match(/<Detalle>[\s\S]*?<\/Detalle>/)[0]+'</Documento>')],
];
for(const [label,mutate] of malformedXml)test(`Evidence fails closed: ${label}`,()=>{const p=payload(bank[0]);p.electronic_document.document_xml=mutate(xmlFor(bank[0]));const r=normalize(p,true,'x');assert.equal(r.nonBillableEvidence,null);assert.ok(r.errors.includes('zero_total_evidence_required'));});
test('Broken base64 and oversize evidence fail closed',()=>{for(const xml of ['%%%%','x'.repeat(1_400_001)]){const p=payload(bank[0]);p.electronic_document.document_xml=xml;assert.equal(normalize(p,true,'x').nonBillableEvidence,null);}});
test('Positive exempt invoice remains unchanged and does not consume nonbillable evidence',()=>{const p=payload(bank[0]);p.total_amount=100;p.net_amount=100;const r=normalize(p,true,'x');assert.deepEqual(r.errors,[]);assert.deepEqual([r.net,r.exempt,r.tax,r.total],[0,100,0,100]);assert.equal(r.nonBillableEvidence,null);});
