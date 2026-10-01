import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import ts from 'typescript';
import { startFactoSyncRuntime, boundedFactoFetch } from '../supabase/functions/accounting-center/facto-sync-runtime.ts';
import { factoHistoryStatus } from '../src/modules/accounting/factoSyncStatus.ts';

const read = path => readFile(new URL('../' + path, import.meta.url), 'utf8');
const db = new PGlite();
const actor = '00000000-0000-4000-8000-000000000001';
await db.exec(`
  create role authenticated; create role service_role; create role anon;
  create schema auth; create schema storage;
  create type public.app_role as enum ('administrador','vendedor','visualizador');
  create table auth.users(id uuid primary key);
  insert into auth.users values ('${actor}');
  create table public.profiles(id uuid primary key,full_name text default '',role public.app_role default 'visualizador',active boolean default true);
  insert into public.profiles values ('${actor}','Synthetic','administrador',true);
  create function auth.uid() returns uuid language sql stable as $$ select '${actor}'::uuid $$;
  create function auth.role() returns text language sql stable as $$ select coalesce(nullif(current_setting('test.role',true),''),'service_role') $$;
  create function public.current_role() returns public.app_role language sql stable as $$ select 'administrador'::public.app_role $$;
  create table storage.buckets(id text primary key,name text,public boolean default false,file_size_limit bigint,allowed_mime_types text[]);
  create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text);
  create table public.accounting_snapshots(id uuid primary key default gen_random_uuid());
`);
const base = (await read('supabase/accounting_center.sql')).replace(/create extension if not exists pgcrypto;/i,'');
const split = base.indexOf('begin;');
await db.exec(base.slice(0,split)); await db.exec(base.slice(split));
await db.exec(await read('supabase/accounting_facto_history.sql'));
const migration = await read('supabase/accounting_facto_sync_safety.sql');
await db.exec(migration); await db.exec(migration); // Reapplication must preserve state.
const entity = (await db.query('select id from accounting_entities limit 1')).rows[0].id;
const claim = async (request = 'synthetic') => (await db.query(
  'select accounting_claim_facto_sync($1,$2,$3,$4,$5) result', [entity,'2026-01-01','2026-01-31',actor,request],
)).rows[0].result;
const setHeaders = async lease => db.query("select set_config('request.headers',$1,false)", [lease ? JSON.stringify({
  'x-facto-sync-run':lease.runId,'x-facto-sync-token':lease.token,
}) : '{}']);
const finish = (lease,status='completed') => db.query('select accounting_finish_facto_sync($1,$2,$3)',[lease.runId,lease.token,status]);
try {
  const [a,b] = await Promise.all([claim('a'),claim('b')]);
  assert.equal(a.acquired,true); assert.equal(b.acquired,false); assert.equal(b.runId,a.runId);
  assert.equal((await db.query("select count(*)::int n from accounting_facto_sync_runs where status='running'")).rows[0].n,1);
  await db.query('select accounting_heartbeat_facto_sync($1,$2)',[a.runId,a.token]);
  const source = (await db.query(`insert into accounting_source_documents(entity_id,source_type,source_key,document_type,status,total_clp,source_updated_at)
    values($1,'FACTO','facto:sale:synthetic','sales_invoice','posted',100,'2026-01-01') returning id`,[entity])).rows[0].id;
  await setHeaders(a);
  for(const status of ['posted','voided']) {
    await setHeaders(null); await db.query('update accounting_source_documents set status=$1 where id=$2',[status,source]); await setHeaders(a);
    await db.query(`insert into accounting_source_documents(entity_id,source_type,source_key,document_type,status,total_clp,source_updated_at)
      values($1,'FACTO','facto:sale:synthetic','sales_invoice','validated',200,'2026-02-01')
      on conflict(entity_id,source_type,source_key) do update set status=excluded.status,total_clp=excluded.total_clp,source_updated_at=excluded.source_updated_at`,[entity]);
    const row=(await db.query('select status,total_clp from accounting_source_documents where id=$1',[source])).rows[0];
    assert.equal(row.status,status); assert.equal(Number(row.total_clp),100);
  }
  // Simulates a post between the caller's read and its write: database state wins.
  await setHeaders(null); await db.query("update accounting_source_documents set status='validated' where id=$1",[source]);
  const previouslyRead=(await db.query('select status from accounting_source_documents where id=$1',[source])).rows[0];
  await db.query("update accounting_source_documents set status='posted' where id=$1",[source]); await setHeaders(a);
  await db.query('update accounting_source_documents set status=$1,total_clp=999 where id=$2',[previouslyRead.status,source]);
  assert.equal(Number((await db.query('select total_clp from accounting_source_documents where id=$1',[source])).rows[0].total_clp),100);
  await setHeaders(null); await db.query("update accounting_source_documents set status='validated',source_updated_at='2026-03-01' where id=$1",[source]); await setHeaders(a);
  await db.query("update accounting_source_documents set total_clp=99,source_updated_at='2026-02-01' where id=$1",[source]);
  assert.equal(Number((await db.query('select total_clp from accounting_source_documents where id=$1',[source])).rows[0].total_clp),100);
  await db.query("update accounting_source_documents set total_clp=150,source_updated_at='2026-04-01' where id=$1",[source]);
  assert.equal(Number((await db.query('select total_clp from accounting_source_documents where id=$1',[source])).rows[0].total_clp),150);
  await setHeaders({...a,token:crypto.randomUUID()});
  await assert.rejects(db.query('update accounting_source_documents set total_clp=999 where id=$1',[source]),/LEASE_LOST/);
  await setHeaders(null);
  await db.query("update accounting_facto_sync_leases set expires_at=clock_timestamp()-interval '1 second' where run_id=$1",[a.runId]);
  const c=await claim('replacement'); assert.equal(c.acquired,true); assert.notEqual(c.runId,a.runId);
  assert.equal((await db.query('select status from accounting_facto_sync_runs where id=$1',[a.runId])).rows[0].status,'failed');
  await setHeaders(a); await assert.rejects(db.query('update accounting_source_documents set total_clp=999 where id=$1',[source]),/LEASE_LOST/);
  await setHeaders(null); await assert.rejects(finish(a),/LEASE_LOST/);
  await finish(c,'cancelled');
  await assert.rejects(db.query('select accounting_heartbeat_facto_sync($1,$2)',[c.runId,c.token]),/LEASE_LOST/);
  const d=await claim('after-cancel'); assert.equal(d.acquired,true); await finish(d);
  const legacy=(await db.query(`insert into accounting_facto_sync_runs(entity_id,from_date,to_date,status,updated_at)
    values($1,'2026-01-01','2026-01-31','running','2020-01-01') returning id`,[entity])).rows[0].id;
  const blocked=await claim(); assert.equal(blocked.reason,'legacy_review_required'); assert.equal(blocked.runId,legacy);
  assert.equal((await db.query('select status from accounting_facto_sync_runs where id=$1',[legacy])).rows[0].status,'running');
  await db.exec("select set_config('test.role','authenticated',false)");
  await assert.rejects(claim(),/service_role_required/);
  const privileges=(await db.query(`select has_function_privilege('authenticated','accounting_claim_facto_sync(uuid,date,date,uuid,text)','EXECUTE') callable,
    has_table_privilege('authenticated','accounting_facto_sync_leases','SELECT') readable`)).rows[0];
  assert.equal(privileges.callable,false); assert.equal(privileges.readable,false);
  console.log('PASS SQL: one lease, heartbeat, protected states, posting race, stale source, expiry/recovery, fenced old writes, cancellation, legacy review, access controls');
} finally { await db.close(); }

