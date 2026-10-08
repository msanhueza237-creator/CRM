import {test} from 'node:test';import assert from 'node:assert/strict';
import {deriveQuoteLines} from '../supabase/functions/_shared/whatsapp-quote-context.ts';
const products=[{sku:'WALL-A',name:'Soporte Muro Plegable 550mm'},{sku:'WALL-B',name:'Soporte muro pequeño'},{sku:'ROOF',name:'Soporte de techo 800mm'},{sku:'CUT',name:'Corta tubo'}];
const m=(direction,body,status='accepted',n=0)=>({direction,body,status,occurredAt:new Date(1000+n*1000).toISOString()});
test('quote restores earlier selected wall, quantity, and unique requested roof',()=>{
 const r=deriveQuoteLines([m('outbound','Elegiste Soporte Muro Plegable 550mm (código WALL-A). ¿Cuántas unidades quieres?'),m('inbound','2','received',1),m('inbound','cotización por 2 soportes de muro y 1 soporte de techo','received',2)],products);
 assert.deepEqual(r.lines.map(p=>[p.sku,p.quantity]),[['WALL-A',2],['ROOF',1]]);assert.deepEqual(r.unresolved,[]);
});
test('numbered choice resolves only against sent offer, not a failed offer',()=>{
 for(const status of ['accepted','failed']){
  const r=deriveQuoteLines([m('outbound','Encontré estos modelos en el catálogo:\n\n3. Soporte muro pequeño\nCódigo: WALL-B',status),m('inbound','me interesa el número 3','received',1),m('inbound','cotización por 2 soportes de muro','received',2)],products);
  assert.equal(r.lines.length,status==='accepted'?1:0);if(status==='accepted')assert.equal(r.lines[0].sku,'WALL-B');else assert.equal(r.unresolved.length,1);
 }
});
test('new quantity in quote request overrides older quantity and unrelated chosen items are excluded',()=>{
 const r=deriveQuoteLines([m('outbound','Elegiste Corta tubo (código CUT). ¿Cuántas unidades quieres?'),m('outbound','Elegiste Soporte muro pequeño (código WALL-B). ¿Cuántas unidades quieres?', 'sent',1),m('inbound','quiero 3','received',2),m('inbound','cotizar 2 soportes de muro','received',3)],products);
 assert.deepEqual(r.lines.map(p=>[p.sku,p.quantity]),[['WALL-B',2]]);
});
test('ambiguous generic models and withdrawn selections are never silently chosen',()=>{
 const r=deriveQuoteLines([m('outbound','Elegiste Soporte muro pequeño (código WALL-B). ¿Cuántas unidades quieres?'),m('inbound','no quiero ese','received',1),m('inbound','cotización por 2 soportes de muro','received',2)],products);
 assert.equal(r.lines.length,0);assert.equal(r.unresolved.length,1);
});
