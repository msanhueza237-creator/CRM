import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
const actor='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222';
test('Refresh atomic ledger: permissions, history, conflicts, idempotency and immutable receipts',async()=>{
 const db=new PGlite();try{
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create table profiles(id uuid primary key,role text,active boolean);insert into profiles values('${actor}','administrador',true);grant select on profiles to service_role;create table market_extraction_policy(revision int,choice text);grant select on market_extraction_policy to service_role;`);
 await db.exec(await readFile(new URL('../supabase/market_native_studies.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../supabase/market_native_source_refresh.sql',import.meta.url),'utf8'));
 const original={kind:'market_search',offers:[{url:'https://fixture.cl/producto',amount:10}],queries:['literal'],coverage:'original'};
 await db.query(`insert into market_native_jobs(id,actor,input_hash,sku,source_url,selection,state,reserved_usd,result,finished_at) values($1,$2,'hash','SYN','https://fixture.cl/producto','{}','completed',.25,$3,now())`,[id,actor,JSON.stringify(original)]);
 const call=async(action,data)=>(await db.query('select market_native_sources_refresh($1,$2,$3) r',[actor,action,JSON.stringify(data)])).rows[0].r;
 const data={id,revision:0,request_id:crypto.randomUUID()};
 await db.exec('set role service_role');const prepared=await call('prepare',data);assert.deepEqual(prepared.job.result,original);
 const competing={...data,request_id:crypto.randomUUID()};assert.deepEqual((await call('prepare',competing)).job,prepared.job);
 await assert.rejects(call('commit',{...data,result:{offers:'bad'}}),/Invalid refreshed/);
 assert.deepEqual((await call('prepare',data)).job,prepared.job);
 const done=await call('commit',{...data,result:{offers:[{url:'https://fixture.cl/producto',amount:20}],queries:['malicious'],coverage:'overwritten'}});
 await assert.rejects(call('commit',{...competing,result:{offers:[]}}),/revision conflict/);
 assert.equal(done.job.result.source_revision,1);assert.deepEqual(done.job.result.queries,['literal']);assert.equal(done.job.result.coverage,'original');assert.equal(done.job.finished_at,prepared.job.finished_at);assert.equal(done.job.reserved_usd,prepared.job.reserved_usd);
 assert.deepEqual((await call('prepare',data)).job,done.job);assert.deepEqual((await call('commit',{...data,result:{offers:[]}})).job,done.job);
 await assert.rejects(call('prepare',{...data,revision:1}),/identity conflict/);
 await assert.rejects(call('commit',{...data,request_id:crypto.randomUUID(),result:{offers:[]}}),/revision conflict/);
 const next=await call('commit',{id,revision:1,request_id:crypto.randomUUID(),result:{offers:[]}});assert.equal(next.job.result.source_revision,2);
 const ledger=(await db.query('select * from market_native_source_revisions order by revision')).rows;assert.equal(ledger.length,2);assert.deepEqual(ledger[0].previous_job.result,original);assert.deepEqual(ledger[1].previous_job,done.job);assert.equal(next.job.result.source_history.length,2);
 // Force an error after the job UPDATE: PostgreSQL must roll back that UPDATE with the failed ledger INSERT.
 await db.exec('reset role');
 await db.exec(`create function fail_refresh_ledger_fixture() returns trigger language plpgsql as $$begin raise exception 'synthetic ledger insert failure';end$$;create trigger fail_refresh_fixture before insert on market_native_source_revisions for each row execute function fail_refresh_ledger_fixture();set role service_role`);
 const interrupted={id,revision:2,request_id:crypto.randomUUID()};
 await assert.rejects(call('commit',{...interrupted,result:{offers:[{url:'https://fixture.cl/changed',amount:99}]}}),/synthetic ledger insert failure/);
 assert.deepEqual((await call('prepare',interrupted)).job,next.job);assert.equal((await db.query('select count(*) n from market_native_source_revisions')).rows[0].n,2);
 await db.exec('reset role');await db.exec('drop trigger fail_refresh_fixture on market_native_source_revisions;drop function fail_refresh_ledger_fixture()');
 // Reapplying the extension preserves existing rows and restores exact ACLs.
 await db.exec(await readFile(new URL('../supabase/market_native_source_refresh.sql',import.meta.url),'utf8'));
 assert.equal((await db.query("select relrowsecurity from pg_class where oid='market_native_source_revisions'::regclass")).rows[0].relrowsecurity,true);
 assert.equal((await db.query("select prosecdef from pg_proc where oid='market_native_sources_refresh(uuid,text,jsonb)'::regprocedure")).rows[0].prosecdef,false);
 await db.exec('set role service_role');assert.deepEqual((await call('prepare',interrupted)).job,next.job);assert.equal((await db.query('select count(*) n from market_native_source_revisions')).rows[0].n,2);
 await assert.rejects(db.query('delete from market_native_source_revisions'),/permission denied/);
 await assert.rejects(db.query("update market_native_source_revisions set revision=99"),/permission denied/);
 await db.exec('reset role');for(const role of ['anon','authenticated']){await db.exec('set role '+role);await assert.rejects(call('prepare',data),/permission denied/);await assert.rejects(db.query('select * from market_native_source_revisions'),/permission denied/);await assert.rejects(db.query('delete from market_native_source_revisions'),/permission denied/);await assert.rejects(db.query("insert into market_native_source_revisions(request_id) values(gen_random_uuid())"),/permission denied/);await db.exec('reset role');}
 await db.exec(`update profiles set active=false where id='${actor}';set role service_role`);await assert.rejects(call('prepare',data),/Forbidden/);
 }finally{await db.close();}
});