const realFetch=globalThis.fetch;
try {
  globalThis.fetch=async (_url,init)=>new Promise((_resolve,reject)=>{
    if(init.signal.aborted) reject(init.signal.reason);
    else init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true});
  });
  await assert.rejects(boundedFactoFetch('https://synthetic.invalid',{},undefined,10),/TIMEOUT/);
  globalThis.fetch=async (_url,init)=>new Response(new ReadableStream({start(controller){
    init.signal.addEventListener('abort',()=>controller.error(init.signal.reason),{once:true});
  }}));
  await assert.rejects(boundedFactoFetch('https://synthetic.invalid',{},undefined,10),/TIMEOUT/);
  const lost=startFactoSyncRuntime(async()=>{throw Error('offline')},{heartbeatMs:5,deadlineMs:1000});
  await new Promise(r=>setTimeout(r,20)); assert.equal(lost.signal.aborted,true); await lost.stop();
  const deadline=startFactoSyncRuntime(async()=>{}, {heartbeatMs:1000,deadlineMs:5});
  await new Promise(r=>setTimeout(r,15)); assert.match(deadline.signal.reason.message,/DEADLINE/); await deadline.stop();
} finally { globalThis.fetch=realFetch; }
assert.equal(factoHistoryStatus({status:'cancelled'}).label,'Cancelada');
assert.match(factoHistoryStatus({status:'running',lease_expires_at:'2020-01-01'}).label,/Interrumpida/);
assert.match(factoHistoryStatus({status:'running',updated_at:'2020-01-01'}).label,/Sin actividad/);
assert.equal(factoHistoryStatus({status:'completed'}).label,'Completada');
console.log('PASS runtime: request timeout, lost heartbeat, total deadline; UI terminal and stale states');

