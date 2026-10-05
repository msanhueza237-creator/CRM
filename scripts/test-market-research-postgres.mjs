import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { Readable } from 'node:stream';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createResearchHandler } from '../supabase/functions/market-research/handler.ts';
import { createMarketHandler } from '../supabase/functions/market-study/handler.ts';

const repo=fileURLToPath(new URL('..',import.meta.url));
const option=name=>process.argv.find(v=>v.startsWith('--'+name+'='))?.slice(name.length+3);
const bin=option('pg-bin');if(!bin)throw Error('Provide --pg-bin= for an already installed PostgreSQL distribution. No installation is performed.');
const output=path.resolve(repo,option('output')||'outputs/market-research-postgres');
assert.ok(output.startsWith(path.resolve(repo)+path.sep));fs.mkdirSync(output,{recursive:true});
const root=fs.mkdtempSync(path.join(repo,'tmp','market-research-pg-')),data=path.join(root,'data');
const toolsBin=option('tools-bin')||bin;
const executable=name=>path.join(['pg_dump','pg_restore'].includes(name)?toolsBin:bin,name+'.exe');
for(const name of ['postgres','pg_ctl','initdb','psql'])assert.ok(fs.existsSync(executable(name)),name+' is not installed');
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>['SYSTEMROOT','WINDIR','PATH','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA','COMPUTERNAME','USERDOMAIN','USERNAME','COMSPEC'].includes(k.toUpperCase())));
for(const key of Object.keys(env))if(key.toUpperCase()==='PATH')delete env[key];
env.PATH=bin+path.delimiter+process.env.PATH;
Object.assign(env,{PGPASSFILE:path.join(root,'no-password-file'),PGCONNECT_TIMEOUT:'5',PGCLIENTENCODING:'UTF8',PGSSLMODE:'disable'});
const report={started_at:new Date().toISOString(),data,productionAccess:false,server:null,checks:[],limitations:['Not PostgREST/Deno/Kong E2E','Complete relevant repository DDL, not a production schema dump','pgcrypto extension registration files absent: load installed real pgcrypto.dll digest entrypoint only'],stopped:false};
const writeReport=()=>fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(report,null,2));
const mark=(name,evidence={})=>{report.checks.push({name,passed:true,...evidence});console.log('PASS '+name);writeReport();};
const run=(name,args,input,allowFailure=false)=>{const r=spawnSync(executable(name),args,{env,input,encoding:'utf8',windowsHide:true,timeout:60000,maxBuffer:8e6,...(name==='pg_ctl'?{stdio:'ignore'}:{})});if(!allowFailure&&r.status!==0)throw Error(name+': '+(r.stderr||r.error?.message||'failed').slice(-2400));return r;};
const freePort=()=>new Promise((resolve,reject)=>{const s=net.createServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
const port=await freePort();report.port=port;
const database='market_research_fixture',owner='crm_test_owner';
const pgArgs=db=>['-X','-w','-h','127.0.0.1','-p',String(port),'-U',owner,'-d',db,'-q','-A','-t','-v','ON_ERROR_STOP=1'];
const sql=(text,db=database)=>run('psql',pgArgs(db),text).stdout.trim();
const json=(text,db=database)=>JSON.parse(sql(text,db).split(/\r?\n/).filter(Boolean).at(-1));
const quote=v=>"'"+String(v).replaceAll("'","''")+"'";
const admin='11111111-1111-4111-8111-111111111111',keyA='22222222-2222-4222-8222-222222222222',keyB='33333333-3333-4333-8333-333333333333',keyC='66666666-6666-4666-8666-666666666666';
const intA='44444444-4444-4444-8444-444444444444',intB='55555555-5555-4555-8555-555555555555',intC='77777777-7777-4777-8777-777777777777';
const fixture=(extra={})=>({provider:'synthetic-a',external_id:'offer-1',revision:1,product_label:'Synthetic pump',suggested_sku:'SYN-A',seller:'Synthetic competitor',seller_kind:'competitor',amount:119,currency:'CLP',vat_basis:'gross',vat_percent:19,unit:'unit',package_quantity:1,presentation:'Unit',availability:'available',source_url:'https://example.test/offer',observed_at:'2026-10-01T00:00:00.000Z',confidence:.9,fx:null,notes:'Synthetic local research only.',...extra});
const ingest=(items,key=keyA)=>`select market_research_ingest(${quote(key)}::uuid,${quote(JSON.stringify(items))}::jsonb);`;
const connections=[];
class Connection {
 constructor(label){this.label=label;this.buffer='';this.rows=[];this.sequence=0;this.pending=null;this.lastError='';this.child=spawn(executable('psql'),[...pgArgs(database),'-v','ON_ERROR_STOP=0'],{env,windowsHide:true,stdio:['pipe','pipe','pipe']});connections.push(this);
  this.child.stderr.on('data',c=>{this.lastError+=c.toString('utf8');});
  this.child.stdout.on('data',c=>{this.buffer+=c.toString('utf8');while(this.buffer.includes('\n')){const n=this.buffer.indexOf('\n'),line=this.buffer.slice(0,n).replace(/\r$/,'');this.buffer=this.buffer.slice(n+1);if(this.pending&&line.startsWith(this.pending.marker+' ')){const p=this.pending;this.pending=null;clearTimeout(p.timer);p.resolve({state:line.slice(p.marker.length+1).trim(),rows:this.rows.filter(Boolean),error:this.lastError});this.rows=[];this.lastError='';}else this.rows.push(line);}});
  this.child.on('error',e=>this.pending?.reject(e));this.exited=new Promise(resolve=>this.child.on('exit',code=>{if(this.pending){clearTimeout(this.pending.timer);this.pending.reject(Error(label+' exited '+code));this.pending=null;}resolve(code);}));
 }
 query(text){assert.equal(this.pending,null);return new Promise((resolve,reject)=>{const marker='__MARKET_'+this.label+'_'+(++this.sequence)+'__';const timer=setTimeout(()=>{this.child.kill();reject(Error(this.label+' timeout'));},20000);this.pending={marker,resolve,reject,timer};this.child.stdin.write(text+'\n\\echo '+marker+' :SQLSTATE\n');});}
 async ok(text){const r=await this.query(text);assert.equal(r.state,'00000',r.error);return r.rows;}
 async json(text){return JSON.parse((await this.ok(text)).at(-1));}
 async close(){if(this.child.exitCode===null){this.child.stdin.end('ROLLBACK;\n\\q\n');await this.exited;}}
}
let started=false,httpServer;
try {
 run('initdb',['-D',data,'-U',owner,'--auth-host=sspi','--auth-local=trust','--encoding=UTF8','--no-locale']);
 const principal=(env.USERNAME||env.Username||process.env.USERNAME)+'@'+(env.USERDOMAIN||process.env.USERDOMAIN);
 assert.match(principal,/^[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+$/);
 fs.writeFileSync(path.join(data,'pg_hba.conf'),`# Ephemeral fixture; existing Windows identity only.\nhost all ${owner} 127.0.0.1/32 sspi include_realm=1 map=market_fixture\nhost all all 127.0.0.1/32 reject\nhost all all ::1/128 reject\n`);
 fs.writeFileSync(path.join(data,'pg_ident.conf'),`market_fixture ${principal} ${owner}\n`);
 run('pg_ctl',['start','-D',data,'-l',path.join(root,'server.log'),'-w','-t','25','-o',`-h 127.0.0.1 -p ${port} -c shared_buffers=32MB -c max_connections=12 -c work_mem=4MB -c maintenance_work_mem=32MB -c min_wal_size=32MB -c max_wal_size=128MB`]);started=true;
 report.server=json("select json_build_object('version',version(),'data',current_setting('data_directory'),'address',inet_server_addr(),'port',inet_server_port(),'user',current_user,'listen_addresses',current_setting('listen_addresses'));",'postgres');
 assert.equal(path.resolve(report.server.data).toLowerCase(),path.resolve(data).toLowerCase());assert.equal(report.server.address,'127.0.0.1');assert.equal(report.server.port,port);assert.equal(report.server.user,owner);assert.equal(report.server.listen_addresses,'127.0.0.1');mark('isolated PostgreSQL 17 loopback with existing Windows SSPI identity');
 sql(`create database ${database};`,'postgres');
 sql(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;create role supabase_admin nologin;
 create schema auth;create schema extensions;create table auth.users(id uuid primary key);
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create function extensions.digest(text,text) returns bytea as '$libdir/pgcrypto','pg_digest' language c immutable strict parallel safe;
 grant usage on schema public,auth,extensions to anon,authenticated,service_role;
 alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
 alter default privileges in schema public grant all on sequences to anon,authenticated,service_role;`);
 const digest=json("select to_json(encode(extensions.digest('synthetic-a','sha256'),'hex')); ");assert.equal(digest,createHash('sha256').update('synthetic-a').digest('hex'));mark('actual installed pgcrypto.dll digest matches SHA256; no cryptographic mock');
 const files=['schema.sql','agent_hub.sql','content_center.sql','agent_api_keys.sql','market_study.sql'];report.schemaFiles=[];
 for(const file of files){const source=fs.readFileSync(path.join(repo,'supabase',file),'utf8');const prepared=source.replace(/create extension if not exists\s+"?pgcrypto"?\s*;/gi,'-- Installed pgcrypto.dll digest loaded above; extension registration files unavailable.');sql(prepared);report.schemaFiles.push({file,sha256:createHash('sha256').update(source).digest('hex'),adaptation:'Only CREATE EXTENSION pgcrypto omitted; real DLL digest provided in extensions schema'});}
 sql(`insert into auth.users values('${admin}');insert into profiles(id,full_name,role,active) values('${admin}','Synthetic administrator','administrador',true);
 insert into content_products(source_provider,external_id,payload_hash,sku,name,brand,price,stock,product_url,variants) values('tiendanube','synthetic-product-a','synthetic-hash','SYN-A','Synthetic product A','Synthetic',999,12,'https://climactiva.cl/productos/synthetic/','[{"sku":"VAR-A","price":888}]'),('tiendanube','synthetic-product-b','synthetic-hash','SYN-B','Synthetic product B','Synthetic',777,3,null,'[]');`);
 for(const [key,secret] of [[keyA,'synthetic-a'],[keyB,'synthetic-b'],[keyC,'synthetic-c']])sql(`insert into agent_api_keys(id,name,key_prefix,key_hash,scopes,expires_at) values(${quote(key)},${quote(secret)},${quote(secret)},encode(extensions.digest(${quote(secret)},'sha256'),'hex'),array['market-research:catalog:read','market-research:observations:write'],now()+interval '7 days');`);
 sql(`select market_study_import('${admin}',${quote(JSON.stringify([fixture({provider:'manual-synthetic',external_id:'legacy'})]))});`);
 const baseline=json("select jsonb_build_object('tables',(select count(*) from information_schema.tables where table_schema='public'),'catalog',(select jsonb_agg(to_jsonb(p) order by sku) from content_products p),'observations',(select jsonb_agg(to_jsonb(o)) from market_study_observations o));");
 mark('complete relevant repository DDL loaded with real profiles/catalog/API key schemas',{public_tables:baseline.tables,sourceFiles:files});
 const migration=fs.readFileSync(path.join(repo,'supabase/market_research_api.sql'),'utf8');
 sql(migration.replace(/commit;\s*$/i,'rollback;'));
 assert.equal(json("select coalesce(to_json(to_regclass('public.market_research_integrations')),'null'::json)"),null);
 assert.equal(json("select to_json(count(*)) from information_schema.columns where table_name='market_study_observations' and column_name='origin_integration_id'"),0);
 const failure=run('psql',pgArgs(database),migration.replace(/commit;\s*$/i,'select 1/0; commit;'),true);assert.notEqual(failure.status,0);assert.equal(json("select coalesce(to_json(to_regclass('public.market_research_integrations')),'null'::json)"),null);
 assert.deepEqual(json('select jsonb_agg(to_jsonb(o)) from market_study_observations o'),baseline.observations);
 assert.deepEqual(json('select jsonb_agg(to_jsonb(p) order by sku) from content_products p'),baseline.catalog);
 mark('DDL rollback and forced-failure rollback preserve original schema and data');
 const canRestore=['pg_dump','pg_restore'].every(n=>fs.existsSync(executable(n)));const dump=path.join(root,'synthetic-before-api.dump');if(canRestore)run('pg_dump',['-h','127.0.0.1','-p',String(port),'-U',owner,'-d',database,'-w','-Fc','-f',dump]);
 sql(migration);report.schemaFiles.push({file:'market_research_api.sql',sha256:createHash('sha256').update(migration).digest('hex'),adaptation:'none'});
 assert.equal(json('select to_json(count(*)) from market_research_integrations'),0);
 assert.deepEqual(json('select jsonb_agg(to_jsonb(p) order by sku) from content_products p'),baseline.catalog);
 mark('API DDL applies without activating integrations or altering catalog prices/data');
 if(canRestore){
 sql('create database market_research_restore;','postgres');run('pg_restore',['-h','127.0.0.1','-p',String(port),'-U',owner,'-d','market_research_restore','-w','--exit-on-error',dump]);
 assert.equal(json("select coalesce(to_json(to_regclass('public.market_research_integrations')),'null'::json)",'market_research_restore'),null);
 assert.deepEqual(json('select jsonb_agg(to_jsonb(p) order by sku) from content_products p','market_research_restore'),baseline.catalog);
 assert.deepEqual(json('select jsonb_agg(to_jsonb(o)) from market_study_observations o','market_research_restore'),baseline.observations);
 mark('pg_dump/pg_restore rollback rehearsed into separate synthetic database');
 }else{report.limitations.push('pg_dump.exe and/or pg_restore.exe are not installed: backup restoration test skipped; DDL/data transaction rollback is tested.');}
 for(const [id,key,provider,skus] of [[intA,keyA,'synthetic-a',['SYN-A','VAR-A']],[intB,keyB,'synthetic-b',['SYN-B']],[intC,keyC,'synthetic-c',['SYN-A']]])sql(`insert into market_research_integrations(id,api_key_id,provider,allowed_skus,active,authorized_by,expires_at) values(${quote(id)},${quote(key)},${quote(provider)},array[${skus.map(quote).join(',')}],true,'${admin}',now()+interval '7 days');`);
 const a=new Connection('A'),b=new Connection('B');const pidA=await a.json('select to_json(pg_backend_pid());'),pidB=await b.json('select to_json(pg_backend_pid());');assert.notEqual(pidA,pidB);report.concurrentPids=[pidA,pidB];
 const waitBlocked=async()=>{for(let i=0;i<30;i++){const pids=json(`select to_json(pg_blocking_pids(${pidB}));`);if(pids.includes(pidA)){const activity=json(`select json_build_object('pid',pid,'wait_event_type',wait_event_type,'wait_event',wait_event) from pg_stat_activity where pid=${pidB}`);(report.concurrentWaits??=[]).push({blocker:pidA,waiter:pidB,blockingPids:pids,...activity});return pids;}await new Promise(r=>setTimeout(r,50));}throw Error('Expected real blocking did not occur');};
 const begin=async c=>{await c.ok('begin;set local role service_role;set local statement_timeout=15000;');};
 await begin(a);assert.equal((await a.json(ingest([fixture({external_id:'concurrent-same'})]))).inserted,1);await begin(b);const identical=b.query(ingest([fixture({external_id:'concurrent-same'})]));await waitBlocked();await a.ok('commit;');const duplicate=await identical;assert.equal(duplicate.state,'00000',duplicate.error);assert.equal(JSON.parse(duplicate.rows.at(-1)).duplicates,1);await b.ok('commit;');mark('two real connections: identical concurrent submissions produce one insert and one duplicate');
 await begin(a);await a.ok(ingest([fixture({external_id:'concurrent-conflict'})]));await begin(b);const conflict=b.query(ingest([fixture({external_id:'concurrent-conflict',amount:120})]));await waitBlocked();await a.ok('commit;');assert.equal((await conflict).state,'23505');await b.ok('rollback;');mark('two real connections: changed payload conflicts after winning transaction commits');
 await begin(a);await a.ok(ingest([fixture({external_id:'concurrent-rollback'})]));await begin(b);const rollback=b.query(ingest([fixture({external_id:'concurrent-rollback'})]));await waitBlocked();await a.ok('rollback;');const afterRollback=await rollback;assert.equal(afterRollback.state,'00000');assert.equal(JSON.parse(afterRollback.rows.at(-1)).inserted,1);await b.ok('commit;');mark('two real connections: rollback releases lock and waiter inserts exactly once');
 const atomic=await a.query(ingest([fixture({external_id:'atomic-new'}),fixture({external_id:'concurrent-same',amount:122})]));assert.equal(atomic.state,'23505');assert.equal(json("select to_json(count(*)) from market_study_observations where external_id='atomic-new'"),0);mark('failed mixed batch is fully rolled back');
 const quotaFixture=quote(JSON.stringify(fixture({provider:'synthetic-c'})));
 sql(`insert into market_study_observations(provider,external_id,revision,payload,origin_integration_id,origin_api_key_id) select 'synthetic-c','quota-'||i,1,jsonb_set(${quotaFixture}::jsonb,'{external_id}',to_jsonb('quota-'||i)),'${intC}','${keyC}' from generate_series(1,999) i;`);
 await begin(a);await a.ok(ingest([fixture({provider:'synthetic-c',external_id:'quota-winner'})],keyC));await begin(b);const quota=b.query(ingest([fixture({provider:'synthetic-c',external_id:'quota-loser'})],keyC));await waitBlocked();await a.ok('commit;');assert.equal((await quota).state,'P0002');await b.ok('rollback;');assert.equal(json(`select to_json(count(*)) from market_study_observations where origin_integration_id='${intC}'`),1000);assert.equal(json(ingest([fixture({provider:'synthetic-c',external_id:'quota-winner'})],keyC)).duplicates,1);mark('two real connections: daily quota cannot be exceeded; retry at quota stays idempotent');
 await a.ok(`begin;select pg_advisory_xact_lock(hashtextextended('${intB}',37));`);await begin(b);const revoked=b.query(ingest([fixture({provider:'synthetic-b',suggested_sku:'SYN-B',external_id:'revoked-while-waiting'})],keyB));await waitBlocked();sql(`set request.jwt.claim.sub='${admin}';select revoke_agent_api_key('${keyB}');`);await a.ok('commit;');assert.equal((await revoked).state,'42501');await b.ok('rollback;');mark('revocation while waiting is rechecked before inserting');
 for(const role of ['anon','authenticated']){assert.equal((await a.query(`set role ${role};select * from market_research_integrations;`)).state,'42501');await a.ok('reset role;');assert.equal((await a.query(`set role ${role};${ingest([fixture()])}`)).state,'42501');await a.ok('reset role;');}
 assert.equal((await a.query('set role service_role;update market_research_integrations set active=true;')).state,'42501');await a.ok('reset role;');assert.equal((await a.query('set role service_role;truncate market_study_observations;')).state,'42501');await a.ok('reset role;');
 assert.ok(json("select jsonb_agg(relrowsecurity) from pg_class where relname in ('market_research_integrations','market_study_observations','market_study_reviews')").every(Boolean));mark('real roles/RLS/grants deny anonymous/authenticated RPC and service activation/truncation');
 const rpcNames={validate_agent_api_key:['p_api_key','p_required_scope'],market_research_access:['p_key_id','p_scope'],market_research_catalog:['p_key_id'],market_research_ingest:['p_key_id','p_items']};
 const sqlTransport=async(url,options)=>{
  const u=new URL(String(url)),name=u.pathname.split('/').at(-1);
  if(u.pathname==='/auth/v1/user')return Response.json({id:admin});
  if(u.pathname.includes('/rpc/')){assert.ok(rpcNames[name]);const args=JSON.parse(options.body),params=rpcNames[name].map(k=>quote(typeof args[k]==='string'?args[k]:JSON.stringify(args[k]))).join(',');const select=name==='validate_agent_api_key'?`select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) from ${name}(${params}) t;`:`select ${name}(${params});`;const r=run('psql',[...pgArgs(database),'-v','VERBOSITY=verbose'],'set role service_role;'+select,true);if(r.status!==0){const code=r.stderr.match(/ERROR:\s+([A-Z0-9]{5}):/)?.[1]||'XX000';return Response.json({code},{status:400});}return Response.json(JSON.parse(r.stdout.trim()));}
  const table=name.split('?')[0];const select=u.searchParams.get('select')||'*';
  if(['profiles','market_study_observations','market_study_reviews'].includes(table)){
   assert.match(select,/^[a-z_,*]+$/);const filter=table==='profiles'?` where id='${admin}'`:table==='market_study_observations'?" where provider='synthetic-a' and external_id='http-offer'":'';const rows=json(`set role service_role;select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) from (select ${select} from ${table}${filter}) t;`);return Response.json(rows,{headers:{'content-range':'*/'+rows.length}});
  }
  return Response.json([],{headers:{'content-range':'*/0'}});
 };
 const handler=createResearchHandler({url:'https://synthetic-db.invalid',serviceRoleKey:'synthetic-server-only'},sqlTransport);
 httpServer=http.createServer(async(req,res)=>{try{const request=new Request('http://127.0.0.1'+req.url,{method:req.method,headers:req.headers,...(['GET','HEAD'].includes(req.method)?{}:{body:Readable.toWeb(req),duplex:'half'})});const response=await handler(request);res.writeHead(response.status,Object.fromEntries(response.headers));res.end(await response.text());}catch{res.writeHead(500);res.end('Synthetic HTTP bridge failed');}});
 await new Promise(resolve=>httpServer.listen(0,'127.0.0.1',resolve));report.httpPort=httpServer.address().port;const base=`http://127.0.0.1:${report.httpPort}/market-research`;
 const get=(route,key)=>fetch(base+route,{headers:key?{'X-Climactiva-Api-Key':key}:{}});
 const post=items=>fetch(base+'/observations',{method:'POST',headers:{'X-Climactiva-Api-Key':'synthetic-a','Content-Type':'application/json'},body:JSON.stringify({schema_version:1,observations:items})});
 assert.equal((await get('/catalog')).status,401);assert.equal((await get('/catalog','synthetic-b')).status,401);
 const catalog=await (await get('/catalog','synthetic-a')).json();assert.deepEqual(catalog.items.map(r=>r.sku),['SYN-A','VAR-A']);assert.ok(catalog.items.every(r=>!('price' in r)&&!('stock' in r)));
 let response=await post([fixture({external_id:'http-offer'})]);assert.equal(response.status,200);const inserted=await response.json();assert.equal(inserted.inserted,1);
 response=await post([fixture({external_id:'http-offer'})]);assert.equal((await response.json()).duplicates,1);
 assert.equal((await post([fixture({external_id:'http-offer',amount:120})])).status,409);assert.equal((await post([fixture({suggested_sku:'SYN-B'})])).status,403);assert.equal((await post([fixture({approved:true})])).status,422);
 mark('real loopback HTTP to handler and real PostgreSQL: authorization/catalog/ingest/idempotency/errors',{transport:'Node HTTP and injected SQL adapter; not Deno/PostgREST'});
 const administrative=createMarketHandler({rest:{url:'https://synthetic-db.invalid',anonKey:'synthetic-anon',serviceRoleKey:'synthetic-server-only'},origin:'http://127.0.0.1'},sqlTransport);
 const readAdmin=async()=>{const r=await administrative(new Request('https://synthetic-app.invalid/market-study/bootstrap',{headers:{authorization:'Bearer synthetic-operator'}}));assert.equal(r.status,200);return r.json();};
 let view=await readAdmin();assert.equal(view.observations[0].created_by,'API '+intA);assert.equal(view.observations[0].origin_api_key_id,keyA);assert.equal(view.reviews.length,0);
 const observation=view.observations[0].id;const review={observation_id:observation,request_id:'88888888-8888-4888-8888-888888888888',expected_review_id:null,decision:'approved',product_key:'current:SYN-A',sku:'SYN-A',unit:'unit',internal_quantity:1,equivalence_confirmed:true,cost_basis_confirmed:true,internal_fx:null,reason:'Synthetic operator checked equivalence.'};sql(`set role service_role;select market_study_review('${admin}',${quote(JSON.stringify(review))});`);
 assert.equal((await post([fixture({external_id:'http-offer',revision:2})])).status,200);view=await readAdmin();assert.equal(view.reviews.length,1);assert.equal(view.reviews[0].created_by,admin);assert.equal(view.reviews.some(r=>r.observation_id===view.observations.find(o=>o.payload.revision===2).id),false);mark('administrative read preserves API origin and human review; new API revision stays unverified');
 assert.deepEqual(json('select jsonb_agg(to_jsonb(p) order by sku) from content_products p'),baseline.catalog);mark('catalog and own prices unchanged after all research operations');
 report.passed=true;
} catch(error){report.passed=false;report.error=error.stack;console.error(error);process.exitCode=1;}
finally {
 if(httpServer){httpServer.closeAllConnections();await new Promise(resolve=>httpServer.close(resolve));}
 await Promise.allSettled(connections.map(c=>c.close()));
 if(started||fs.existsSync(path.join(data,'postmaster.pid'))){const stopped=run('pg_ctl',['stop','-D',data,'-m','fast','-w','-t','25'],undefined,true);report.stopExitCode=stopped.status;report.stopped=stopped.status===0;if(!report.stopped)process.exitCode=1;}
 report.pidFileAbsent=!fs.existsSync(path.join(data,'postmaster.pid'));report.finished_at=new Date().toISOString();writeReport();console.log(JSON.stringify({passed:report.passed,checks:report.checks.length,stopped:report.stopped,output}));
}
