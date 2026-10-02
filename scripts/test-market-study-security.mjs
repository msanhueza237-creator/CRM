import assert from 'node:assert/strict';import {test} from 'node:test';import {readFile} from 'node:fs/promises';import {PGlite} from '@electric-sql/pglite';
import {createMarketHandler} from '../supabase/functions/market-study/handler.ts';
import {normalizeMarketObservation} from '../supabase/functions/_shared/market-study-contract.ts';
const actor='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const at='2026-10-01T00:00:00Z';const fixture=()=>normalizeMarketObservation({provider:'test',external_id:'1',revision:1,product_label:'Sintético',suggested_sku:'SYN',seller:'Prueba',seller_kind:'competitor',amount:119,currency:'CLP',vat_basis:'gross',vat_percent:19,unit:'unit',package_quantity:1,presentation:'Unidad',availability:'available',source_url:'https://example.test',observed_at:at,confidence:.9,fx:null,notes:''});
const env={rest:{url:'https://fixture.invalid',anonKey:'synthetic-anon',serviceRoleKey:'synthetic-service'},origin:'https://crm.example.test'};
test('API niega anónimo, sesión inválida, metadata elevada, inactivo y finanzas antes de leer costos',async()=>{
 for(const scenario of ['anonymous','invalid','metadata','inactive','finance']){
  const calls=[];const handler=createMarketHandler(env,async(url,options)=>{calls.push(String(url));if(String(url).endsWith('/auth/v1/user'))return new Response(JSON.stringify({id:actor,user_metadata:{role:'administrador'}}),{status:scenario==='invalid'?401:200});if(String(url).includes('profiles?'))return new Response(JSON.stringify([{id:actor,role:scenario==='finance'?'finanzas':scenario==='metadata'?'visualizador':'administrador',active:scenario!=='inactive'}]));throw Error('Unexpected data read');});
  const r=await handler(new Request('https://fixture.invalid/functions/v1/market-study/bootstrap',{headers:scenario==='anonymous'?{}:{Authorization:'Bearer fake-user'}}));assert.equal(r.status,['anonymous','invalid'].includes(scenario)?401:403);assert.ok(calls.every(u=>u.includes('/auth/v1/user')||u.includes('profiles?')));
 }
});
test('Preview no escribe; importación usa actor verificado y rutas no financieras',async()=>{
 const calls=[];const handler=createMarketHandler(env,async(url,options)=>{calls.push({url:String(url),method:options?.method||'GET',body:options?.body});if(String(url).endsWith('/auth/v1/user'))return new Response(JSON.stringify({id:actor}));if(String(url).includes('profiles?'))return new Response(JSON.stringify([{id:actor,role:'administrador',active:true}]));if(String(url).endsWith('/rpc/market_study_import'))return new Response(JSON.stringify({inserted:1,duplicates:0}));throw Error('Unexpected call');});
 const req=(route,body)=>new Request('https://fixture.invalid/functions/v1/market-study/'+route,{method:'POST',headers:{Authorization:'Bearer synthetic','Content-Type':'application/json'},body:JSON.stringify(body)});
 const body={schema_version:1,observations:[fixture()],p_actor:other};let r=await handler(req('imports/preview',body));assert.equal(r.status,200);assert.ok((await r.json()).canImport);assert.equal(calls.filter(c=>c.method==='POST').length,0);
 r=await handler(req('imports/commit',body));assert.equal(r.status,200);const write=calls.find(c=>c.method==='POST');assert.equal(JSON.parse(write.body).p_actor,actor);assert.equal(JSON.parse(write.body).p_items[0].approved,undefined);
 assert.equal((await handler(req('prices/apply',{}))).status,404);assert.equal((await handler(req('imports/commit',{schema_version:1,observations:[{...fixture(),amount:'bad'}]}))).status,422);
 assert.equal(calls.filter(c=>c.method==='POST').length,1);
});
test('SQL local: lote atómico, identidad/revisión, historia inmutable, privilegios y revisión optimista',async()=>{
 const db=new PGlite();try{
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;alter default privileges in schema public grant all on tables to service_role;create table public.profiles(id uuid primary key,role text,active boolean);insert into profiles values('${actor}','administrador',true),('${other}','visualizador',true);grant select on profiles to service_role;`);
 await db.exec(await readFile(new URL('../supabase/market_study.sql',import.meta.url),'utf8'));
 const payload=fixture();const call=async(items,who=actor)=>(await db.query('select public.market_study_import($1::uuid,$2::jsonb) result',[who,JSON.stringify(items)])).rows[0].result;
 assert.equal((await db.query("select has_table_privilege('service_role','public.market_study_observations','TRUNCATE') as allowed")).rows[0].allowed,false);
 await db.exec('set role service_role');assert.deepEqual(await call([payload]),{inserted:1,duplicates:0});assert.deepEqual(await call([payload]),{inserted:0,duplicates:1});
 await assert.rejects(call([{...payload,amount:120}]),/Idempotency conflict/);await assert.rejects(call([{...payload,revision:3}]),/consecutive/);await assert.rejects(call([payload],other),/Forbidden/);
 await assert.rejects(call([{...payload,external_id:'atomic-new'},{...payload,revision:1,amount:121}]),/Idempotency/);assert.equal((await db.query("select count(*)::int n from market_study_observations where external_id='atomic-new'")).rows[0].n,0);
 await call([{...payload,revision:2,amount:120}]);const observation=(await db.query('select id from market_study_observations where revision=2')).rows[0].id;
 const review={observation_id:observation,request_id:'33333333-3333-4333-8333-333333333333',expected_review_id:null,decision:'approved',product_key:'current:SYN',sku:'SYN',unit:'unit',internal_quantity:1,equivalence_confirmed:true,cost_basis_confirmed:true,internal_fx:null,reason:'Identidad y presentación revisadas.'};
 const save=async p=>(await db.query('select market_study_review($1::uuid,$2::jsonb) r',[actor,JSON.stringify(p)])).rows[0].r;
 const first=await save(review);assert.equal((await save(review)).id,first.id);await assert.rejects(save({...review,reason:'Motivo diferente e incompatible'}),/idempotency conflict/);
 await assert.rejects(save({...review,request_id:'44444444-4444-4444-8444-444444444444',decision:'pending'}),/Review changed/);
 await save({...review,request_id:'44444444-4444-4444-8444-444444444444',expected_review_id:first.id,decision:'pending'});
 assert.equal((await db.query('select count(*)::int n from market_study_reviews')).rows[0].n,2);
 await db.exec('reset role');await assert.rejects(db.exec('update market_study_observations set revision=9'),/append-only/);await assert.rejects(db.exec('delete from market_study_reviews'),/append-only/);
 for(const role of ['anon','authenticated']){await db.exec('set role '+role);await assert.rejects(db.query('select * from market_study_observations'),/permission denied/);await assert.rejects(call([payload]),/permission denied/);await assert.rejects(save(review),/permission denied/);await db.exec('reset role');}
 const rls=await db.query("select relrowsecurity from pg_class where relname in ('market_study_observations','market_study_reviews')");assert.ok(rls.rows.every(r=>r.relrowsecurity));
 }finally{await db.close();}
});

test('Health privado y bootstrap sin fuentes: no inventa inventario ni cobertura',async()=>{
 const unauth=createMarketHandler(env,async()=>{throw Error('No network expected');});
 assert.equal((await unauth(new Request('https://fixture.invalid/functions/v1/market-study/health'))).status,401);
 for(const overflow of [false,true]){
  const handler=createMarketHandler(env,async(url)=>{
   const u=String(url);
   if(u.endsWith('/auth/v1/user'))return new Response(JSON.stringify({id:actor}));
   if(u.includes('profiles?'))return new Response(JSON.stringify([{id:actor,role:'administrador',active:true}]));
   if(u.includes('accounting_entities?'))return new Response(JSON.stringify([{id:actor}]));
   return new Response('[]',{headers:{'content-range':`*/${overflow&&u.includes('foreign_trade_operations?')?51:0}`}});
  });
  const response=await handler(new Request('https://fixture.invalid/functions/v1/market-study/bootstrap',{headers:{Authorization:'Bearer synthetic'}}));
  assert.equal(response.status,200);const body=await response.json();
  assert.equal(body.inventoryAvailable,false);assert.deepEqual(body.inventory,[]);assert.equal(body.importsComplete,!overflow);assert.deepEqual(body.observations,[]);assert.ok(body.warnings.length>0);
 }
});
