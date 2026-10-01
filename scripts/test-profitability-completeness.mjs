import test from "node:test";
import assert from "node:assert/strict";
import { customerProfitability } from "../supabase/functions/accounting-center/customer-profitability.ts";
import { customerProfitabilityTool } from "../supabase/functions/crm-copilot/customer-profitability.ts";
import { monthlySalesScenario, salesProjectionTool, canonicalSalesProjectionMessage } from "../supabase/functions/crm-copilot/sales-projection.ts";
import { ToolRegistry } from "../supabase/functions/crm-copilot/tool-registry.ts";
const accounts=[{id:'cost',classification:'cost_of_sales'},{id:'stock',classification:'inventory'}];
const now=Date.parse('2026-09-15T15:00:00Z'), stamp='2026-09-15T14:00:00Z';
const doc=(id,tax='12345678-9',extra={})=>({id,entity_id:'entity',source_type:'FACTO',document_type:'sales_invoice',folio:id,issued_on:'2026-09-05',counterpart_tax_id:tax,counterpart_name:'Cliente '+id,currency:'CLP',net_amount:1000,exempt_amount:0,total_clp:1190,tax_amount:190,status:'validated',data_quality:'validated',...extra});
const cost=d=>[{id:d.id+'c',account_id:'cost',debit_clp:600,credit_clp:0},{id:d.id+'s',account_id:'stock',debit_clp:0,credit_clp:600}].map(l=>({...l,accounting_journal_entries:{id:d.id+'e',source_document_id:d.id,status:'posted',entry_date:d.issued_on}}));
const report=(docs,lines=[],opts={},offset=0)=>customerProfitability(docs,lines,accounts,'2026-09-01','2026-09-14','',2,offset,{now,sourceObservedAt:stamp,...opts});
test('Universo y cobertura global difieren del top y del porcentaje por cliente',()=>{
 const a=doc('a'),b=doc('b','76543210-K'),c=doc('c','76543210-K');const r=report([a,b,c],cost(a));
 assert.equal(r.completeness.universeCustomers,2);assert.equal(r.rankedCustomers,1);
 assert.equal(r.completeness.documentCoverage,33.3333);assert.equal(r.topProfit[0].coverage,100);
 assert.equal(r.pending[0].issues.length,2);assert.equal(r.pending[0].issues[0].documentId,'b');
 assert.match(r.pending[0].issues[0].path,/document=b/);assert.equal(r.pending[0].grossProfit,null);
});
test('Ventas inválidas no desaparecen ni se etiquetan como total cero',()=>{
 const d=doc('invalida','12345678-9',{currency:'USD',exchange_rate:null});const r=report([d]);
 assert.equal(r.customers,1);assert.equal(r.excludedDocuments,1);assert.equal(r.matches[0].salesComplete,false);
 assert.equal(r.matches[0].analysis.status,'unavailable');assert.equal(r.topSales.length,0);
 assert.equal(r.matches[0].issues[0].code,'sales_validation');
});
test('Identidad ambigua no se une a ficha ni certifica utilidad; no usa nombre',()=>{
 const a=doc('a'),b=doc('b','');const r=report([a,b],[...cost(a),...cost(b)],{ambiguousTaxIds:['123456789']});
 assert.equal(r.rankedCustomers,0);assert.equal(r.customers,2);assert.equal(r.completeness.identifiedCustomers,0);
 assert.equal(r.matches[0].issues[0].code,'ambiguous_identity');assert.ok(r.matches.every(x=>x.grossProfit===null));
});
test('Producto descrito y costo actual no completan costo histórico',()=>{
 const d=doc('a','12345678-9',{raw_payload:{details:[{line_description:'Producto de prueba',unit_cost:2}]}});const r=report([d]);
 assert.equal(r.matches[0].cost,null);assert.deepEqual(r.matches[0].issues[0].products,['Producto de prueba']);
});
test('Pendientes se recorren por páginas sin omitir clientes',()=>{
 const ds=Array.from({length:7},(_,i)=>doc('a'+i,`${12345670+i}-9`));const keys=[];
 for(let offset=0;offset<7;offset+=2){const r=report(ds,[],{cohort:'pending'},offset);assert.equal(r.matchedCustomers,7);keys.push(...r.matches.map(x=>x.customerKey));}
 assert.equal(new Set(keys).size,7);assert.equal(keys.length,7);
});
test('Nueva evidencia resuelve pendiente en siguiente lectura sin escribir ni duplicar',()=>{
 const d=doc('a');assert.equal(report([d]).pendingCustomers,1);
 const r=report([d,d],[...cost(d),...cost(d)]);assert.equal(r.pendingCustomers,0);assert.equal(r.matches[0].cost,600);assert.deepEqual(r.matches[0].issues,[]);
});
test('Sin datos, fuente antigua y fecha ausente son explícitos',()=>{
 assert.equal(report([]).completeness.documentCoverage,null);
 assert.equal(report([doc('a')],[],{sourceObservedAt:'2020-01-01'}).completeness.freshness,'old');
 assert.equal(report([],[],{sourceObservedAt:null}).completeness.freshness,'unknown');
});
test('Copiloto entrega acciones y no confunde cobertura ni omite provisionales',async()=>{
 const a=doc('a'),b=doc('b','76543210-K');let path;
 const r=await customerProfitabilityTool({api:async(_service,p)=>{path=p;return report([a,b],cost(a));}},{period:'custom',from:'2026-09-01',to:'2026-09-14'});
 assert.equal(r.coverage.complete,false);assert.equal(r.status,'partial');assert.match(r.summary,/Cliente a/);assert.match(r.summary,/Pendiente destacado/);assert.match(r.summary,/document=b/);assert.match(path,/customer-profitability/);
 const paged=await customerProfitabilityTool({api:async(_s,p)=>{path=p;return report([a,b],[],{cohort:'pending'},2);}},{period:'custom',from:'2026-09-01',to:'2026-09-14',cohort:'pending',offset:2});assert.match(path,/offset=2/);assert.equal(paged.data.ranking.length,0);
});
test('Escenarios usan documentos únicos, NC una vez y días completos; no margen/caja',()=>{
 const a=doc('a'),nc=doc('nc','12345678-9',{document_type:'sales_credit_note',net_amount:100,total_clp:119,tax_amount:19});
 const r=monthlySalesScenario([a,a,nc,doc('hoy','12345678-9',{issued_on:'2026-09-15'})],'2026-09-15',stamp,now);
 assert.equal(r.actualKnownNetSales,900);assert.equal(r.documents,2);assert.equal(r.elapsedDays,14);assert.equal(r.scenarios.length,3);
 assert.equal(r.scenarios[1].sales,1929);assert.equal(r.margin,null);assert.match(r.method,/no probabilidades/);assert.match(r.assumptions.join(' '),/No representa utilidad/);
});
test('No extrapola inicio, ausencia, datos inválidos o fuente antigua',()=>{
 for(const r of [monthlySalesScenario([doc('a')],'2026-09-02',stamp,now),monthlySalesScenario([],'2026-09-15',stamp,now),monthlySalesScenario([doc('a')],'2026-09-15','2020-01-01',now),monthlySalesScenario([doc('a','12345678-9',{currency:'USD'})],'2026-09-15',stamp,now)]){assert.equal(r.scenarios.length,0);assert.ok(r.blocked);}
 const uncertain=monthlySalesScenario([doc('a')],'2026-09-15',null,now);assert.equal(uncertain.confidence,'muy baja');assert.equal(uncertain.scenarios.length,3);
});
test('Proyección consulta fuentes actuales; error de red no se convierte en cero',async()=>{
 const paths=[];const s={entity:async()=> 'entity',all:async p=>{paths.push(p);return p.startsWith('integration_connections')?[{last_success_at:stamp}]:[doc('a')];}};
 const r=await salesProjectionTool(s,new Date(now));assert.equal(r.status,'partial');assert.equal(paths.length,2);assert.match(paths[0],/issued_on=lte.2026-09-14/);
 await assert.rejects(salesProjectionTool({...s,all:async()=>{throw Error('sin red');}},new Date(now)),/sin red/);
});
test('Permisos del registro impiden proyecciones/costos antes de consultar fuentes',async()=>{
 for(const role of ['vendedor','visualizador']){let reads=0;const registry=new ToolRegistry({actor:{role},all:async()=>{reads++;return[];},api:async()=>{reads++;return{};}});
 assert.ok(!registry.list().some(t=>t.name==='get_sales_projection'));
 const r=await registry.execute('get_sales_projection',{});assert.equal(r.status,'forbidden');assert.equal(reads,0);}
});

