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
test('greeting and unrelated URLs never query a provider; category uses bounded live reads',async()=>{
 for(const [text,action] of [['hola','draft'],['precio del manometro','clarify'],['precio LX1030 https://evil.example/product','clarify']]){const s=scenario(text);assert.equal((await run(s)).plan.action,action);assert.equal(s.calls.length,text==='precio del manometro'?1:0)}
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
test('customer phrase tienes corta tubos offers real catalog options without a false stock promise',async()=>{
 const s=scenario('tienes corta tubos ?');s.product.name='Corta tubo LT-274 1/8"-1-1/8" (3-28MM)';s.product.variants[0].sku=s.payload.variants[0].sku='LT-274';s.payload.name.es=s.product.name;
 const r=await run(s);assert.equal(r.plan.action,'clarify');assert.match(r.plan.text,/LT-274/);assert.doesNotMatch(r.plan.text,/disponibilidad|32.000|sin stock/);assert.equal(s.calls.length,1);
});

test('category links come from current Tiendanube canonical URL, never the old bare domain',async()=>{
 const s=scenario('tienes corta tubos');s.product.name=s.payload.name.es='Corta tubo LT-274';
 s.product.product_url='https://climactiva.cl/productos/viejo/';
 s.payload.canonical_url='https://www.climactiva.cl/productos/actual/';
 const r=await run(s);assert.match(r.plan.text,/https:\/\/www.climactiva.cl\/productos\/actual\//);
 assert.doesNotMatch(r.plan.text,/productos\/viejo/);assert.equal(s.calls.length,1);
});
test('missing canonical URL never falls back to the mirrored obsolete link',async()=>{
 const s=scenario();s.product.product_url='https://www.climactiva.cl/productos/viejo/';
 const r=await run(s);assert.equal(r.plan.action,'draft');assert.doesNotMatch(r.plan.text,/productos\/viejo/);
});
test('category provider failure does not offer stale links',async()=>{
 const s=scenario('tienes corta tubos');s.product.name='Corta tubo LT-274';
 const r=await run(s,async()=>new Response('',{status:503}));assert.equal(r.plan.reason,'live_catalog_unavailable');assert.equal(r.plan.text,null);
});

test('soporte de muro tendras resolves catalog models and their current links',async()=>{
 for(const verb of ['tendrás','tendrán','tendrías']){
  const s=scenario(`soporte de muro ${verb}?`);
  s.product.name=s.payload.name.es='Soporte Muro Plegable 450x390x1.5mm 9000 a 12000BTU kit instalacion';
  s.payload.canonical_url='https://www.climactiva.cl/productos/soporte-muro-plegable/';
  const r=await run(s);assert.equal(r.plan.action,'clarify');assert.match(r.plan.text,/Soporte Muro Plegable/);
  assert.match(r.plan.text,/https:\/\/www.climactiva.cl\/productos\/soporte-muro-plegable\//);assert.equal(s.calls.length,1);assert.equal(r.plan.canSend,false);
 }
});

function offer(s,status='accepted') {
 s.db.tables.whatsapp_messages.push({id:'offer',company_id:s.incoming.company_id,phone_number:s.incoming.phone_number,direction:'outbound',status,occurred_at:new Date(Date.now()-120000).toISOString(),body:'Encontré estos modelos en el catálogo:\n\n3. Manómetro R32\nCódigo: LX1030\nVer producto y comprar: https://www.climactiva.cl/productos/manometro/'});
}
test('number selected from sent offer asks quantity without pretending to add to cart',async()=>{
 const s=scenario('me interesa el número 3 me lo puedes agregar al carro de compras ?');offer(s);
 const r=await run(s);assert.equal(r.plan.reason,'purchase_quantity_required');assert.match(r.plan.text,/LX1030.*¿Cuántas unidades quieres/);
 assert.doesNotMatch(r.plan.text,/agregado|añadido/);assert.equal(s.calls.length,0);assert.equal(r.plan.canSend,false);
});
test('option numbers never resolve from a failed offer, another phone or unknown number',async()=>{
 for(const mode of ['failed','phone','number']){
  const s=scenario(mode==='number'?'el número 2':'el número 3');offer(s,mode==='failed'?'failed':'accepted');
  if(mode==='phone')s.db.tables.whatsapp_messages[1].phone_number='56999999999';
  assert.notEqual((await run(s)).plan.reason,'purchase_quantity_required');
 }
});

function quantityQuestion(s) {
 offer(s);s.db.tables.whatsapp_messages[1].body='Elegiste Manómetro R32 (código LX1030). ¿Cuántas unidades quieres?';
 s.payload.canonical_url='https://www.climactiva.cl/productos/manometro/';
}
test('quantity 2 follows the sent question with current subtotal and purchase link, no cart writes',async()=>{
 for(const text of ['2','quiero 2','2 unidades']){
  const s=scenario(text);quantityQuestion(s);const r=await run(s);
  assert.equal(r.plan.reason,'purchase_summary');assert.match(r.plan.text,/64.000 CLP/);assert.match(r.plan.text,/seleccionar 2 unidades/);
  assert.equal(s.calls.length,1);assert.equal(r.plan.canSend,false);
 }
});
test('quantity respects current stock and provider failures',async()=>{
 const s=scenario('3');quantityQuestion(s);assert.equal((await run(s)).plan.reason,'purchase_insufficient_stock');
 assert.equal((await run(s,async()=>new Response('',{status:503}))).plan.reason,'live_catalog_unavailable');
 const noContext=scenario('2');assert.notEqual((await run(noContext)).plan.reason,'purchase_summary');
});
