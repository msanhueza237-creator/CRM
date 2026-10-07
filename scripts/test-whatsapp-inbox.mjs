import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {getWhatsAppInbox, setWhatsAppRead} from '../supabase/functions/crm-agent/whatsapp-inbox.ts';
import {getWhatsAppConversation} from '../supabase/functions/crm-agent/whatsapp-conversation.ts';

const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const admin=id(1),other=id(2),company=id(10),newCompany=id(11),phone='56912345678';
const migration=fs.readFileSync('supabase/migrations/20261007005501_whatsapp_inbox_reads.sql','utf8');
async function fixture() {
  const db=new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create table profiles(id uuid primary key,role text,active boolean);
    create table companies(id uuid primary key,name text,contact_name text,source text,status text,whatsapp_opt_in boolean default false);
    create table contacts(company_id uuid,full_name text,whatsapp text,phone text);
    create table whatsapp_messages(id uuid primary key,company_id uuid,phone_number text,direction text,body text,message_type text,status text,occurred_at timestamptz,created_at timestamptz default now());
    grant select on profiles,companies,contacts,whatsapp_messages to service_role;
    insert into profiles values('${admin}','administrador',true),('${other}','administrador',true),('${id(3)}','administrador',false),('${id(4)}','vendedor',true);
    insert into companies(id,name,source,status) values('${company}','Empresa conocida','manual','cliente'),('${newCompany}','Contacto WhatsApp (56911111111)','whatsapp_webhook','prospecto');
    insert into contacts values('${company}','José Pérez',null,'+56 9 1234 5678');
    insert into whatsapp_messages values
      ('${id(20)}','${company}','${phone}','inbound','Primera consulta','text','received','2026-10-06 10:00Z',now()),
      ('${id(21)}','${company}','+${phone}','outbound','Respuesta','text','read','2026-10-06 11:00Z',now()),
      ('${id(22)}','${newCompany}','56911111111','inbound',null,'order','received','2026-10-06 12:00Z',now()),
      ('${id(23)}',null,'912345679','inbound','Sin ficha','text','received','2026-10-06 13:00Z',now()),
      ('${id(24)}','${company}','56987654321','outbound','Otra persona','text','sent','2026-10-06 14:00Z',now());`);
  await db.exec(migration);
  const inbox=async (user=admin,search='',filter='all',offset=0,limit=30)=>(await db.query('select crm_whatsapp_inbox($1,$2,$3,$4,$5) value',[user,search,filter,offset,limit])).rows[0].value;
  const read=async (ids,user=admin,c=company,p=phone,value=true)=>(await db.query('select crm_whatsapp_set_read($1,$2,$3,$4,$5) value',[user,c,p,ids,value])).rows[0].value;
  return {db,inbox,read};
}
test('SQL inbox includes all senders, no campaign required, stable order and exact pagination',async()=>{
  const {db,inbox}=await fixture();try {
    const result=await inbox();assert.deepEqual(result.summary,{conversations:4,unreadMessages:3,unreadConversations:3,newContacts:1});
    assert.equal(result.conversations[0].phone,'56987654321');assert.equal(result.conversations[1].companyId,null);assert.equal(result.conversations[1].phone,'56912345679');
    assert.equal(result.conversations.at(-1).name,'José Pérez');assert.equal(result.conversations.at(-1).preview,'Respuesta');assert.equal(result.conversations.at(-1).unreadCount,1);
    assert.equal((await inbox(admin,'','all',1,2)).conversations.length,2);assert.equal((await inbox(admin,'','all',0,0)).conversations.length,0);
    assert.equal((await inbox(admin,'','new')).total,1);assert.equal((await inbox(admin,'','unread')).total,3);
    assert.equal((await inbox(admin,'jose perez')).total,1);assert.equal((await inbox(admin,'+56 9 1234 5678')).total,1);assert.equal((await inbox(admin,'----')).total,0);
    assert.equal((await inbox(admin,"'; delete from companies; --")).total,0);
  } finally {await db.close()}
});
test('SQL exact read receipts are idempotent, per-user and preserve newly arriving messages',async()=>{
  const {db,inbox,read}=await fixture();try {
    assert.equal(await read([id(20)]),1);await read([id(20)]);assert.equal((await inbox()).summary.unreadMessages,2);assert.equal((await inbox(other)).summary.unreadMessages,3);
    await db.query(`insert into whatsapp_messages(id,company_id,phone_number,direction,body,occurred_at) values($1,$2,$3,'inbound','Nueva consulta',now())`,[id(25),company,phone]);
    await read([id(20)]);assert.equal((await inbox()).summary.unreadMessages,3);
    await read([id(20)],admin,company,phone,false);assert.equal((await inbox()).summary.unreadMessages,4);
    await read([id(23)],admin,null,'56912345679');assert.equal((await inbox()).summary.unreadMessages,3);
    assert.equal((await db.query('select count(*)::int n from whatsapp_messages')).rows[0].n,6);
    assert.equal((await db.query('select count(*)::int n from companies where whatsapp_opt_in')).rows[0].n,0);
    assert.equal((await db.query('select status from whatsapp_messages where id=$1',[id(21)])).rows[0].status,'read');
  } finally {await db.close()}
});
test('SQL rejects mismatched, outbound, duplicate receipts, inactive users and direct client access',async()=>{
  const {db,inbox,read}=await fixture();try {
    for(const args of [[[id(21)]],[[id(20),id(20)]],[[id(20)],admin,newCompany],[[id(20)],admin,company,'56911111111'],[[],admin],[[id(20)],id(3)],[[id(20)],id(4)]])await assert.rejects(read(...args));
    await assert.rejects(inbox(id(3)));await assert.rejects(inbox(id(4)));await assert.rejects(inbox(admin,'','invalid'));await assert.rejects(inbox(admin,'','all',-1));
    const flags=await db.query("select relrowsecurity from pg_class where relname='whatsapp_message_reads'");assert.equal(flags.rows[0].relrowsecurity,true);
    assert.equal((await db.query("select count(*)::int n from pg_proc where proname like 'crm_whatsapp_%' and prosecdef")).rows[0].n,0);
    await db.exec('set role authenticated');await assert.rejects(db.query('select * from whatsapp_message_reads'));await assert.rejects(inbox());
    await db.exec('reset role; set role service_role');assert.equal((await inbox()).total,4);await read([id(20)]);
  } finally {await db.close()}
});
test('Edge binds caller identity, validates before RPC, and never exposes RPC errors',async()=>{
  let calls=0;const db={rpc:async(name,p)=>{calls++;assert.equal(p.p_user_id,admin);return{data:name==='crm_whatsapp_inbox'?{conversations:[],summary:{}}:p.p_message_ids.length}}};
  await getWhatsAppInbox(db,admin,new URLSearchParams({userId:other}));await setWhatsAppRead(db,admin,{userId:other,companyId:company,phone,messageIds:[id(20)],read:true});assert.equal(calls,2);
  for(const value of [{messageIds:[]},{messageIds:[id(20),id(20)]},{read:'true'},{companyId:'bad'},{phone:'bad'}])await assert.rejects(setWhatsAppRead(db,admin,{companyId:company,phone,messageIds:[id(20)],read:true,...value}));
  await assert.rejects(getWhatsAppInbox(db,admin,new URLSearchParams({limit:'500'})));assert.equal(calls,2);
  await assert.rejects(getWhatsAppInbox({rpc:async()=>({error:'secret'})},admin,new URLSearchParams()),/No se pudo cargar/);
  const source=fs.readFileSync('supabase/functions/crm-agent/index.ts','utf8');const route=source.slice(source.indexOf('if ((["meta-whatsapp-conversation"'),source.indexOf('if (route === "meta-whatsapp-reply" && req.method === "POST")'));
  assert.match(route,/requireCrmAdmin/);assert.match(route,/admin.userId!, await readJsonObject/);
});
test('orphan history is strictly scoped and cannot send',async()=>{
  const conditions=[];const q={select:()=>q,is:(k,v)=>{conditions.push([k,v]);return q},in:(k,v)=>{conditions.push([k,v]);return q},order:()=>q,range:async()=>({data:[{id:id(23),direction:'inbound',body:'Consulta',message_type:'text',status:'received',occurred_at:new Date().toISOString()}]})};
  const result=await getWhatsAppConversation({from:()=>q},()=>{throw Error('no config needed')},'','912345679');
  assert.equal(result.canReply,false);assert.equal(result.canTemplate,false);assert.equal(result.messages.length,1);assert.deepEqual(conditions[0],['company_id',null]);assert.ok(conditions[1][1].includes('56912345679'));
});
