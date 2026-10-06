import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {productText,fetchPublicProduct} from '../supabase/functions/market-study/public-source.ts';
import {marketSite} from '../supabase/functions/_shared/market-native-contract.ts';
import {nativeStudy} from '../supabase/functions/market-study/native-study.ts';
import {createMarketHandler} from '../supabase/functions/market-study/handler.ts';
import {encryptApiKey} from '../supabase/functions/prospecting-integrations/deepseek.ts';
const actor='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222';
const url='https://www.moretoclima.cl/producto-sintetico';
const html='<html><body><main><h1>Producto de prueba</h1><p>Precio con IVA 19%</p></main><script type="application/ld+json">'+JSON.stringify({'@type':'Product',name:'Producto de prueba',description:'Herramienta sin datos personales',sku:'SYN-1',offers:{'@type':'Offer',price:'11900',priceCurrency:'CLP',availability:'https://schema.org/InStock'}})+'</script><footer>Contacto privado@example.com</footer></body></html>';
const json=v=>new Response(JSON.stringify(v),{headers:{'content-type':'application/json'}});
const selection={choice:'deepseek:deepseek-flash',provider:'deepseek',model:'deepseek-flash',input_usd_per_million:.3,output_usd_per_million:1.2,rate_checked_at:'2026-10-03',rate_source:'fixture'};
test('Fuentes publicas: host exacto, HTTPS, sin credenciales, parametros ni red privada',()=>{
 assert.equal(marketSite(url).site.name,'MoretoClima');
 for(const bad of ['http://www.moretoclima.cl/a','https://localhost/a','https://127.0.0.1/a','https://moretoclima.cl.evil.example/a','https://x@moretoclima.cl/a','https://moretoclima.cl/a?token=x','https://moretoclima.cl/login','https://moretoclima.cl:9443/a'])assert.throws(()=>marketSite(bad));
});
test('DOM: ficha individual sin ejecutar scripts; no mezcla variantes/productos ni contactos',()=>{
 const text=productText(html);assert.match(text,/Producto de prueba/);assert.match(text,/11900/);assert.match(text,/CLP/);assert.doesNotMatch(text,/privado@example/);
 assert.throws(()=>productText(html.replace('</body>','<script type="application/ld+json">{"@type":"Product"}</script></body>')),/varios productos/);
 assert.throws(()=>productText(html.replace('"@type":"Offer"','"@type":"AggregateOffer"')),/variantes/);
 assert.throws(()=>productText('<html><body><h1>A</h1><h1>B</h1></body></html>'),/individual/);
});
test('Lectura respeta robots, desafios, tamano, redirecciones; no envia cookies ni autorizacion',async()=>{
 const seen=[];const send=async(u,o)=>{seen.push(u);assert.equal(o.redirect,'manual');assert.equal(o.headers.Authorization,undefined);assert.equal(o.headers.Cookie,undefined);return String(u).endsWith('robots.txt')?new Response('User-agent: *\nDisallow: /'):new Response(html,{headers:{'content-type':'text/html'}});};
 await assert.rejects(fetchPublicProduct(url,send),/no permite/);assert.equal(seen.length,1);
 const mock=(status,body=html)=>async u=>String(u).endsWith('robots.txt')?new Response('',{status:404}):new Response(body,{status,headers:{'content-type':'text/html'}});
 await assert.rejects(fetchPublicProduct(url,mock(302)),/redirige/);
 await assert.rejects(fetchPublicProduct(url,mock(200,'<title>Just a moment</title>')),/verificacion/);
 await assert.rejects(fetchPublicProduct(url,mock(200,'x'.repeat(1500001))),/tamano/);
 assert.match((await fetchPublicProduct(url,mock(200))).text,/11900/);
});
test('SQL: permisos, presupuesto diario atomico, concurrencia, idempotencia y reservas inciertas',async()=>{
 const db=new PGlite();try{
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create table profiles(id uuid primary key,role text,active boolean);insert into profiles values('${actor}','administrador',true);grant select on profiles to service_role;create table market_extraction_policy(revision int,choice text);insert into market_extraction_policy values(1,'deepseek:deepseek-flash');grant select on market_extraction_policy to service_role;`);
 const ddl=await readFile(new URL('../supabase/market_native_studies.sql',import.meta.url),'utf8');await db.exec(ddl);
 const call=async(action,p={},who=actor)=>(await db.query('select market_native_run($1,$2,$3) r',[who,action,JSON.stringify(p)])).rows[0].r;
 const data={id,hash:'a'.repeat(64),sku:'SYN-1',url,revision:1,selection};
 await db.exec('set role service_role');const first=await call('reserve',data);assert.equal(first.created,true);assert.ok(first.ticket);assert.equal(first.job.ticket,undefined);
 assert.equal((await call('reserve',data)).created,false);await assert.rejects(call('reserve',{...data,hash:'b'.repeat(64)}),/identity conflict/);
 await assert.rejects(call('reserve',{...data,id:crypto.randomUUID()}),/Another study/);
 const done=await call('finish',{id,ticket:first.ticket,state:'unknown',cost:null,result:{error:'Interrupted'}});assert.equal(done.state,'unknown');assert.equal(done.ticket,undefined);
 assert.equal((await call('reserve',data)).job.state,'unknown');let status=await call('status');assert.equal(status.jobs_today,1);assert.equal(Number(status.spent_usd),Number(first.job.reserved_usd));
 await assert.rejects(call('reserve',{...data,id:crypto.randomUUID(),revision:9}),/selection changed/);
 await db.exec('reset role');await db.exec('update market_native_policy set daily_usd=0.011');await db.exec('set role service_role');
 await assert.rejects(call('reserve',{...data,id:crypto.randomUUID()}),/budget reached/);
 await db.exec('reset role');await db.exec('update market_native_policy set daily_usd=.25');await db.exec('set role service_role');
 const next=await call('reserve',{...data,id:crypto.randomUUID()});
 await assert.rejects(call('finish',{id:next.job.id,ticket:crypto.randomUUID(),state:'completed',cost:0,result:{}}),/receipt unavailable/);
 await assert.rejects(call('finish',{id:next.job.id,ticket:next.ticket,state:'completed',cost:1,result:{}}),/Invalid study charge/);
 await db.exec('reset role');await db.exec("update market_native_jobs set created_at=now()-interval '3 minutes' where state='running'");await db.exec('set role service_role');status=await call('status');assert.equal(status.jobs.find(j=>j.id===next.job.id).state,'unknown');
 await db.exec('reset role');for(const role of ['anon','authenticated']){await db.exec('set role '+role);await assert.rejects(call('status'),/permission denied/);await assert.rejects(db.query('select * from market_native_jobs'),/permission denied/);await db.exec('reset role');}
 await db.exec(`update profiles set active=false where id='${actor}';set role service_role`);await assert.rejects(call('status'),/Forbidden/);
 }finally{await db.close();}
});
async function fixture({invalid=false,replay=false,blocked=false}={}) {
 const secret='test-secret-not-real-32-characters-long',encrypted=await encryptApiKey('synthetic-key-only-not-real',secret),calls=[],writes=[];
 const job={id,sku:'SYN-1',source_url:url,reserved_usd:.0102288,selection,state:'running'};
 const ctx={url:'https://fixture.invalid',serviceRoleKey:'synthetic-service',readEnv:k=>({PROSPECTING_SECRET_ENCRYPTION_KEY:secret}[k]),fetcher:async(u,o)=>{
  calls.push({url:String(u),body:o?.body});
  if(String(u).includes('prospecting_ai_integrations'))return json([{status:'verified',models:['deepseek-flash'],api_key_encrypted:encrypted}]);
  if(String(u).includes('market_extraction_policy'))return json([{revision:1,choice:selection.choice}]);
  if(String(u).endsWith('/robots.txt'))return new Response(blocked?'User-agent: *\nDisallow: /':'',{status:200});
  if(String(u)===url)return new Response(html,{headers:{'content-type':'text/html'}});
  if(String(u)==='https://api.deepseek.com/responses')return json({status:'completed',output:[],output_text:JSON.stringify({attributes:[{field:'title',value:invalid?'Inventado':'Producto de prueba',quote:'Producto de prueba'}]}),usage:{input_tokens:500,output_tokens:80}});
  throw Error('Unexpected network');
 }};
 const rpc=async(name,args)=>{assert.equal(name,'market_native_run');assert.equal(args.p_actor,actor);writes.push(args);if(args.p_action==='status')return {enabled:true,jobs:[]};if(args.p_action==='reserve')return {created:!replay,job:replay?{...job,state:'completed'}:job,ticket:id};if(args.p_action==='finish')return {...job,state:args.p_data.state,result:args.p_data.result,estimated_usd:args.p_data.cost};throw Error('Unexpected RPC');};
 const result=await nativeStudy({id,sku:'SYN-1',url,revision:1},ctx,rpc,actor);return {result,calls,writes};
}
test('DeepSeek nativo: reserva antes del modelo, evidencia literal, no costos internos ni herramientas',async()=>{
 const {result,calls,writes}=await fixture();assert.equal(result.state,'completed');assert.equal(result.result.attributes[0].value,'Producto de prueba');assert.ok(result.estimated_usd>0);
 assert.deepEqual(writes.map(w=>w.p_action),['status','reserve','finish']);const request=JSON.parse(calls.find(c=>c.url==='https://api.deepseek.com/responses').body);assert.deepEqual(request.tools,[]);assert.equal(request.model,'deepseek-flash');assert.doesNotMatch(request.input[0].content,/synthetic-key|privado@example|costo interno/);
});
test('No reintenta resultados previos ni inventados; bloqueo de fuente no cobra IA',async()=>{
 const previous=await fixture({replay:true});assert.equal(previous.calls.some(c=>c.url.includes('api.deepseek')),false);assert.equal(previous.writes.some(w=>w.p_action==='finish'),false);
 const bad=await fixture({invalid:true});assert.equal(bad.result.state,'unknown');assert.equal(bad.result.result.attributes,undefined);assert.equal(bad.calls.filter(c=>c.url.includes('api.deepseek')).length,1);
 const blocked=await fixture({blocked:true});assert.equal(blocked.result.state,'failed');assert.equal(blocked.result.estimated_usd,0);assert.equal(blocked.calls.some(c=>c.url.includes('api.deepseek')),false);
});
test('Endpoint nuevo exige administrador autenticado antes de reservar o consultar sitios',async()=>{
 for(const scenario of ['anon','inactive','viewer']){
 const calls=[],handler=createMarketHandler({rest:{url:'https://fixture.invalid',anonKey:'anon',serviceRoleKey:'service'},origin:'https://crm.example'},async u=>{calls.push(String(u));if(String(u).includes('/auth/v1/user'))return json({id:actor});if(String(u).includes('profiles?'))return json([{role:scenario==='viewer'?'visualizador':'administrador',active:scenario!=='inactive'}]);throw Error('Unexpected call');});
 const response=await handler(new Request('https://fixture.invalid/functions/v1/market-study/studies',{method:'POST',headers:scenario==='anon'?{}:{Authorization:'Bearer synthetic'},body:'{}'}));assert.equal(response.status,scenario==='anon'?401:403);assert.ok(calls.every(c=>c.includes('profiles?')||c.includes('/auth/v1/user')));
 }
});
test('Bootstrap usa import_shipments real y consulta el detalle de transito con la sesion humana',async()=>{
 const calls=[],handler=createMarketHandler({rest:{url:'https://fixture.invalid',anonKey:'anon',serviceRoleKey:'service'},origin:'https://crm.example'},async(u,o)=>{
  calls.push(String(u));if(String(u).includes('/auth/v1/user'))return json({id:actor});if(String(u).includes('profiles?'))return json([{role:'administrador',active:true}]);
  if(String(u).includes('import_shipments?'))return new Response(JSON.stringify([{id}]),{headers:{'Content-Range':'0-0/1'}});
  if(String(u).endsWith('/rpc/foreign_trade_operation_detail')){assert.equal(o.headers.Authorization,'Bearer synthetic');return json({operation:{id,inventory_mode:'future'},lines:[],costs:[],scenarios:[]});}
  return new Response('[]',{headers:{'Content-Range':'*/0'}});
 });
 const response=await handler(new Request('https://fixture.invalid/functions/v1/market-study/bootstrap',{headers:{Authorization:'Bearer synthetic'}})),body=await response.json();
 assert.equal(response.status,200);assert.equal(body.importsComplete,true);assert.equal(body.imports[0].operation.id,id);assert.ok(calls.some(c=>c.includes('import_shipments?')));assert.ok(calls.some(c=>c.includes('foreign_trade_cost_parameters?')));assert.deepEqual(body.costParameters,[]);assert.equal(calls.some(c=>c.includes('foreign_trade_operations?')),false);
});

test('Refresh solo admite ID del historial autenticado; no reserva gasto ni acepta URLs del cliente',async()=>{
 const calls=[],job={id,sku:'HT816',state:'completed',result:{kind:'market_search',offers:[]}};
 const handler=createMarketHandler({rest:{url:'https://fixture.invalid',anonKey:'anon',serviceRoleKey:'service'},origin:'https://crm.example'},async(u,o)=>{
  if(String(u).includes('/auth/v1/user'))return json({id:actor});if(String(u).includes('profiles?'))return json([{role:'administrador',active:true}]);
  if(String(u).endsWith('/rpc/market_native_run')){calls.push(JSON.parse(o.body));return json({jobs:[job]});}throw Error('Unexpected call');
 });
 const call=(body,auth=true)=>handler(new Request('https://fixture.invalid/functions/v1/market-study/sources/refresh',{method:'POST',headers:auth?{Authorization:'Bearer synthetic'}:{},body:JSON.stringify(body)}));
 assert.equal((await call({id},false)).status,401);assert.equal((await call({id,url:'https://bad.cl/'})).status,422);assert.equal(calls.length,0);
 assert.equal((await call({id:crypto.randomUUID()})).status,404);const r=await call({id});assert.equal(r.status,200);assert.ok((await r.json()).result.refreshed_at);assert.ok(calls.every(c=>c.p_action==='status'));assert.equal(job.result.refreshed_at,undefined);
});

test('Bootstrap enlaza descripcion publica por SKU; no mezcla descripciones contradictorias',async()=>{
 let ambiguous=false;
 const handler=createMarketHandler({rest:{url:'https://fixture.invalid',anonKey:'anon',serviceRoleKey:'service'},origin:'https://crm.example'},async u=>{
  const path=String(u);
  if(path.includes('/auth/v1/user'))return json({id:actor});
  if(path.includes('profiles?'))return json([{role:'administrador',active:true}]);
  if(path.includes('accounting_entities?select=id'))return json([{id}]);
  if(path.includes('content_products?')){
   const product={id,sku:'DIF-10',name:'Difusor circular',brand:'Ejemplo',description_text:'Aluminio 10 pulgadas. Costo: 19000 CLP',source_status:'active'};
   return new Response(JSON.stringify(ambiguous?[product,{...product,id:actor,description_text:'Modelo 12 pulgadas'}]:[product]),{headers:{'Content-Range':ambiguous?'0-1/2':'0-0/1'}});
  }
  return new Response('[]',{headers:{'Content-Range':'*/0'}});
 });
 const read=async()=>{const response=await handler(new Request('https://fixture.invalid/functions/v1/market-study/bootstrap',{headers:{Authorization:'Bearer synthetic'}}));assert.equal(response.status,200);return response.json();};
 let data=await read();assert.equal(data.inventoryAvailable,true);assert.equal(data.inventory[0].description,'Aluminio 10 pulgadas.');
 ambiguous=true;data=await read();assert.equal(data.inventory[0].description,'');
});
