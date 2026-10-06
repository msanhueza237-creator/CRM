import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {publicProductUrl} from '../supabase/functions/_shared/market-native-contract.ts';
import {publicIPv4,publicFetch} from '../supabase/functions/market-study/public-network.ts';
import {searchSources,webOffer,marketSearch,refreshMarketSources} from '../supabase/functions/market-study/market-search.ts';
import {productText} from '../supabase/functions/market-study/public-source.ts';
import {encryptApiKey} from '../supabase/functions/prospecting-integrations/deepseek.ts';
import {matchesMarketProduct,productFeatures,productNameQuery,publicProductDescription} from '../supabase/functions/_shared/market-product-search.ts';
const actor='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222';
const url='https://otra-tienda.cl/productos/ht-816';
const choice={choice:'deepseek:deepseek-flash',provider:'deepseek',model:'deepseek-flash',input_usd_per_million:.3,output_usd_per_million:1.2};
const json=v=>new Response(JSON.stringify(v),{headers:{'content-type':'application/json'}});
const payload={content:[{type:'server_tool_use',name:'web_search',input:{query:'HT816 precio Chile'}},{type:'web_search_tool_result',content:[{type:'web_search_result',url,title:'Termostato HT-816'}]},{type:'text',text:'https://inventado.cl/producto $123'}]};
test('Busqueda abierta no usa lista de ocho comercios; solo URLs de resultados reales',()=>{
 const found=searchSources(payload);assert.equal(found.sources[0].url,url);assert.equal(found.sources.length,1);
 assert.equal(publicProductUrl(url+'?utm_source=a&variant=4#stock').href,url+'?variant=4');
 assert.throws(()=>searchSources({content:[{type:'text',text:JSON.stringify(payload)}]}));
 assert.equal(searchSources({content:[...payload.content,{type:'web_search_tool_result',content:[{type:'web_search_result',url:'https://climactiva.cl/producto',title:'Propio'},{type:'web_search_result',url:url+'-2',title:'Repetido'}]}]}).sources.length,1);
});
test('Red publica: bloquea IP privadas, metadatos, IPv6, credenciales y rutas privadas',async()=>{
 for(const ip of ['127.0.0.1','10.3.4.5','172.20.1.1','192.168.1.1','169.254.169.254','100.64.0.1','0.0.0.0','224.0.0.1','198.18.0.1','::1','::ffff:127.0.0.1'])assert.equal(publicIPv4(ip),false,ip);
 assert.equal(publicIPv4('8.8.8.8'),true);
 for(const bad of ['http://tienda.cl/a','https://127.0.0.1/a','https://localhost/a','https://x.internal/a','https://name:password@tienda.cl/a','https://tienda.cl/api/key','https://tienda.cl/a?token=x'])assert.throws(()=>publicProductUrl(bad));
 await assert.rejects(publicFetch('https://localhost/a'));
 const source=await readFile(new URL('../supabase/functions/market-study/public-network.ts',import.meta.url),'utf8');assert.match(source,/lookup:[\s\S]*addresses\[0\].address/);assert.match(source,/agent:false/);assert.doesNotMatch(source,/rejectUnauthorized\s*:\s*false/);
});
test('Precios se leen de la ficha, no del texto del modelo; IVA/unidad desconocidos no se inventan',()=>{
 const facts={title:'Termostato HT-816',model:'HT-816',price:'11900',currency:'CLP',priceIncludesTax:true,availability:'https://schema.org/InStock'};
 const a=webOffer(url,'HT-816',JSON.stringify(facts)+'\nIVA 19% incluido. Precio por unidad','HT816','Termostato HT816',new Date().toISOString());
 assert.equal(a.amount,11900);assert.equal(a.currency,'CLP');assert.equal(a.vat,'gross');assert.equal(a.vat_percent,19);assert.equal(a.package_quantity,1);assert.equal(a.identity,'model_match');
 const b=webOffer(url,'HT-816','Precio 123','HT816','Termostato HT816',a.observed_at);assert.equal(b.amount,null);assert.equal(b.currency,null);assert.equal(b.vat,'unknown');assert.equal(b.package_quantity,null);
 const other=webOffer(url,'HT-8160',JSON.stringify({...facts,title:'HT-8160',model:'HT-8160'}),'HT816','Termostato HT816',a.observed_at);assert.equal(other.identity,'possible');
});
test('Cada busqueda reserva US$0,25: replay sin gasto nuevo, solo perfil publico al proveedor',async()=>{
 const secret='test-secret-for-encryption-not-real-32',encrypted=await encryptApiKey('synthetic-provider-key',secret),calls=[],writes=[];
 let replay=false;const job={id,sku:'HT816',source_url:url,state:'running',reserved_usd:.25,selection:choice};
 const ctx={url:'https://fixture.invalid',serviceRoleKey:'fixture-service',readEnv:k=>k==='PROSPECTING_SECRET_ENCRYPTION_KEY'?secret:undefined,fetcher:async(u,o)=>{
   calls.push({url:String(u),body:o?.body});if(String(u).includes('prospecting_ai_integrations'))return json([{status:'verified',models:['deepseek-flash'],api_key_encrypted:encrypted}]);
   if(String(u).includes('market_extraction_policy'))return json([{choice:choice.choice,revision:1}]);
   if(String(u)==='https://api.deepseek.com/anthropic/v1/messages')return json(payload);throw Error('Unexpected call');
 }};
 const rpc=async(_name,args)=>{writes.push(args);if(args.p_action==='status')return {web_search_supported:true};if(args.p_action==='reserve')return {created:!replay,job,ticket:id};if(args.p_action==='finish')return {...job,state:args.p_data.state,result:args.p_data.result,estimated_usd:args.p_data.cost};};
 const source=async(u,o)=>{assert.equal(o.headers.Authorization,undefined);return String(u).endsWith('robots.txt')?new Response('',{status:404}):new Response('<h1>HT-816</h1><script type="application/ld+json">'+JSON.stringify({'@type':'Product',name:'Termostato HT-816',model:'HT-816',offers:{'@type':'Offer',price:11900,priceCurrency:'CLP'}})+'</script>',{headers:{'content-type':'text/html'}});};
 const input={id,sku:'HT816',title:'Termostato HT816',description:'Control digital 220 V. Costo: 5000 CLP; Contacto ventas@privado.test',brand:'Ejemplo',revision:1};
 const result=await marketSearch(input,ctx,rpc,actor,source);
 assert.equal(result.state,'completed');assert.equal(result.result.offers[0].amount,11900);assert.equal(result.result.kind,'market_search');assert.equal(result.estimated_usd,null);
 assert.equal(writes.find(w=>w.p_action==='reserve').p_data.kind,'market_search');
 const request=JSON.parse(calls.find(c=>c.url.includes('/anthropic/')).body);assert.equal(request.tools[0].max_uses,3);assert.equal(request.model,'deepseek-flash');assert.deepEqual(JSON.parse(request.messages[0].content),{product:'Termostato',description:'Control digital 220 V.',brand:'Ejemplo',sku_reference:'HT816',market:'Chile'});
 assert.match(request.system,/Prioriza nombre, descripcion/);assert.match(request.system,/sin exigir marca ni codigo/);assert.match(request.system,/site:cl/);assert.doesNotMatch(request.messages[0].content,/5000|privado/);
 assert.equal(new URL(writes.find(w=>w.p_action==='reserve').p_data.url).searchParams.get('q'),'Termostato precio Chile');
 assert.equal(result.result.product_profile.description,'Control digital 220 V.');
 replay=true;await marketSearch(input,ctx,rpc,actor,source);assert.equal(calls.filter(c=>c.url.includes('/anthropic/')).length,1);
 for(const invalid of [{cost:12},{description:'x'.repeat(1801)},{brand:[]},{title:'   '}])await assert.rejects(marketSearch({...input,...invalid},ctx,rpc,actor,source));
});
test('Diez busquedas por dia de Chile: reserva atomica, once bloqueada e historial conservado',async()=>{
 const db=new PGlite();try{
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create table profiles(id uuid primary key,role text,active boolean);insert into profiles values('${actor}','administrador',true);grant select on profiles to service_role;create table market_extraction_policy(revision int,choice text);insert into market_extraction_policy values(1,'${choice.choice}');grant select on market_extraction_policy to service_role;`);
 const ddl=await readFile(new URL('../supabase/market_native_studies.sql',import.meta.url),'utf8');
 await db.exec(ddl);await db.exec('set role service_role');
 const call=async(action,data={})=>(await db.query('select market_native_run($1,$2,$3) r',[actor,action,JSON.stringify(data)])).rows[0].r;
 const data={id,hash:'a'.repeat(64),sku:'HT816',url,revision:1,selection:choice,kind:'market_search'};
 assert.equal((await call('status')).web_search_supported,true);const r=await call('reserve',data);assert.equal(Number(r.job.reserved_usd),.25);assert.equal((await call('reserve',data)).created,false);
 await assert.rejects(call('reserve',{...data,id:crypto.randomUUID()}),/Another study/);
 await call('finish',{id,ticket:r.ticket,state:'completed',cost:null,result:{kind:'market_search',offers:[]}});
 // Recreate the prior policy to exercise the same approved upgrade as production.
 await db.exec('reset role');
 const receipt=(await db.query('select to_jsonb(j) receipt from market_native_jobs j')).rows[0].receipt;
 await db.exec(`update market_native_policy set daily_usd=.25;alter table market_native_policy drop constraint market_native_policy_daily_usd_check;alter table market_native_policy add constraint market_native_policy_daily_usd_check check(daily_usd>0 and daily_usd<=.25);`);
 await db.exec(ddl);await db.exec(ddl);
 assert.deepEqual((await db.query('select to_jsonb(j) receipt from market_native_jobs j')).rows[0].receipt,receipt);
 await db.exec('set role service_role');
 let status=await call('status');assert.equal(Number(status.daily_usd),2.5);assert.equal(status.jobs_today,1);assert.equal(Number(status.spent_usd),.25);
 for(let i=2;i<=10;i++){
   const next=await call('reserve',{...data,id:crypto.randomUUID()});
   await call('finish',{id:next.job.id,ticket:next.ticket,state:i===2?'unknown':i===3?'failed':'completed',cost:0,result:{kind:'market_search',offers:[]}});
   status=await call('status');assert.equal(status.jobs_today,i);assert.equal(Number(status.spent_usd),i*.25);
 }
 await assert.rejects(call('reserve',{...data,id:crypto.randomUUID()}),/budget reached/);
 await assert.rejects(call('reserve',{...data,id:crypto.randomUUID(),kind:'source'}),/budget reached/);
 assert.equal((await call('reserve',data)).created,false);
 assert.equal(Number((await call('status')).spent_usd),2.5);
 await db.exec('reset role');await db.exec('update market_native_jobs set estimated_usd=0');await db.exec('set role service_role');
 await assert.rejects(call('reserve',{...data,id:crypto.randomUUID()}),/budget reached/);
 await db.exec('reset role');await db.exec('update market_native_jobs set estimated_usd=null');await db.exec('set role service_role');
 await db.exec('reset role');await assert.rejects(db.exec('update market_native_policy set daily_usd=2.51'),/check constraint/);
 await assert.rejects(db.exec('update market_native_policy set daily_jobs=11'),/check constraint/);
 await db.exec("update market_native_jobs set created_at=(date_trunc('day',now() at time zone 'America/Santiago') at time zone 'America/Santiago')-interval '1 second'");
 await db.exec('set role service_role');status=await call('status');assert.equal(status.jobs_today,0);assert.equal(Number(status.spent_usd),0);assert.equal(status.jobs.length,10);
 const nextDay=await call('reserve',{...data,id:crypto.randomUUID()});assert.equal(nextDay.created,true);
 await db.exec('reset role');await assert.rejects(db.exec(ddl),/market study is running/);await db.exec('rollback');
 assert.equal((await db.query('select count(*) n from market_native_jobs')).rows[0].n,11);
 }finally{await db.close();}
});

test('Prioriza .cl y descarta listados sin cambiar la busqueda a una lista cerrada',()=>{
 const p=structuredClone(payload);p.content[1].content=[
  {type:'web_search_result',url:'https://example-shop.com/product/a',title:'A'},
  {type:'web_search_result',url:'https://tienda.cl/index.php?route=product/search&tag=foo',title:'Busqueda'},
  {type:'web_search_result',url:'https://otra-tienda.cl/producto/a',title:'A'},
  {type:'web_search_result',url:'https://tercera.cl/search?q=abc',title:'Busqueda'}];
 assert.deepEqual(searchSources(p).sources.map(s=>new URL(s.url).hostname),['otra-tienda.cl','example-shop.com']);
});

test('IVA chileno supuesto es visible; neto explicito gana; modelos + y packs no se mezclan',()=>{
 const facts={title:'Amperimetro UT204+',singleProduct:true,price:11900,currency:'CLP'};
 const make=(f,extra='',sku='UT204+')=>webOffer(url,'',JSON.stringify(f)+'\n'+extra,sku,'Amperimetro '+sku,new Date().toISOString());
 const a=make(facts);assert.equal(a.vat,'gross');assert.equal(a.vat_percent,19);assert.equal(a.vat_assumed,true);assert.equal(a.package_assumed,true);assert.equal(a.identity,'model_match');
 assert.equal(make(facts,'Precio + IVA').vat,'net');assert.equal(make(facts,'IVA incluido y + IVA').vat,'unknown');
 assert.equal(make(facts,'','UT204').identity,'possible');assert.equal(make({...facts,title:'UT204'},'','UT204+').identity,'possible');assert.equal(make({...facts,title:'Kit UT204+'}).package_quantity,null);
 const foreign=webOffer('https://tienda.com/producto','',JSON.stringify({...facts,currency:'USD'}),'UT204+','Amperimetro UT204+',new Date().toISOString());assert.equal(foreign.vat,'unknown');assert.equal(foreign.vat_percent,null);
});

test('Extrae precio en OpenCart solo del producto elegido, concilia neto y descarta relacionados',()=>{
 const html='<div><h1>Amperimetro UT204+</h1><ul><li>Sin Stock</li><li><h2>$92,858</h2></li><li>Neto: $78,032</li></ul><div id="product">Cantidad <input name="quantity" value="1"></div></div><div class="related"><h2>$3,000</h2></div>';
 const t=productText(html,'https://tienda.cl/producto'),f=JSON.parse(t.split('\n')[0]);assert.equal(f.price,92858);assert.equal(f.currency,'CLP');assert.equal(f.priceIncludesTax,true);assert.match(f.availability,/OutOfStock/);assert.equal(f.currencyAssumed,true);
 assert.throws(()=>JSON.parse(productText(html.replace('$78,032','$1,000'),'https://tienda.cl/producto').split('\n')[0]));
 assert.throws(()=>JSON.parse(productText(html,'https://tienda.com/producto').split('\n')[0]));
});

test('Actualizar fuentes no llama IA ni cambia consulta original; fallos no reutilizan precios antiguos',async()=>{
 const original={id,sku:'HT816',state:'completed',result:{kind:'market_search',product_title:'Termostato HT816',offers:[webOffer(url,'HT816','', 'HT816','HT816',new Date().toISOString())]}};
 const before=JSON.stringify(original),calls=[];
 const updated=await refreshMarketSources(original,async u=>{calls.push(String(u));return String(u).endsWith('robots.txt')?new Response('',{status:404}):new Response('<h1>HT816</h1><script type="application/ld+json">'+JSON.stringify({'@type':'Product',name:'HT816',offers:{'@type':'Offer',price:11900,priceCurrency:'CLP'}})+'</script>',{headers:{'content-type':'text/html'}});});
 assert.equal(updated.result.offers[0].amount,11900);assert.ok(updated.result.refreshed_at);assert.equal(JSON.stringify(original),before);assert.ok(calls.every(u=>u.startsWith('https://otra-tienda.cl/')));
 const failed=await refreshMarketSources(updated,async()=>{throw Error('Fuente restringida');});assert.equal(failed.result.offers[0].amount,null);assert.equal(failed.result.offers[0].identity,'possible');
});

test('Descubre difusores por nombre y medidas aunque cambie el SKU; no confirma equivalencia',()=>{
 const make=(title,description='',sku='OTRO-10')=>webOffer(url,title,JSON.stringify({title,description,sku,price:11900,currency:'CLP',singleProduct:true}),'CD-R250+OBD','Difusor Circular 10"',new Date().toISOString(),{description:'Aluminio blanco. Conexion 10 pulgadas.'});
 const same=make('Difusor redondo de aire 10 pulgadas','Aluminio blanco');
 assert.equal(same.identity,'similar');assert.equal(same.amount,11900);assert.equal(same.package_quantity,1);assert.match(same.warning,/no equivalente/);assert.ok(same.match_reasons.some(s=>s.includes('10')));
 assert.equal(make('Difusor circular 12 pulgadas').identity,'different');
 assert.equal(make('Difusor circular 12 pulgadas','','CD-R250+OBD').identity,'different');
 assert.equal(make('Kit difusor circular 10 pulgadas').identity,'different');
 assert.equal(make('Difusor circular','Producto sin medida').identity,'similar');
 assert.ok(make('Difusor circular').match_reasons.some(s=>s.includes('Falta verificar')));
 assert.equal(make('Termostato digital 220 V').identity,'possible');
 const voltage=webOffer(url,'',JSON.stringify({title:'Termostato digital 110 V',sku:'TERM-220'}),'TERM-220','Termostato digital 220 V',new Date().toISOString());assert.equal(voltage.identity,'different');
});

test('Filtro local por palabras sin acentos, descripcion y SKU secundario; medidas convertibles',()=>{
 const p={sku:'CD-R250+OBD',name:'Difusor Circular 10"',description:'Aluminio con regulación de caudal',brand:'Ejemplo'};
 assert.equal(matchesMarketProduct(p,'regulacion aluminio'),true);assert.equal(matchesMarketProduct(p,'difusor circular'),true);assert.equal(matchesMarketProduct(p,'CD-R250'),true);assert.equal(matchesMarketProduct(p,'termostato'),false);
 assert.equal(productNameQuery('CD-R250+OBD Difusor Circular 10"',p.sku),'Difusor Circular 10"');
 assert.equal(productFeatures('10 pulgadas')[0].value,productFeatures('254 mm')[0].value);
 assert.equal(productFeatures('1/2 pulgadas')[0].value,12.7);
 assert.equal(publicProductDescription('Aluminio.\nCosto: 19000 CLP; margen:30%; token=abc; EXW 4.50; https://privado.test; ventas@local.cl'),'Aluminio.');
});
