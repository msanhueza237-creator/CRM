import {test} from 'node:test';import assert from 'node:assert/strict';
import {currentQuoteSession,customerFromQuoteMessages,quoteCustomerMissing,wantsFormalQuote} from '../supabase/functions/_shared/whatsapp-quote-flow.ts';
import {deriveQuoteLines} from '../supabase/functions/_shared/whatsapp-quote-context.ts';
const m=(body,n,direction='inbound')=>({body,direction,status:direction==='inbound'?'received':'accepted',occurredAt:new Date(1000000+n*1000).toISOString()});
test('generic pricing differs from explicit formal/PDF request',()=>{
 assert.equal(wantsFormalQuote('me puedes cotizar una balanza digital'),false);assert.equal(wantsFormalQuote('Quiero una cotización formal'),true);assert.equal(wantsFormalQuote('Necesito el PDF'),true);assert.equal(wantsFormalQuote('no quiero cotización formal'),false);
});
test('customer data must be supplied by inbound messages and a valid RUT',()=>{
 const outbound=m('RUT 15427713-7 Falso. Otra dirección. Otra comuna',0,'outbound');assert.equal(quoteCustomerMissing(customerFromQuoteMessages([outbound])).length,4);
 const messages=[m('RUT: 15427713-7',1),m('Nombre: Cliente Prueba',2),m('Dirección: Calle Prueba 100',3),m('Comuna: Lo Prado',4)];assert.deepEqual(customerFromQuoteMessages(messages),{rut:'15427713-7',name:'Cliente Prueba',address:'Calle Prueba 100',commune:'Lo Prado'});assert.deepEqual(quoteCustomerMissing(customerFromQuoteMessages(messages)),[]);
});
test('one message with RUT, name, address and commune is extracted without mixing seller data',()=>{
 const c=customerFromQuoteMessages([m('RUT 15427713-7 Marco Prueba. Los Alamos 6719. Lo Prado',0)]);assert.equal(c.address,'Los Alamos 6719');assert.equal(c.commune,'Lo Prado');assert.deepEqual(quoteCustomerMissing(c),[]);
});
test('new Hola starts a fresh quote session, excluding previous customer and products',()=>{
 const messages=[m('RUT 15427713-7 Marco Prueba. Calle 100. Lo Prado',0),m('Elegiste Soporte de muro (código WALL). ¿Cuántas unidades quieres?',1,'outbound'),m('2',2),m('Quiero cotización formal',3),m('Hola',4),m('me puedes cotizar una balanza digital',5)];
 const session=currentQuoteSession(messages);assert.equal(session.length,2);assert.equal(customerFromQuoteMessages(session).rut,'');assert.equal(deriveQuoteLines(messages,[{sku:'WALL',name:'Soporte de muro'}]).lines.length,0);
});

test('a different product request cannot reuse the previous selected model',()=>{
 const history=[m('Elegiste Soporte de muro (código WALL). ¿Cuántas unidades quieres?',0,'outbound'),m('2',1),m('quiero cotización formal por una balanza digital',2)];
 const result=deriveQuoteLines(history,[{sku:'WALL',name:'Soporte de muro'},{sku:'DS100',name:'Balanza digital DS100'}]);assert.equal(result.lines.length,0);
});
test('cotices with RUT is formal and five de estas retains the sole offered pump',()=>{
 const text='quiero que me cotices 5 de estas bombas\naca te dejo los datos\n15427713-7\nMarco Sanhueza\nlos alamos 6719\nlo prado';const history=[m('Bomba de condensado Mute coner\nCódigo: Mute corner 20L/H',0,'outbound'),m(text,1)];
 assert.equal(wantsFormalQuote(text),true);assert.equal(wantsFormalQuote('me cotices una bomba'),false);const r=deriveQuoteLines(history,[{sku:'Mute corner 20L/H',name:'Bomba de condensado Mute coner'}]);assert.deepEqual(r.lines,[{sku:'Mute corner 20L/H',name:'Bomba de condensado Mute coner',quantity:5}]);assert.equal(r.quantityConfirmed,true);assert.deepEqual(quoteCustomerMissing(customerFromQuoteMessages(history)),[]);
});
