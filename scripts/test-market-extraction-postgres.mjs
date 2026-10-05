import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const repo=fileURLToPath(new URL('..',import.meta.url));
const option=name=>process.argv.find(v=>v.startsWith('--'+name+'='))?.slice(name.length+3);
const bin=option('pg-bin');if(!bin)throw Error('Provide --pg-bin= for an already installed PostgreSQL distribution. No installation is performed.');
const output=path.resolve(repo,option('output')||'outputs/market-extraction/postgres');
assert.ok(output.startsWith(path.resolve(repo)+path.sep));fs.mkdirSync(output,{recursive:true});
const root=fs.mkdtempSync(path.join(os.tmpdir(),'market-extraction-pg-')),data=path.join(root,'data');
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
let started=false;
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
 const files=['schema.sql','agent_hub.sql','content_center.sql','agent_api_keys.sql','market_study.sql','market_research_api.sql','prospecting_deepseek_settings.sql'];report.schemaFiles=[];
 for(const file of files){const source=fs.readFileSync(path.join(repo,'supabase',file),'utf8');const prepared=source.replace(/create extension if not exists\s+"?pgcrypto"?\s*;/gi,'-- Installed pgcrypto.dll digest loaded above; extension registration files unavailable.');sql(prepared);report.schemaFiles.push({file,sha256:createHash('sha256').update(source).digest('hex'),adaptation:'Only CREATE EXTENSION pgcrypto omitted; real DLL digest provided in extensions schema'});}
 sql(`insert into auth.users values('${admin}');insert into profiles(id,full_name,role,active) values('${admin}','Synthetic administrator','administrador',true);
 insert into content_products(source_provider,external_id,payload_hash,sku,name,brand,price,stock,product_url,variants) values('tiendanube','synthetic-product-a','synthetic-hash','SYN-A','Synthetic product A','Synthetic',999,12,'https://climactiva.cl/productos/synthetic/','[{"sku":"VAR-A","price":888}]'),('tiendanube','synthetic-product-b','synthetic-hash','SYN-B','Synthetic product B','Synthetic',777,3,null,'[]');`);
 for(const [key,secret] of [[keyA,'synthetic-a'],[keyB,'synthetic-b'],[keyC,'synthetic-c']])sql(`insert into agent_api_keys(id,name,key_prefix,key_hash,scopes,expires_at) values(${quote(key)},${quote(secret)},${quote(secret)},encode(extensions.digest(${quote(secret)},'sha256'),'hex'),array['market-research:catalog:read','market-research:observations:write','market-research:extract'],now()+interval '7 days');`);
 const baseline=json("select jsonb_build_object('tables',(select count(*) from information_schema.tables where table_schema='public'),'catalog',(select jsonb_agg(to_jsonb(p) order by sku) from content_products p),'observations',(select jsonb_agg(to_jsonb(o)) from market_study_observations o));");
 mark('complete relevant repository DDL loaded with real profiles/catalog/API key schemas',{public_tables:baseline.tables,sourceFiles:files});

 const migration=fs.readFileSync(path.join(repo,'supabase/market_extraction.sql'),'utf8');
 const accessBefore=json("select to_json(pg_get_functiondef('market_research_access(uuid,text)'::regprocedure));");
 sql(migration.replace(/commit;\s*$/i,'rollback;'));
 assert.equal(json("select coalesce(to_json(to_regclass('public.market_extraction_jobs')),'null'::json)"),null);
 assert.equal(json("select to_json(pg_get_functiondef('market_research_access(uuid,text)'::regprocedure));"),accessBefore);
 const failed=run('psql',pgArgs(database),migration.replace(/commit;\s*$/i,'select 1/0;commit;'),true);assert.notEqual(failed.status,0);
 assert.equal(json("select coalesce(to_json(to_regclass('public.market_extraction_policy')),'null'::json)"),null);
 assert.deepEqual(json('select jsonb_agg(to_jsonb(p) order by sku) from content_products p'),baseline.catalog);
 mark('new extraction DDL: explicit rollback and forced-failure rollback preserve dependency schema/function/catalog');
 sql(migration);report.schemaFiles.push({file:'market_extraction.sql',sha256:createHash('sha256').update(migration).digest('hex'),adaptation:'none'});
 assert.equal(json('select to_json(enabled) from market_extraction_policy'),false);
 assert.equal(json('select to_json(count(*)) from market_research_integrations'),0);
 mark('real extraction migration succeeds; pilot off, no real bindings or credentials created');
 for(const [id,key,provider,skus] of [[intA,keyA,'synthetic-a',['SYN-A']],[intB,keyB,'synthetic-b',['SYN-B']]])sql(`insert into market_research_integrations(id,api_key_id,provider,allowed_skus,active,authorized_by,expires_at) values(${quote(id)},${quote(key)},${quote(provider)},array[${skus.map(quote).join(',')}],true,'${admin}',now()+interval '1 day');`);
 const selection={choice:'deepseek:deepseek-flash',provider:'deepseek',model:'deepseek-flash',input_usd_per_million:.3,output_usd_per_million:1.2,rate_source:'Synthetic fixed test tariff',rate_checked_at:new Date().toISOString().slice(0,10)};
 const jobId=n=>`bbbbbbbb-bbbb-4bbb-8bbb-${String(n).padStart(12,'0')}`,batchId=n=>`aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12,'0')}`;
 const reserve=(n,{batch=1,revision=1,hash='synthetic-'+n,key=keyA,sku='SYN-A',choice=selection}={})=>`select market_extraction_reserve('${key}','${jobId(n)}','${batchId(batch)}',${revision},${quote(hash)},${quote(sku)},'https://competidor.example/producto','competidor.example',${quote(JSON.stringify(choice))},5000);`;
 const finish=(receipt,state='completed',cost=.0001)=>`select market_extraction_finish('${receipt.integration_id}','${receipt.job.job_id}','${receipt.ticket}',${quote(state)},'[]',${state==='completed'?100:'null'},${state==='completed'?50:'null'},${state==='completed'?cost:'null'},${state==='completed'?'null':"'SYNTHETIC_UNCERTAIN'"});`;
 const a=new Connection('A'),b=new Connection('B');const pidA=await a.json('select to_json(pg_backend_pid());'),pidB=await b.json('select to_json(pg_backend_pid());');assert.notEqual(pidA,pidB);report.concurrentPids=[pidA,pidB];
 const waitBlocked=async(label)=>{for(let i=0;i<40;i++){const pids=json(`select to_json(pg_blocking_pids(${pidB}));`);if(pids.includes(pidA)){const activity=json(`select json_build_object('pid',pid,'wait_event_type',wait_event_type,'wait_event',wait_event) from pg_stat_activity where pid=${pidB}`);(report.concurrentWaits??=[]).push({scenario:label,blocker:pidA,waiter:pidB,blockingPids:pids,...activity});return;}await new Promise(r=>setTimeout(r,50));}throw Error('No real blocking for '+label);};
 const begin=async c=>c.ok('begin;set local role service_role;set local statement_timeout=15000;');
 assert.equal((await a.query('set role service_role;'+reserve(1))).state,'55000');await a.ok('reset role;');mark('disabled pilot refuses real SQL reservation');
 sql("update market_extraction_policy set enabled=true,approved_until=now()+interval '1 hour',public_hosts=array['competidor.example'];");
 const first=await a.json('set role service_role;'+reserve(1));assert.equal(first.created,true);await a.ok(finish(first));const replay=await a.json(reserve(1));assert.equal(replay.created,false);assert.equal(replay.job.state,'completed');assert.equal((await a.query(reserve(1,{hash:'different'}))).state,'23505');await a.ok('reset role;');mark('real SQL reservation, settlement, idempotent receipt and identity conflict');
 await begin(a);const winning=await a.json(reserve(2));await begin(b);const same=b.query(reserve(2));await waitBlocked('same job');await a.ok('commit;');const sameResult=await same;assert.equal(sameResult.state,'00000');assert.equal(JSON.parse(sameResult.rows.at(-1)).created,false);await b.ok('commit;');sql(finish(winning));mark('two connections: duplicate waits and returns exactly one reservation');
 await begin(a);const conflicting=await a.json(reserve(3));await begin(b);const changed=b.query(reserve(3,{hash:'changed'}));await waitBlocked('conflict');await a.ok('commit;');assert.equal((await changed).state,'23505');await b.ok('rollback;');sql(finish(conflicting));mark('two connections: conflicting identity rejects after commit');
 await begin(a);await a.ok(reserve(4));await begin(b);const rolled=b.query(reserve(4));await waitBlocked('rollback');await a.ok('rollback;');const rolledResult=await rolled;assert.equal(rolledResult.state,'00000');const afterRollback=JSON.parse(rolledResult.rows.at(-1));assert.equal(afterRollback.created,true);await b.ok('commit;');sql(finish(afterRollback));mark('two connections: rollback leaves no charge; waiter claims once');
 await begin(a);const occupied=await a.json(reserve(5));await begin(b);const busy=b.query(reserve(6));await waitBlocked('global concurrency');await a.ok('commit;');assert.equal((await busy).state,'P0002');await b.ok('rollback;');sql(finish(occupied));assert.equal(json(`select to_json(count(*)) from market_extraction_jobs where job_id='${jobId(6)}'`),0);mark('two connections: global one-job concurrency limit enforced');
 const used=Number(json('select to_json(sum(coalesce(estimated_usd,reserved_usd))) from market_extraction_jobs'));const reserveUsd=5000*.3/1e6+1024*1.2/1e6;
 sql(`update market_extraction_policy set pilot_usd=${used+reserveUsd*1.5};`);
 await begin(a);const budgetWinner=await a.json(reserve(7));await a.ok(finish(budgetWinner,'unknown'));await begin(b);const budgetLoser=b.query(reserve(8));await waitBlocked('last budget slot');await a.ok('commit;');const budgetResult=await budgetLoser;assert.equal(budgetResult.state,'P0002');assert.match(budgetResult.error,/budget or quota/);await b.ok('rollback;');sql('update market_extraction_policy set pilot_usd=5;');mark('two connections: competing budget reservation cannot overspend; unknown retains reserve');
 await begin(a);const pinned=await a.json(reserve(9,{batch:2}));await begin(b);const selecting=b.query(`select market_extraction_select('${admin}',1,'deepseek:deepseek-v4-pro');`);await waitBlocked('manual selection vs reservation');await a.ok('commit;');assert.equal((await selecting).state,'00000');await b.ok('commit;');sql(finish(pinned));
 const pro={...selection,choice:'deepseek:deepseek-v4-pro',model:'deepseek-v4-pro',input_usd_per_million:1.32,output_usd_per_million:3.96};
 const oldBatch=json(reserve(10,{batch:2,choice:pro}));assert.equal(oldBatch.selection.model,'deepseek-flash');assert.equal(oldBatch.selection.revision,1);sql(finish(oldBatch));
 assert.equal((await a.query(reserve(11,{batch:3,choice:pro}))).state,'40001');
 const newBatch=json(reserve(11,{batch:3,revision:2,choice:pro}));assert.equal(newBatch.selection.model,'deepseek-v4-pro');sql(finish(newBatch));mark('manual change serializes with reservation; existing batch fixed and new batch revision checked');
 await a.ok('begin;select pg_advisory_xact_lock(81734001);');await begin(b);const revoked=b.query(reserve(12,{batch:4,revision:2,key:keyB,sku:'SYN-B',choice:pro}));await waitBlocked('revoke while waiting');sql(`set request.jwt.claim.sub='${admin}';select revoke_agent_api_key('${keyB}');`);await a.ok('commit;');assert.equal((await revoked).state,'42501');await b.ok('rollback;');mark('revocation rechecked after real lock wait, before new reservation');
 const unfinished=json(reserve(13,{batch:2}));sql(`update market_extraction_jobs set created_at=now()-interval '3 minutes' where job_id='${jobId(13)}';`);const expired=json(reserve(13,{batch:2}));assert.equal(expired.created,false);assert.equal(expired.job.state,'unknown');assert.equal(expired.job.estimated_usd,null);assert.equal(Number(expired.job.reserved_usd),Number(unfinished.job.reserved_usd));mark('abandoned real reservation returns unknown, retains charge and never reclaims');
 const beforeTx=json('select to_json(count(*)) from market_extraction_jobs');await begin(a);await a.ok(reserve(14,{batch:2}));await a.ok('rollback;');assert.equal(json('select to_json(count(*)) from market_extraction_jobs'),beforeTx);mark('data rollback leaves no new job or ledger charge');
 for(const r of ['anon','authenticated']){assert.equal((await a.query(`set role ${r};select * from market_extraction_jobs;`)).state,'42501');await a.ok('reset role;');assert.equal((await a.query(`set role ${r};select market_extraction_select('${admin}',2,'deepseek:deepseek-flash');`)).state,'42501');await a.ok('reset role;');}
 sql(`update profiles set active=false where id='${admin}';`);assert.equal((await a.query(reserve(15,{batch:2}))).state,'42501');sql(`update profiles set active=true where id='${admin}';`);
 assert.ok(json("select jsonb_agg(relrowsecurity) from pg_class where relname like 'market_extraction_%' and relkind='r'").every(Boolean));mark('real RLS/grants and inactive-authorizer denial');
 assert.deepEqual(json('select jsonb_agg(to_jsonb(p) order by sku) from content_products p'),baseline.catalog);mark('catalog, stock and own prices unchanged by all extraction scenarios');
 report.passed=true;
}catch(error){report.passed=false;report.error=error.stack;console.error(error);process.exitCode=1;}
finally{
 await Promise.allSettled(connections.map(c=>c.close()));
 if(started||fs.existsSync(path.join(data,'postmaster.pid'))){const r=run('pg_ctl',['stop','-D',data,'-m','fast','-w','-t','25'],undefined,true);report.stopExitCode=r.status;report.stopped=r.status===0;}
 report.pidFileAbsent=!fs.existsSync(path.join(data,'postmaster.pid'));
 report.portClosed=await new Promise(resolve=>{const socket=net.connect({host:'127.0.0.1',port});socket.setTimeout(2000);socket.once('connect',()=>{socket.destroy();resolve(false);});socket.once('error',e=>resolve(e.code==='ECONNREFUSED'));socket.once('timeout',()=>{socket.destroy();resolve(false);});});
 // Only the newly created owned temp cluster may be removed; retain reports outside it.
 const actual=fs.realpathSync(root),temp=fs.realpathSync(os.tmpdir());
 if(report.stopped&&report.pidFileAbsent&&report.portClosed&&path.dirname(actual).toLowerCase()===temp.toLowerCase()&&path.basename(actual).startsWith('market-extraction-pg-')){fs.rmSync(actual,{recursive:true,force:false});report.temporaryClusterRemoved=!fs.existsSync(actual);}
 if(!report.stopped||!report.portClosed||!report.temporaryClusterRemoved)process.exitCode=1;
 report.finished_at=new Date().toISOString();writeReport();console.log(JSON.stringify({passed:report.passed,checks:report.checks.length,stopped:report.stopped,portClosed:report.portClosed,temporaryClusterRemoved:report.temporaryClusterRemoved,output}));
}
