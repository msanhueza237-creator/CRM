import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {publicProductUrl} from '../supabase/functions/_shared/market-native-contract.ts';
import {publicIPv4,publicFetch} from '../supabase/functions/market-study/public-network.ts';
import {searchSources,webOffer,marketSearch} from '../supabase/functions/market-study/market-search.ts';
import {encryptApiKey} from '../supabase/functions/prospecting-integrations/deepseek.ts';
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
test('Una sola busqueda: reserva diaria completa, replay sin gasto nuevo, solo SKU/nombre al proveedor',async()=>{
 const secret='test-secret-for-encryption-not-real-32',encrypted=await encryptApiKey('synthetic-provider-key',secret),calls=[],writes=[];
 let replay=false;const job={id,sku:'HT816',source_url:url,state:'running',reserved_usd:.25,selection:choice};
 const ctx={url:'https://fixture.invalid',serviceRoleKey:'fixture-service',readEnv:k=>k==='PROSPECTING_SECRET_ENCRYPTION_KEY'?secret:undefined,fetcher:async(u,o)=>{
   calls.push({url:String(u),body:o?.body});if(String(u).includes('prospecting_ai_integrations'))return json([{status:'verified',models:['deepseek-flash'],api_key_encrypted:encrypted}]);
   if(String(u).includes('market_extraction_policy'))return json([{choice:choice.choice,revision:1}]);
   if(String(u)==='https://api.deepseek.com/anthropic/v1/messages')return json(payload);throw Error('Unexpected call');
 }};
 const rpc=async(_name,args)=>{writes.push(args);if(args.p_action==='status')return {web_search_supported:true};if(args.p_action==='reserve')return {created:!replay,job,ticket:id};if(args.p_action==='finish')return {...job,state:args.p_data.state,result:args.p_data.result,estimated_usd:args.p_data.cost};};
 const source=async(u,o)=>{assert.equal(o.headers.Authorization,undefined);return String(u).endsWith('robots.txt')?new Response('',{status:404}):new Response('<h1>HT-816</h1><script type="application/ld+json">'+JSON.stringify({'@type':'Product',name:'Termostato HT-816',model:'HT-816',offers:{'@type':'Offer',price:11900,priceCurrency:'CLP'}})+'</script>',{headers:{'content-type':'text/html'}});};
 const result=await marketSearch({id,sku:'HT816',title:'Termostato HT816',revision:1},ctx,rpc,actor,source);
 assert.equal(result.state,'completed');assert.equal(result.result.offers[0].amount,11900);assert.equal(result.result.kind,'market_search');assert.equal(result.estimated_usd,null);
 assert.equal(writes.find(w=>w.p_action==='reserve').p_data.kind,'market_search');
 const request=JSON.parse(calls.find(c=>c.url.includes('/anthropic/')).body);assert.equal(request.tools[0].max_uses,3);assert.equal(request.model,'deepseek-flash');assert.deepEqual(JSON.parse(request.messages[0].content),{sku:'HT816',product:'Termostato HT816',market:'Chile'});
 replay=true;await marketSearch({id,sku:'HT816',title:'Termostato HT816',revision:1},ctx,rpc,actor,source);assert.equal(calls.filter(c=>c.url.includes('/anthropic/')).length,1);
});
test('Presupuesto persistente: busqueda reserva US$0,25 y bloquea nuevas consultas de ambos modos',async()=>{
 const db=new PGlite();try{
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create table profiles(id uuid primary key,role text,active boolean);insert into profiles values('${actor}','administrador',true);grant select on profiles to service_role;create table market_extraction_policy(revision int,choice text);insert into market_extraction_policy values(1,'${choice.choice}');grant select on market_extraction_policy to service_role;`);
 await db.exec(await readFile(new URL('../supabase/market_native_studies.sql',import.meta.url),'utf8'));await db.exec('set role service_role');
 const call=async(action,data={})=>(await db.query('select market_native_run($1,$2,$3) r',[actor,action,JSON.stringify(data)])).rows[0].r;
 const data={id,hash:'a'.repeat(64),sku:'HT816',url,revision:1,selection:choice,kind:'market_search'};
 assert.equal((await call('status')).web_search_supported,true);const r=await call('reserve',data);assert.equal(Number(r.job.reserved_usd),.25);assert.equal((await call('reserve',data)).created,false);
 await call('finish',{id,ticket:r.ticket,state:'completed',cost:null,result:{kind:'market_search',offers:[]}});
 await assert.rejects(call('reserve',{...data,id:crypto.randomUUID()}),/Daily search/);
 await assert.rejects(call('reserve',{...data,id:crypto.randomUUID(),kind:'source'}),/budget reached/);
 assert.equal(Number((await call('status')).spent_usd),.25);
 }finally{await db.close();}
});
