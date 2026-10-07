import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { summarizeWhatsAppDelivery, getWhatsAppDelivery } from '../supabase/functions/crm-agent/whatsapp-delivery.ts';
import { whatsappDispatchId } from '../supabase/functions/crm-agent/whatsapp-meta.ts';
import { splitWhatsAppEvents } from '../supabase/functions/_shared/whatsapp-content.ts';

const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const receipt=(mid,status,time='1791340000')=>({object:'whatsapp_business_account',entry:[{id:'waba',changes:[{field:'messages',value:{metadata:{phone_number_id:'phone'},statuses:[{id:mid,status,timestamp:time,recipient_id:'56912345678',pricing:{category:'marketing'}}]}}]}]});
async function database(beforeMigration){
  const db=new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create table profiles(id uuid primary key,role text,active boolean);
    create table companies(id uuid primary key,name text,contact_name text,source text,status text,whatsapp text,phone text);
    create table contacts(id uuid primary key,company_id uuid,full_name text,whatsapp text,phone text);
    create table campaigns(id uuid primary key);
    create table activity_logs(id uuid default gen_random_uuid(),actor_id uuid,entity_type text,entity_id uuid,action text,metadata jsonb);
    create function public.current_role() returns text language sql as $$select 'administrador'::text$$;
    create function public.set_updated_at() returns trigger language plpgsql as $$begin new.updated_at=now();return new;end$$;`);
  for(const file of ['supabase/whatsapp_meta_integration.sql','supabase/whatsapp_meta_production_setup.sql','supabase/migrations/20261007005501_whatsapp_inbox_reads.sql','supabase/migrations/20261007012541_whatsapp_template_management.sql']) {
    // Production setup also refers to unrelated tables; only its unique message index is needed here.
    if(file.endsWith('whatsapp_meta_production_setup.sql'))await db.exec('create unique index whatsapp_messages_meta_message_id_unique on whatsapp_messages(meta_message_id) where meta_message_id is not null;');
    else await db.exec(fs.readFileSync(file,'utf8'));
  }
  await db.exec(`grant all on all tables in schema public to service_role; insert into companies(id,name,phone) values('${id(10)}','Prueba','56912345678');`);
  if(beforeMigration)await beforeMigration(db);
  await db.exec(fs.readFileSync('supabase/migrations/20261007145604_whatsapp_delivery_receipts.sql','utf8'));
  return db;
}
const add=(db,mid,status='accepted')=>db.query("insert into whatsapp_messages(company_id,phone_number,direction,meta_message_id,status,provider_response,raw_payload) values($1,'56912345678','outbound',$2,$3,'{\"messages\":[{\"id\":\"original\"}]}','{\"campaign_id\":\"keep\"}')",[id(10),mid,status]);
const apply=(db,mid,status,time)=>db.query('select crm_whatsapp_message_status($1,$2) result',[mid,receipt(mid,status,time)]);

test('signed receipts: duplicates, out of order, timestamps, failures and access control',async()=>{
  const db=await database();try{
    await add(db,'m1');
    await apply(db,'m1','read','1791340200');
    await apply(db,'m1','read','1791340200');
    await apply(db,'m1','delivered','1791340100');
    await apply(db,'m1','sent','1791340000');
    await apply(db,'m1','failed','1791340300');
    const row=(await db.query("select * from whatsapp_messages where meta_message_id='m1'")).rows[0];
    assert.equal(row.status,'read');assert.ok(row.sent_at);assert.ok(row.delivered_at);assert.ok(row.read_at);
    assert.equal(new Date(row.read_at).getTime(),1791340200000);
    assert.equal(row.provider_response.messages[0].id,'original');assert.equal(row.raw_payload.campaign_id,'keep');
    assert.equal((await db.query('select count(*)::int n from whatsapp_webhook_events')).rows[0].n,4);
    assert.equal((await db.query('select count(*)::int n from whatsapp_webhook_events where not processed')).rows[0].n,0);
    await add(db,'m2');await apply(db,'m2','failed');await apply(db,'m2','sent');
    assert.equal((await db.query("select status from whatsapp_messages where meta_message_id='m2'")).rows[0].status,'failed');
    await apply(db,'m2','delivered');
    assert.equal((await db.query("select status from whatsapp_messages where meta_message_id='m2'")).rows[0].status,'delivered');
    assert.equal((await apply(db,'m2','new_future_status')).rows[0].result.ignored,true);
    await assert.rejects(apply(db,'m2','read','invalid'));
    const wrong=receipt('m2','read');wrong.entry[0].changes[0].value.statuses[0].recipient_id='56999999999';
    await assert.rejects(db.query('select crm_whatsapp_message_status($1,$2)',['m2',wrong]));
    await db.exec('set role authenticated');
    await assert.rejects(apply(db,'m2','read'));
    await assert.rejects(db.query('select read_at from whatsapp_messages'));
  }finally{await db.close();}
});
test('early webhook stays durable and replays when acceptance is saved',async()=>{
  const db=await database();try{
    assert.equal((await apply(db,'early','read')).rows[0].result.processed,false);
    await add(db,null,'pending');
    await db.query("update whatsapp_messages set meta_message_id='early',status='accepted' where meta_message_id is null");
    const row=(await db.query("select status,read_at from whatsapp_messages where meta_message_id='early'")).rows[0];
    assert.equal(row.status,'read');assert.ok(row.read_at);
    assert.equal((await db.query('select processed from whatsapp_webhook_events')).rows[0].processed,true);
    await apply(db,'early','read');assert.equal((await db.query('select count(*)::int n from whatsapp_webhook_events')).rows[0].n,1);
  }finally{await db.close();}
});
test('all receipts in a batched webhook are extracted',()=>{
  const payload=receipt('a','sent');
  payload.entry[0].changes[0].value.statuses.push({id:'b',status:'delivered',timestamp:'1791340000'});
  payload.entry.push(receipt('c','read').entry[0]);
  assert.equal(splitWhatsAppEvents(payload).length,3);
});
test('migration reconstructs historical receipts and service role can process later events',async()=>{
  const db=await database(async db=>{
    await add(db,'historical','read');
    await db.query("insert into whatsapp_webhook_events(event_type,meta_message_id,payload,processed) values('status','historical',$1,true)",[receipt('historical','read')]);
  });try{
    assert.ok((await db.query("select read_at from whatsapp_messages where meta_message_id='historical'")).rows[0].read_at);
    await db.exec('set role service_role');
    await apply(db,'historical','sent','1791339990');
    const row=(await db.query("select status,sent_at from whatsapp_messages where meta_message_id='historical'")).rows[0];
    assert.equal(row.status,'read');assert.ok(row.sent_at);
  }finally{await db.close();}
});
test('metrics count unique messages, cumulative delivery, confirmed people; never infer a read',()=>{
  const base={id:'a',meta_message_id:'wa',phone_number:'+56912345678',status:'accepted',template_name:'offer',template_language:'es_CL',template_meta_id:'t',sent_at:null,delivered_at:null,read_at:null,failed_at:null};
  const read={...base,status:'read',read_at:'2026-10-07T10:00:00Z'};
  const result=summarizeWhatsAppDelivery([read,read,{...base,id:'b',meta_message_id:'wb',phone_number:'56912345678',read_at:read.read_at},{...base,id:'c',meta_message_id:'wc',status:'sent'},{...base,id:'d',meta_message_id:'wd',status:'delivered',delivered_at:read.read_at}]);
  assert.equal(result.accepted,4);assert.equal(result.sent,3);assert.equal(result.delivered,3);assert.equal(result.read,2);
  assert.equal(result.readRecipients,1);assert.equal(result.readRate,2/3);assert.equal(result.pending,1);
  assert.equal(result.templates[0].read,2);
});
test('campaign reader rejects invalid identity and partial/failed reads',async()=>{
  await assert.rejects(getWhatsAppDelivery({},'invalid'));
  const db={from:()=>({select(){return this},eq(){return this},maybeSingle:async()=>({data:{id:id(1)}}),contains(){return this},order(){return this},range:async()=>({error:{message:'db failure'}})})};
  await assert.rejects(getWhatsAppDelivery(db,id(1)),/confirmaciones/);
});

test('legacy campaign membership requires the exact dispatch ID, including later pages',async()=>{
  const campaignId=id(1), phone='56912345678';
  const base={meta_message_id:'legacy',phone_number:phone,status:'read',template_name:'offer',template_language:null,template_meta_id:null,sent_at:null,delivered_at:null,read_at:'2026-10-07T10:00:00Z',failed_at:null};
  const legacyRows=Array.from({length:500},(_,n)=>({...base,id:id(n+100),meta_message_id:`unrelated-${n}`}));
  legacyRows.push({...base,id:await whatsappDispatchId(campaignId,phone)});
  legacyRows.push({...base,id:await whatsappDispatchId(id(2),phone),meta_message_id:'other-campaign'});
  const modernRows=[{...base,id:id(3),meta_message_id:'modern',template_language:'es_CL'}];
  const reads=[];
  let failLegacy=false;
  const db={from(table){
    let legacy=false;
    return {
      select(){return this},
      eq(column,value){if(table==='whatsapp_messages')assert.ok((column==='direction' && value==='outbound') || (column==='message_type' && value==='template'));return this},
      maybeSingle:async()=>({data:{id:campaignId}}),
      contains(column,value){assert.equal(column,'raw_payload');assert.deepEqual(value,{campaign_id:campaignId});return this},
      is(column,value){assert.equal(column,'raw_payload->>campaign_id');assert.equal(value,null);legacy=true;return this},
      order(){return this},
      async range(from,to){reads.push({legacy,from,to});return legacy && failLegacy ? {error:{message:'failed'}} : {data:(legacy ? legacyRows : modernRows).slice(from,to+1)}}
    };
  }};
  const result=await getWhatsAppDelivery(db,campaignId);
  assert.equal(result.accepted,2);assert.equal(result.read,2);assert.equal(result.readRecipients,1);
  assert.equal(result.templates.find(t=>t.language==='Sin idioma').read,1);
  assert.deepEqual(reads,[{legacy:false,from:0,to:499},{legacy:true,from:0,to:499},{legacy:true,from:500,to:999}]);
  failLegacy=true;
  await assert.rejects(getWhatsAppDelivery(db,campaignId),/confirmaciones/);
});