test('Resumen canónico preserva incertidumbre y no oculta otras herramientas',async()=>{
 const r=await salesProjectionTool({entity:async()=> 'entity',all:async p=>p.startsWith('integration_connections')?[]:[doc('a')]},new Date(now));
 assert.match(r.summary,/frescura unknown/);assert.match(r.summary,/Confianza muy baja/);
 assert.equal(canonicalSalesProjectionMessage([r]),r.summary);
 assert.equal(canonicalSalesProjectionMessage([r,{...r,toolName:'otra_fuente'}]),null);
 assert.equal(canonicalSalesProjectionMessage([{...r,status:'unavailable'}]),null);
});

test('Guías y anulados conservan trazabilidad sin crear costos pendientes artificiales',()=>{
 const a=doc('a'),guide=doc('guide','12345678-9',{document_type:'sales_dispatch_guide'}),voided=doc('void','12345678-9',{status:'voided'});
 const r=report([a,guide,voided],cost(a));assert.equal(r.rankedCustomers,1);assert.equal(r.pendingCustomers,0);assert.equal(r.excludedEvidence.length,2);assert.equal(r.topProfit[0].grossProfit,400);
 const projection=monthlySalesScenario([a,guide,voided],'2026-09-15',stamp,now);assert.equal(projection.excludedByPolicy,2);assert.equal(projection.excludedDocuments,0);assert.equal(projection.scenarios.length,3);
});
