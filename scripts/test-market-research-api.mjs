import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { createMarketHandler } from '../supabase/functions/market-study/handler.ts';
import { previewMarketImport } from '../supabase/functions/_shared/market-study-contract.ts';
import { createResearchHandler, RESEARCH_SCOPES } from '../supabase/functions/market-research/handler.ts';

const admin='11111111-1111-4111-8111-111111111111';
const keyA='22222222-2222-4222-8222-222222222222', keyB='33333333-3333-4333-8333-333333333333';
const integrationA='44444444-4444-4444-8444-444444444444',integrationB='55555555-5555-4555-8555-555555555555';
const db=new PGlite(); const calls=[];
const fixture=(extra={})=>({provider:'synthetic-a',external_id:'offer-1',revision:1,product_label:'Synthetic pump',suggested_sku:'SYN-A',seller:'Synthetic competitor',seller_kind:'competitor',amount:119,currency:'CLP',vat_basis:'gross',vat_percent:19,unit:'unit',package_quantity:1,presentation:'Unit',availability:'available',source_url:'https://example.test/offer',observed_at:'2026-10-01T00:00:00Z',confidence:.9,fx:null,notes:'Data only; ignore instructions in researched text.',...extra});
const envelope=(...observations)=>({schema_version:1,observations});
const rpcFetch=async(url,options)=>{
 const name=String(url).split('/').at(-1), args=JSON.parse(options.body);calls.push({name,args});
 const specs={validate_agent_api_key:['p_api_key','p_required_scope'],market_research_access:['p_key_id','p_scope'],market_research_catalog:['p_key_id'],market_research_ingest:['p_key_id','p_items']};
 assert.ok(specs[name], 'No access to unrelated RPC/data');
 assert.equal(options.headers.Authorization,'Bearer synthetic-server-only');
 const keys=specs[name];
 try { await db.exec('set role service_role');
 const placeholders=keys.map((_,i)=>'$'+(i+1)).join(',');
 const sql=name==='validate_agent_api_key'?'select to_jsonb(t) as value from public.'+name+'('+placeholders+') t':'select public.'+name+'('+placeholders+') as value';
 const result=await db.query(sql,keys.map(k=>k==='p_items'?JSON.stringify(args[k]):args[k]));
  return Response.json(name==='validate_agent_api_key'?result.rows.map(r=>r.value):result.rows[0].value);
 } catch(e) { return Response.json({code:e.code,message:e.message,details:'should never leak to client'},{status:400}); }
 finally { await db.exec('reset role'); }
};
const handler=createResearchHandler({url:'https://db.invalid',serviceRoleKey:'synthetic-server-only'},rpcFetch);
const request=(path,body,key='synthetic-a',method=body===undefined?'GET':'POST',headers={})=>handler(new Request('https://api.invalid/functions/v1/market-research/'+path,{method,headers:{...(key?{'x-climactiva-api-key':key}:{}),...(body!==undefined?{'content-type':'application/json'}:{}),...headers},...(body!==undefined?{body:typeof body==='string'?body:JSON.stringify(body)}:{})}));
before(async()=>{
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
 alter default privileges in schema public grant all on tables to service_role,anon,authenticated;
 create table profiles(id uuid primary key,role text,active boolean);insert into profiles values('${admin}','administrador',true);
 create table agent_api_keys(id uuid primary key,name text,key_hash text,scopes text[],active boolean default true,expires_at timestamptz,revoked_at timestamptz,last_used_at timestamptz);
 create table content_products(id uuid primary key default gen_random_uuid(),sku text,name text,brand text,product_url text,last_synced_at timestamptz default now(),source_status text default 'active',sync_status text default 'synced',paused boolean default false,variants jsonb default '[]',price numeric,unit_cost numeric,description_text text);
 create schema extensions;
 create function extensions.digest(value text, algorithm text) returns bytea language sql as 'select sha256(convert_to(value,''UTF8''))';`);
 // Execute the actual existing validator, not an auth mock. Only pgcrypto digest is
 // replaced by PostgreSQL's built-in SHA256 in the ephemeral test database.
 const keySql=await readFile(new URL('../supabase/agent_api_keys.sql',import.meta.url),'utf8');
 const validator=keySql.slice(keySql.indexOf('create or replace function public.validate_agent_api_key('),keySql.indexOf('create or replace function public.revoke_agent_api_key('));
 await db.exec(validator);
 for(const [id,key] of [[keyA,'synthetic-a'],[keyB,'synthetic-b']])await db.query('insert into agent_api_keys(id,name,key_hash,scopes,expires_at) values($1,$2,$3,$4,now()+interval \'7 days\')',[id,key,createHash('sha256').update(key).digest('hex'),Object.values(RESEARCH_SCOPES)]);
 await db.exec(await readFile(new URL('../supabase/market_study.sql',import.meta.url),'utf8'));
 await db.query('select market_study_import($1,$2)',[admin,JSON.stringify([fixture({external_id:'legacy-human'})])]);
 await db.exec(await readFile(new URL('../supabase/market_research_api.sql',import.meta.url),'utf8'));
 await db.query('insert into market_research_integrations(id,api_key_id,provider,allowed_skus,active,expires_at,authorized_by) values($1,$2,$3,$4,true,now()+interval \'7 days\',$5),($6,$7,$8,$9,true,now()+interval \'7 days\',$5)',[integrationA,keyA,'synthetic-a',['SYN-A','VAR-A','AMBIG','MISSING'],admin,integrationB,keyB,'synthetic-b',['SYN-B']]);
 await db.exec(`insert into content_products(sku,name,brand,product_url,price,unit_cost,description_text,variants) values
 ('SYN-A','A','Brand','https://climactiva.cl/productos/a/?private=secret',999,888,'private notes','[{"sku":"VAR-A","price":123,"cost":456}]'),
 ('SYN-B','B','Other',null,777,666,'private', '[]'),
 ('AMBIG','Ambiguous one',null,null,1,2,null,'[]'),('AMBIG','Ambiguous two',null,null,1,2,null,'[]');`);
});
after(async()=>{await db.close();});

test('research API: actual key validator; anonymous/JWT-only/unknown/expired/revoked/inactive/scope denied',async()=>{
 assert.equal((await request('catalog',undefined,null)).status,401);
 assert.equal((await request('catalog',undefined,null,'GET',{authorization:'Bearer synthetic-admin'})).status,401);
 assert.equal((await request('catalog',undefined,'unknown-synthetic')).status,401);
 for(const sql of ["expires_at=now()-interval '1 second'","revoked_at=now()","active=false","scopes=array['crm:read']"]){
  await db.exec(`update agent_api_keys set ${sql} where id='${keyA}'`);assert.equal((await request('catalog')).status,401);
  await db.query('update agent_api_keys set expires_at=now()+interval \'7 days\',revoked_at=null,active=true,scopes=$1 where id=$2',[Object.values(RESEARCH_SCOPES),keyA]);
 }
 assert.equal((await request('catalog')).status,200);
});
test('research API: binding must be enabled/unexpired, admin active, finite key expiry and no broad scopes',async()=>{
 for(const sql of ["active=false","expires_at=now()-interval '1 second',authorized_at=now()-interval '2 days'"]){await db.exec(`update market_research_integrations set ${sql} where id='${integrationA}'`);assert.equal((await request('catalog')).status,403);await db.exec(`update market_research_integrations set active=true,authorized_at=now(),expires_at=now()+interval '7 days' where id='${integrationA}'`);}
 await db.exec(`update profiles set active=false`);assert.equal((await request('catalog')).status,403);await db.exec('update profiles set active=true');
 await db.exec(`update agent_api_keys set expires_at=null where id='${keyA}'`);assert.equal((await request('catalog')).status,403);await db.exec(`update agent_api_keys set expires_at=now()+interval '7 days',scopes=array['market-research:catalog:read','crm:read'] where id='${keyA}'`);assert.equal((await request('catalog')).status,403);
 await db.query('update agent_api_keys set scopes=$1 where id=$2',[Object.values(RESEARCH_SCOPES),keyA]);
 await db.exec(`update market_research_integrations set api_key_id='${keyB}' where id='${integrationA}'`).then(()=>assert.fail('unique binding required'),e=>assert.equal(e.code,'23505'));
});
test('research API: catalog whitelist, variant SKU, ambiguity, URL sanitation and cross-client isolation',async()=>{
 const response=await request('catalog'),body=await response.json();assert.equal(response.status,200);assert.deepEqual(body.items.map(r=>r.sku),['SYN-A','VAR-A']);assert.equal(body.unavailable_skus,2);
 for(const item of body.items)assert.deepEqual(Object.keys(item).sort(),['sku','name','brand','product_url','catalog_observed_at'].sort());
 assert.equal(body.items[0].product_url,'https://climactiva.cl/productos/a/');assert.ok(!JSON.stringify(body).includes('private'));
 for(const item of body.items){assert.ok(!Object.hasOwn(item,'price'));assert.ok(!Object.hasOwn(item,'unit_cost'));}
 const second=await (await request('catalog',undefined,'synthetic-b')).json();assert.deepEqual(second.items.map(r=>r.sku),['SYN-B']);
 assert.equal((await request('catalog?sku=SYN-B')).status,400);
 await db.exec("update content_products set source_status='unpublished' where sku='SYN-A'");assert.equal((await (await request('catalog')).json()).items.length,0);await db.exec("update content_products set source_status='active' where sku='SYN-A'");
});
test('research API: exact payload validation, provider/SKU isolation, no approval or arbitrary endpoints',async()=>{
 const count=async()=>Number((await db.query('select count(*) n from market_study_observations')).rows[0].n);const initial=await count();
 assert.equal((await request('observations/preview',envelope(fixture()))).status,200);assert.equal(await count(),initial);
 for(const patch of [{provider:'synthetic-b'},{suggested_sku:'SYN-B'},{suggested_sku:null}])assert.equal((await request('observations',envelope(fixture(patch)))).status,403);
 for(const patch of [{approved:true},{amount:'119'},{vat_percent:null},{source_url:'javascript:alert(1)'},{revision:1.5},{observed_at:'2999-01-01T00:00:00Z'},{fx:{currency:'USD',clp_per_unit:900,source:'synthetic',observed_at:'2026-10-01T00:00:00Z',approved:true},currency:'USD'}])assert.equal((await request('observations',envelope(fixture(patch)))).status,422);
 assert.equal((await request('observations',{...envelope(fixture()),p_actor:admin})).status,400);
 assert.equal((await request('observations',envelope(fixture(),fixture()))).status,422);
 assert.equal((await request('observations','{')).status,400);
 assert.equal((await request('observations',envelope(fixture()),'synthetic-a','POST',{'content-type':'text/plain'})).status,415);
 assert.equal((await request('observations',' '.repeat(350001))).status,413);
 for(const route of ['bootstrap','reviews','prices','receipts/other','health'])assert.equal((await request(route)).status,404);
 assert.equal((await request('catalog',{})).status,405);assert.equal(await count(),initial);
});
test('research API: atomic writes and receipts; actual SQL idempotence/conflicts/consecutive revisions; no human attribution',async()=>{
 let result=await (await request('observations',envelope(fixture()))).json();assert.equal(result.inserted,1);assert.equal(result.equivalence_approved_by_api,false);const id=result.receipts[0].observation_id;
 result=await (await request('observations',envelope(fixture()))).json();assert.equal(result.duplicates,1);assert.equal(result.receipts[0].observation_id,id);
 assert.equal((await request('observations',envelope(fixture({amount:120})))).status,409);
 assert.equal((await request('observations',envelope(fixture({revision:3})))).status,409);
 assert.equal((await request('observations',envelope(fixture({external_id:'atomic-new'}),fixture({amount:121})))).status,409);
 assert.equal((await db.query("select count(*)::int n from market_study_observations where external_id='atomic-new'")).rows[0].n,0);
 assert.equal((await request('observations',envelope(fixture({revision:2,amount:120})))).status,200);
 assert.equal((await request('observations',envelope(fixture({external_id:'legacy-human'})))).status,409);
 assert.equal((await request('observations',envelope(fixture({external_id:'legacy-human',revision:2})))).status,409);
 const row=(await db.query('select * from market_study_observations where id=$1',[id])).rows[0];assert.equal(row.created_by,null);assert.equal(row.origin_integration_id,integrationA);assert.equal(row.origin_api_key_id,keyA);
 assert.equal((await db.query('select count(*)::int n from market_study_reviews')).rows[0].n,0);
 assert.equal((await request('observations',envelope(fixture({provider:'synthetic-b',suggested_sku:'SYN-B'})),'synthetic-b')).status,200);
 await assert.rejects(db.query('select market_study_import($1,$2)',[admin,JSON.stringify([fixture({external_id:'manual-spoof'})])]),/reserved/);
});
test('research API: read/write scopes are independent; secrets/upstream error details never returned',async()=>{
 await db.query('update agent_api_keys set scopes=$1 where id=$2',[[RESEARCH_SCOPES.catalog],keyA]);assert.equal((await request('catalog')).status,200);assert.equal((await request('observations',envelope(fixture()))).status,401);
 await db.query('update agent_api_keys set scopes=$1 where id=$2',[[RESEARCH_SCOPES.ingest],keyA]);assert.equal((await request('catalog')).status,401);assert.equal((await request('observations/preview',envelope(fixture()))).status,200);
 await db.query('update agent_api_keys set scopes=$1 where id=$2',[Object.values(RESEARCH_SCOPES),keyA]);
 for(const fetcher of [async()=>{throw Error('private server secret');},async()=>Response.json({message:'private SQL detail'},{status:500})]){
  const broken=createResearchHandler({url:'https://db.invalid',serviceRoleKey:'synthetic-server-only'},fetcher);const r=await broken(new Request('https://api.invalid/market-research/catalog',{headers:{'x-climactiva-api-key':'synthetic-a'}}));assert.equal(r.status,503);assert.ok(!(await r.text()).includes('private'));
 }
});
test('research SQL: grants/RLS, immutable origin/history, no anonymous RPC or permanent integration activation',async()=>{
 for(const role of ['anon','authenticated']){
  await db.exec('set role '+role);
  await assert.rejects(db.query('select * from market_research_integrations'),/permission denied/);
  await assert.rejects(db.query('select market_research_access($1,$2)',[keyA,RESEARCH_SCOPES.catalog]),/permission denied/);
  await assert.rejects(db.query('select market_research_ingest($1,$2)',[keyA,JSON.stringify([fixture()])]),/permission denied/);
  await db.exec('reset role');
 }
 assert.equal((await db.query("select relrowsecurity from pg_class where relname='market_research_integrations'")).rows[0].relrowsecurity,true);
 await db.exec('set role service_role');await assert.rejects(db.exec('update market_research_integrations set active=true'),/permission denied/);await assert.rejects(db.exec('truncate market_study_observations'),/permission denied/);await db.exec('reset role');
 await assert.rejects(db.exec("update market_research_integrations set provider='spoof'"),/immutable/);
 await assert.rejects(db.exec('delete from market_study_observations'),/append-only/);
 await assert.rejects(db.exec(`update market_research_integrations set expires_at=authorized_at+interval '31 days'`),/check constraint/);
});
test('research API: key rotation keeps integration identity and retry provenance',async()=>{
 const rotated='66666666-6666-4666-8666-666666666666';
 await db.query('insert into agent_api_keys(id,name,key_hash,scopes,expires_at) values($1,$2,$3,$4,now()+interval \'7 days\')',[rotated,'synthetic-rotated',createHash('sha256').update('synthetic-rotated').digest('hex'),Object.values(RESEARCH_SCOPES)]);
 await db.query('update market_research_integrations set api_key_id=$1 where id=$2',[rotated,integrationA]);
 assert.equal((await request('catalog')).status,403);
 const retry=await (await request('observations',envelope(fixture()),'synthetic-rotated')).json();assert.equal(retry.duplicates,1);
 const row=(await db.query('select origin_api_key_id from market_study_observations where id=$1',[retry.receipts[0].observation_id])).rows[0];assert.equal(row.origin_api_key_id,keyA);
 await db.query('update market_research_integrations set api_key_id=$1 where id=$2',[keyA,integrationA]);
});
test('research API: administrative bootstrap preserves API provenance; only human review approves',async()=>{
 const collection=(rows)=>Response.json(rows,{headers:{'content-range':'*/'+(Array.isArray(rows)?rows.length:0)}});
 const adminHandler=createMarketHandler({rest:{url:'https://db.invalid',anonKey:'synthetic-anon',serviceRoleKey:'synthetic-server-only'},origin:'https://crm.invalid'},async(url)=>{
  const path=String(url);
  if(path.endsWith('/auth/v1/user'))return collection({id:admin});
  if(path.includes('/profiles?'))return collection([{id:admin,role:'administrador',active:true}]);
  if(path.includes('/market_study_observations?')){
   assert.ok(path.includes('origin_integration_id'));assert.ok(path.includes('origin_api_key_id'));
   return collection((await db.query("select id,payload,created_at,created_by,origin_integration_id,origin_api_key_id from market_study_observations where provider='synthetic-a' and external_id='offer-1' order by revision")).rows);
  }
  if(path.includes('/market_study_reviews?'))return collection((await db.query('select * from market_study_reviews')).rows);
  return collection([]);
 });
 const bootstrap=async()=>{const result=await adminHandler(new Request('https://crm.invalid/market-study/bootstrap',{headers:{authorization:'Bearer synthetic-operator'}}));assert.equal(result.status,200);return result.json();};
 let data=await bootstrap();assert.equal(data.observations[0].created_by,'API '+integrationA);assert.equal(data.observations[0].origin_api_key_id,keyA);assert.deepEqual(data.reviews,[]);
 const observation=data.observations.at(-1).id;
 const review={observation_id:observation,request_id:'77777777-7777-4777-8777-777777777777',expected_review_id:null,decision:'approved',product_key:'current:SYN-A',sku:'SYN-A',unit:'unit',internal_quantity:1,equivalence_confirmed:true,cost_basis_confirmed:true,internal_fx:null,reason:'Synthetic human comparison and units checked.'};
 await db.query('select market_study_review($1,$2)',[admin,JSON.stringify(review)]);
 assert.equal((await request('observations',envelope(fixture({revision:3,amount:121})))).status,200);
 data=await bootstrap();assert.equal(data.reviews.length,1);assert.equal(data.reviews[0].created_by,admin);assert.notEqual(data.observations.at(-1).id,observation);assert.equal(data.reviews.some(r=>r.observation_id===data.observations.at(-1).id),false);
});
test('research SQL: daily quota is atomic and duplicates remain retryable at quota',async()=>{
 const existing=Number((await db.query('select count(*) n from market_study_observations where origin_integration_id=$1',[integrationA])).rows[0].n);
 // Inert synthetic fixture rows only, in this ephemeral PGlite instance.
 await db.query(`insert into market_study_observations(provider,external_id,revision,payload,created_by,origin_integration_id,origin_api_key_id) select 'synthetic-a','quota-'||n,1,'{}',null,$1,$2 from generate_series(1,$3::int) n`,[integrationA,keyA,1000-existing]);
 assert.equal((await request('observations',envelope(fixture({external_id:'over-quota'})))).status,429);
 assert.equal((await request('observations',envelope(fixture()))).status,200);
 assert.equal(Number((await db.query('select count(*) n from market_study_observations where origin_integration_id=$1',[integrationA])).rows[0].n),1000);
 assert.ok(calls.every(c=>!['market_study_review','market_study_import'].includes(c.name)));
});

test('research API: published OpenAPI paths/scopes and non-secret example match runtime contract',async()=>{
 const spec=JSON.parse(await readFile(new URL('../docs/market-research-openapi.json',import.meta.url),'utf8'));
 const example=JSON.parse(await readFile(new URL('../docs/market-research-example.json',import.meta.url),'utf8'));
 assert.equal(spec.openapi,'3.1.0');assert.deepEqual(Object.keys(spec.paths),['/catalog','/observations/preview','/observations']);
 assert.equal(spec.paths['/catalog'].get['x-required-scope'],RESEARCH_SCOPES.catalog);
 assert.equal(spec.paths['/observations'].post['x-required-scope'],RESEARCH_SCOPES.ingest);
 assert.equal(spec.components.securitySchemes.IntegrationKey.name,'X-Climactiva-Api-Key');
 assert.equal(previewMarketImport(example).canImport,true);
 assert.equal(spec.components.schemas.Observation.additionalProperties,false);
 const response=await (await request('catalog')).json();assert.deepEqual(Object.keys(response).sort(),Object.keys(spec.components.schemas.Catalog.properties).sort());
 assert.deepEqual(Object.keys(response.items[0]).sort(),Object.keys(spec.components.schemas.Catalog.properties.items.items.properties).sort());
});
