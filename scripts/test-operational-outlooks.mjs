import test from 'node:test';
import assert from 'node:assert/strict';
import { customerPurchaseSignals, comparablePurchaseWindows, customerPurchaseSignalsTool } from '../supabase/functions/crm-copilot/customer-purchase-signals.ts';
import { stockCoverageScenario, incomingForSku, stockOutlookTool, canonicalOperationalOutlookMessage } from '../supabase/functions/crm-copilot/stock-outlook.ts';
import { ToolRegistry } from '../supabase/functions/crm-copilot/tool-registry.ts';
import { specialists } from '../supabase/functions/crm-copilot/agent-manager.ts';
const now=Date.parse('2026-10-01T15:00:00Z'),stamp='2026-10-01T14:00:00Z',today='2026-10-01';
const range={from:'2026-09-01',to:'2026-09-30'};
const stock={sku:'SKU-1',stock:20,stock_known:true,stock_source:'facto_product_details',stock_updated_at:stamp,stock_warnings:[]};
const sales=[{sku:'SKU-1',units_sold:60,document_count:4}];
const result=(name,records,extra={})=>({toolName:name,domain:'sales',status:'ok',summary:'synthetic',data:{records},table:{rows:records,columns:[],title:''},evidence:[],warnings:[],coverage:{complete:true,totalMatched:records.length,returned:records.length},freshness:{fetchedAt:stamp,sourceObservedAt:stamp},...extra});
const detail=(extra={})=>result('get_import_details',[],{data:{operation:{id:'op',title:'Importación sintética',status:'in_transit',estimated_arrival:'2026-10-20'},lines:[{id:'line',sku:'SKU-1',quantity:100}]},coverage:{complete:true,totalMatched:1,returned:1},...extra});
const doc=(id,date,net=100,tax='12345678-9',extra={})=>({id,entity_id:'entity',counterpart_tax_id:tax,counterpart_name:'Cliente sintético',issued_on:date,source_type:'FACTO',document_type:'sales_invoice',currency:'CLP',net_amount:net,tax_amount:net*.19,total_clp:net*1.19,exempt_amount:0,status:'validated',data_quality:'validated',...extra});
const prior=[doc('a','2026-08-04'),doc('b','2026-08-10'),doc('c','2026-08-20')];
test('Ventanas iguales, sin hoy, fin de mes y año bisiesto',()=>{
 assert.deepEqual(comparablePurchaseWindows(today),{days:30,current:range,previous:{from:'2026-08-02',to:'2026-08-31'}});
 const w=comparablePurchaseWindows('2024-03-01',7);assert.equal(w.current.to,'2024-02-29');assert.equal(Date.parse(w.current.to)-Date.parse(w.current.from),6*86400000);
});
test('Caída reproducible con compra previa en tres días; duplicados no aumentan actividad',()=>{
 const ds=[...prior,prior[0],doc('actual','2026-09-10',100)];const r=customerPurchaseSignals(ds,[],today,30,stamp,now).records[0];
 assert.equal(r.previousPurchases,300);assert.equal(r.currentPurchases,100);assert.equal(r.previousPurchaseDays,3);assert.equal(r.purchaseVariationPercent,-66.6667);assert.match(r.signal,/Caída/);assert.match(r.action,/No equivale a cliente perdido/);
});
test('Sin compra, muestra pequeña y sin base previa no significan cliente perdido',()=>{
 const missing=customerPurchaseSignals(prior,[],today,30,stamp,now).records[0];assert.match(missing.signal,/Sin compra en la ventana/);
 const small=customerPurchaseSignals(prior.slice(0,1),[],today,30,stamp,now).records[0];assert.match(small.signal,/Muestra pequeña/);
 const newCustomer=customerPurchaseSignals([doc('new','2026-09-04')],[],today,30,stamp,now).records[0];assert.equal(newCustomer.purchaseVariationPercent,null);assert.match(newCustomer.signal,/Sin base previa/);
 assert.equal(customerPurchaseSignals([],[],today,30,stamp,now).records.length,0);
});
test('NC reduce netos pero no inventa caída de compras ni nuevas visitas',()=>{
 const current=[doc('d','2026-09-03'),doc('e','2026-09-10'),doc('f','2026-09-20'),doc('nc','2026-09-21',250,'12345678-9',{document_type:'sales_credit_note'})];
 const r=customerPurchaseSignals([...prior,...current],[],today,30,stamp,now).records[0];assert.equal(r.currentNet,50);assert.equal(r.currentPurchases,300);assert.equal(r.purchaseVariationPercent,0);assert.equal(r.currentPurchaseDays,3);assert.equal(r.creditNotes,1);
});
test('RUT ambiguo, importes inválidos y fuente vieja impiden señal comercial afirmativa',()=>{
 const duplicate=[{id:'1',rut:'12345678-9'},{id:'2',rut:'12.345.678-9'}];const amb=customerPurchaseSignals(prior,duplicate,today,30,stamp,now).records[0];assert.equal(amb.purchaseVariationPercent,null);assert.match(amb.signal,/Identidad pendiente/);
 const invalid=customerPurchaseSignals([...prior,doc('bad','2026-09-10',100,'12345678-9',{currency:'USD'})],[],today,30,stamp,now).records[0];assert.equal(invalid.purchaseVariationPercent,null);assert.match(invalid.signal,/Importes pendientes/);
 for(const t of [null,'2020-01-01','2030-01-01'])assert.match(customerPurchaseSignals(prior,[],today,30,t,now).records[0].signal,/Verificar actualización/);
});
test('Cobertura stock es condicional, reservas desconocidas, no fecha de quiebre',()=>{
 const r=stockCoverageScenario(stock,sales,range,true,now);assert.equal(r.dailyInvoicedUnits,2);assert.equal(r.conditionalCoverageDays,10);assert.equal(r.reservations,null);assert.equal(r.physicalDepletionDate,null);
 assert.match(r.assumptions.join(' '),/no consumo físico/);assert.equal(stockCoverageScenario({...stock,stock:0},sales,range,true,now).conditionalCoverageDays,0);
});
test('No inventa velocidad con stock desconocido, viejo, advertencias, ventas parciales o poco historial',()=>{
 for(const r of [stockCoverageScenario(undefined,sales,range,true,now),stockCoverageScenario({...stock,stock:null},sales,range,true,now),stockCoverageScenario({...stock,stock_updated_at:'2020-01-01'},sales,range,true,now),stockCoverageScenario({...stock,stock_warnings:['conflicto']},sales,range,true,now),stockCoverageScenario(stock,sales,range,false,now),stockCoverageScenario(stock,[sales[0],sales[0]],range,true,now),stockCoverageScenario(stock,[{...sales[0],document_count:1}],range,true,now),stockCoverageScenario(stock,[],range,true,now)]){assert.equal(r.conditionalCoverageDays,null);assert.ok(r.missing);}
});
test('Importación exacta conserva ETA estimada y no suma mercancía al stock',()=>{
 const r=incomingForSku(detail(),'SKU-1',today,10,now);assert.equal(r.plannedQuantity,100);assert.equal(r.daysUntilEstimatedArrival,19);assert.match(r.comparison,/Escenario: cobertura menor/);
 assert.equal(incomingForSku(detail(),'SKU-X',today,10,now).plannedQuantity,null);
});
test('ETA vencida/ausente, fecha vieja, líneas duplicadas y páginas incompletas no confirman reposición',()=>{
 for(const eta of [null,'2026-09-20','2026-02-31']){const d=detail();d.data.operation.estimated_arrival=eta;assert.match(incomingForSku(d,'SKU-1',today,10,now).comparison,/Sin ETA|ETA vencida/);}
 const duplicate=detail();duplicate.data.lines.push({...duplicate.data.lines[0]});assert.equal(incomingForSku(duplicate,'SKU-1',today,10,now).plannedQuantity,null);
 const partial=detail({coverage:{complete:true,totalMatched:101,returned:100}});assert.equal(incomingForSku(partial,'SKU-1',today,10,now).plannedQuantity,null);
 const stale=detail({freshness:{sourceObservedAt:'2020-01-01'}});assert.match(incomingForSku(stale,'SKU-1',today,10,now).comparison,/sin actualización reciente/);
});
test('Composición respeta permisos y reporta fallos sin afirmar ausencia de importaciones',async()=>{
 const calls=[];const run=async(name,args)=>{calls.push({name,args});if(name==='search_products')return result(name,[stock]);if(name==='get_top_products')return result(name,sales,{data:{records:sales,period:range}});return result(name,[],{status:'forbidden',coverage:{complete:false,totalMatched:null,returned:0}});};
 const finance=await stockOutlookTool(run,{query:'SKU-1'},false,new Date(now));assert.equal(calls.length,2);assert.match(finance.data.importsScope,/no tiene permiso/);assert.equal(finance.data.scenario.conditionalCoverageDays,10);
 calls.length=0;const admin=await stockOutlookTool(run,{query:'SKU-1'},true,new Date(now));assert.equal(calls.length,3);assert.match(admin.data.importsScope,/forbidden/);assert.equal(admin.data.incoming.length,0);
});
test('Fechas de ventas antiguas y SKU ambiguo bloquean escenario',async()=>{
 const old=await stockOutlookTool(async name=>name==='search_products'?result(name,[stock]):result(name,sales,{data:{records:sales,period:range},freshness:{sourceObservedAt:'2020-01-01'}}),{query:'SKU-1'},false,new Date(now));assert.equal(old.data.scenario.conditionalCoverageDays,null);assert.match(old.data.scenario.missing,/Ventas sin fecha/);
 let calls=0;const amb=await stockOutlookTool(async name=>{calls++;return result(name,[stock,stock]);},{query:'SKU-1'},true,new Date(now));assert.equal(amb.status,'needs_clarification');assert.equal(calls,1);
});
test('Solo herramientas existentes y lecturas; mismo cálculo después de recuperar fuente',async()=>{
 const calls=[];const source={entity:async()=> 'entity',all:async p=>{calls.push(p);return p.startsWith('integration_connections')?[{last_success_at:stamp}]:p.startsWith('companies')?[]:prior;}};
 const r=await customerPurchaseSignalsTool(source,{limit:10},new Date(now));assert.equal(calls.length,3);assert.equal(r.table.rows.length,1);assert.equal(r.data.windows.days,30);
 await assert.rejects(customerPurchaseSignalsTool({...source,all:async()=>{throw Error('sin red');}},{},new Date(now)),/sin red/);
 const recovered=await customerPurchaseSignalsTool(source,{},new Date(now));assert.equal(recovered.table.rows[0].previousPurchases,r.table.rows[0].previousPurchases);
});
test('Permisos niegan nuevas herramientas antes de leer; se reutilizan especialistas',async()=>{
 for(const role of ['vendedor','visualizador']){let reads=0;const registry=new ToolRegistry({actor:{role},all:async()=>{reads++;return[];}});for(const name of ['get_stock_outlook','get_customer_purchase_signals'])assert.equal((await registry.execute(name,{})).status,'forbidden');assert.equal(reads,0);}
 assert.ok(specialists.find(s=>s.id==='commercial').tools.includes('get_customer_purchase_signals'));assert.ok(specialists.find(s=>s.id==='logistics').tools.includes('get_stock_outlook'));
});

test('Preserva supuestos canónicos y no oculta otras fuentes; stock negativo no es cero',()=>{
 const r=result('get_stock_outlook',[],{status:'partial',summary:'Escenario condicionado; no garantiza quiebre ni ETA.'});assert.equal(canonicalOperationalOutlookMessage([r]),r.summary);assert.equal(canonicalOperationalOutlookMessage([r,result('otra_fuente',[])]),null);
 assert.equal(stockCoverageScenario({...stock,stock:-2},sales,range,true,now).conditionalCoverageDays,null);
 const companies=[{id:'same',rut:'12345678-9',name:'Única'}];const client=customerPurchaseSignals(prior,[...companies,...companies],today,30,stamp,now).records[0];assert.notEqual(client.signal,'Identidad pendiente');
});

test('Fallo de fuente no pide corregir SKU ni se convierte en stock cero',async()=>{
 let reads=0;const r=await stockOutlookTool(async name=>{reads++;return result(name,[],{status:'unavailable'});},{query:'SKU-1'},true,new Date(now));assert.equal(r.status,'unavailable');assert.equal(reads,1);assert.match(r.summary,/No se pudo consultar stock/);assert.match(r.summary,/no se interpreta como cero/);
});
