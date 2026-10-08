import assert from 'node:assert/strict';
import {test} from 'node:test';
import {scenario,run} from './whatsapp-automation-fixture.mjs';
test('full conversation to current Tiendanube variant to reviewable CLP draft; no writes/sends',async()=>{
 const s=scenario(),before=structuredClone(s.db.tables);const r=await run(s);
 assert.equal(r.messageId,'in1');assert.equal(r.plan.action,'draft');assert.match(r.plan.text,/32.000 CLP/);assert.doesNotMatch(r.plan.text,/34.500/);assert.equal(r.plan.canSend,false);assert.equal(s.calls.length,1);assert.deepEqual(s.db.tables,before);
});
test('store product link and full name follow the same current-data path',async()=>{
 for(const text of ['precio manometro R32','precio https://tienda.example/productos/manometro/?utm_source=test']){const s=scenario(text);assert.equal((await run(s)).plan.action,'draft');assert.equal(s.calls.length,1)}
});
test('zero current stock is explicit; unknown stock is handed to seller',async()=>{
 const s=scenario('stock LX1030');s.payload.variants[0].stock=0;assert.match((await run(s)).plan.text,/sin stock/);
 s.payload.variants[0].stock_management=false;assert.equal((await run(s)).plan.reason,'incomplete_product_evidence');
});
test('deleted, unpublished, replaced and duplicate variants never use an old price',async()=>{
 for(const edit of [p=>p.published=false,p=>p.id=999,p=>p.variants[0].id=999,p=>p.variants[0].sku='OTHER',p=>p.variants.push({...p.variants[0]})]){
  const s=scenario();edit(s.payload);const r=await run(s);assert.equal(r.plan.reason,'product_no_longer_available');assert.equal(r.plan.text,null);
 }
 const s=scenario();assert.equal((await run(s,async()=>new Response('',{status:404}))).plan.reason,'product_no_longer_available');
});
test('provider outages and unsafe responses fail closed even with a fresh local mirror',async()=>{
 for(const fetcher of [async()=>{throw Error('synthetic network failure')},async()=>new Response('synthetic private body',{status:401}),async()=>new Response('',{status:429}),async()=>new Response('html',{headers:{'content-type':'text/html'}}),async()=>new Response('not json',{headers:{'content-type':'application/json'}}),async()=>Response.json({padding:'x'.repeat(300000)})]){
  const s=scenario();s.product.source_updated_at=s.product.last_synced_at=new Date().toISOString();const r=await run(s,fetcher);assert.equal(r.plan.reason,'live_catalog_unavailable');assert.equal(r.plan.text,null);assert.equal(JSON.stringify(r).includes('private'),false);
 }
});
test('greeting, ambiguous SKU and unrelated URLs never query a provider',async()=>{
 for(const [text,action] of [['hola','draft'],['precio del manometro','clarify'],['precio LX1030 https://evil.example/product','clarify']]){const s=scenario(text);assert.equal((await run(s)).plan.action,action);assert.equal(s.calls.length,0)}
});
test('quote, tracking, seller, audio and image handoffs are explicit and do not query products',async()=>{
 for(const [text,requires] of [['cotizacion LX1030','facto_quote'],['seguimiento de pedido','verified_order'],['quiero vendedor','seller']]){const s=scenario(text);assert.equal((await run(s)).plan.requires,requires);assert.equal(s.calls.length,0)}
 for(const [type,requires] of [['audio','transcription'],['image','vision']]){const s=scenario();s.incoming.raw_payload.entry[0].changes[0].value.messages[0].type=type;const r=await run(s);assert.equal(r.plan.requires,requires);assert.equal(r.plan.text,null);assert.equal(s.calls.length,0)}
});
test('withdrawal and closed attention window inhibit any response or provider read',async()=>{
 const s=scenario('baja');assert.equal((await run(s)).plan.action,'ignore');assert.equal(s.calls.length,0);
 const closed=scenario();closed.incoming.raw_payload.entry[0].changes[0].value.messages[0].timestamp=String(Math.floor(Date.now()/1000)-86401);assert.equal((await run(closed)).plan.action,'ignore');assert.equal(closed.calls.length,0);
 const optedOut=scenario();optedOut.db.tables.companies[0].whatsapp_status='opt_out';assert.equal((await run(optedOut)).plan.action,'ignore');assert.equal(optedOut.calls.length,0);
});
test('already answered inbound cannot propose another response',async()=>{
 const s=scenario();s.db.tables.whatsapp_messages.push({id:'sent',company_id:s.incoming.company_id,phone_number:s.incoming.phone_number,direction:'outbound',occurred_at:new Date(Date.now()+1000).toISOString(),status:'read',body:'Respuesta'});assert.equal((await run(s)).plan.reason,'already_answered');assert.equal(s.calls.length,0);
});
test('credentials missing do not cause external requests or reveal configuration',async()=>{
 const s=scenario();const environment=keys=>keys.includes('TIENDANUBE_ACCESS_TOKEN')?'':s.env(keys);assert.equal((await run(s,s.fetcher,environment)).plan.reason,'live_catalog_unavailable');assert.equal(s.calls.length,0);
});