// Execute the actual handler with synthetic dependencies, never Deno or live credentials.
const source=await read('supabase/functions/accounting-center/index.ts');
const ast=ts.createSourceFile('index.ts',source,ts.ScriptTarget.Latest,true);
const fn=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='syncFacto');
const js=ts.transpileModule(fn.getText(ast),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
for(const closeFails of [false,true]) {
  const calls=[];
  const deps={HttpError:class extends Error{constructor(status,message){super(message);this.status=status;}},
    requiredDate:v=>v,requiredUuid:v=>v,asObject:v=>v,selectRows:async()=>[{id:'entity'}],
    selectAllRows:async()=>{throw Error('synthetic read failure')},startFactoSyncRuntime,
    rpc:async(_rest,name,args)=>{calls.push({name,args});if(name==='accounting_claim_facto_sync')return {acquired:true,runId:'run',token:'token'};
      if(closeFails)throw Error('synthetic closure unavailable');return null;}};
  const handler=new Function(...Object.keys(deps),js+'; return syncFacto;')(...Object.values(deps));
  await assert.rejects(handler({}, {id:actor},'synthetic',{triggerType:'manual',fromDate:'2026-01-01',toDate:'2026-01-31'}),closeFails?/No se pudo confirmar el cierre/:/synthetic read failure/);
  assert.equal(calls.at(-1).args.p_status,'failed');
}
console.log('PASS handler: failure closed; unavailable close reported explicitly (no claimed rollback)');

for(const mode of ['success','protected','active','legacy']) {
  const calls=[];
  const protectedMode=mode==='protected';
  const deps={HttpError:class extends Error{constructor(status,message){super(message);this.status=status;}},
    requiredDate:v=>v,requiredUuid:v=>v,asObject:v=>v,requestIdToUuid:v=>v,dateTimeValue:v=>v,
    sha256Text:async()=> 'synthetic-hash',startFactoSyncRuntime,
    selectAllRows:async()=>protectedMode?[{id:'existing',source_key:'facto:sale:one',external_id:'one',status:'posted'}]:[],
    selectRows:async(_rest,path)=>path.startsWith('accounting_entities')?[{id:'entity'}]:
      protectedMode && path.includes('resource=eq.documents&')?[{id:'record',external_id:'one',payload:{},updated_at:'2026-01-20'}]:[],
    factoIdentity:()=>({purchase:false,externalId:'one'}),
    normalizeFactoDocument:()=>({issuedOn:'2026-01-10',documentType:'sales_invoice',errors:[]}),
    syncFactoReportedBalances:async()=>({updated:0,cleared:0}),
    patchRows:async(_rest,_table,_filter,row)=>{calls.push({name:'progress',row});return [];},
    insertRows:async()=>{calls.push({name:'audit'});return [];},
    upsertRowsMinimal:async(_rest,_table,rows)=>{calls.push({name:'backup',rows});return [];},
    upsertRowsSelected:async()=>{throw Error('protected source must not be upserted');},
    rpc:async(_rest,name,args)=>{calls.push({name,args});if(name==='accounting_claim_facto_sync')return {
      acquired:!['active','legacy'].includes(mode),runId:'run',token:'token',reason:mode==='legacy'?'legacy_review_required':'active',
    };return null;}};
  const handler=new Function(...Object.keys(deps),js+'; return syncFacto;')(...Object.values(deps));
  const invoke=()=>handler({}, {id:actor},'synthetic',{triggerType:'manual',fromDate:'2026-01-01',toDate:'2026-01-31'});
  if(['active','legacy'].includes(mode)) {
    await assert.rejects(invoke(),e=>e.status===409);assert.equal(calls.length,1);
  } else {
    const result=await invoke();
    assert.equal(result.status,protectedMode?'partial':'completed');
    assert.equal(calls.at(-1).name,'accounting_finish_facto_sync');
    assert.equal(calls.at(-1).args.p_status,result.status);
    assert.ok(calls.findIndex(c=>c.name==='audit')<calls.length-1);
    if(protectedMode){assert.equal(result.accepted,0);assert.equal(result.skipped,1);
      assert.equal(result.receivables,0);assert.equal(result.payables,0);
      assert.equal(calls.find(c=>c.name==='backup').rows[0].source_document_id,'existing');}
  }
}
console.log('PASS handler: terminal success after audit; protected rows skipped and recorded; active/legacy conflict before writes');
