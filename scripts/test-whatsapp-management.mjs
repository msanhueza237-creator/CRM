import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {compileTemplateDraft,resolveTemplateValues,validateTemplatePolicy,templateEditBlocker} from '../supabase/functions/crm-agent/whatsapp-template-model.ts';
import {redactMeta,metaFunctionalError,validWhatsAppWebhookAccount,whatsappRoleAllowed} from '../supabase/functions/crm-agent/whatsapp-policy.ts';
import {templateManagement,processTemplateWebhook,syncWhatsAppTemplates} from '../supabase/functions/crm-agent/whatsapp-template-manager.ts';

const migration=fs.readFileSync('supabase/migrations/20261007012541_whatsapp_template_management.sql','utf8');
const policy=JSON.parse(migration.match(/management_policy jsonb not null default '(.*?)'::jsonb/s)[1]);
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const draft={internalName:'Pedido',name:'pedido_ejemplo',language:'es_CL',category:'UTILITY',header:'Pedido',body:'Hola {{1}}, tu pedido {{2}} está preparado.',footer:'Clima Activa',description:'Pedido solicitado',bindings:[{key:'1',field:'nombre_cliente',example:'Cliente de ejemplo'},{key:'2',field:'numero_pedido',example:'PED-100'}],buttons:[],purposeConfirmed:false};
const env=names=>names.map(name=>({META_WHATSAPP_ACCESS_TOKEN:'test-secret',META_WHATSAPP_PHONE_NUMBER_ID:'123',META_WHATSAPP_BUSINESS_ACCOUNT_ID:'456',META_GRAPH_API_VERSION:'v26.0',META_WHATSAPP_PRODUCTION_APPROVED:'true',META_WHATSAPP_APP_SECRET:'fixture-signature',META_WHATSAPP_WEBHOOK_VERIFY_TOKEN:'fixture-verification'}[name])).find(Boolean)||'';
const settings={id:id(40),phone_number_id:'123',business_account_id:'456',active:true,management_policy:policy};

// Minimal Supabase-shaped fixture. Network is always an injected local function.
function memory(initial=[]) {
  const tables={whatsapp_settings:[settings],whatsapp_templates:structuredClone(initial),whatsapp_webhook_events:[],activity_logs:[]};
  return {tables,from(table){let filters=[],mode='select',patch,range=null,limit=null; const query={
    select(){return query},order(){return query},eq(k,v){filters.push(r=>r[k]===v);return query},in(k,v){filters.push(r=>v.includes(r[k]));return query},not(k,_op,v){filters.push(r=>r[k]!==v);return query},range(a,b){range=[a,b];return query},limit(v){limit=v;return query},
    update(p){mode='update';patch=p;return query},insert(p){mode='insert';patch=p;return query},
    async single(){return run(true)},async maybeSingle(){return run(true)},then(resolve,reject){return Promise.resolve(run(false)).then(resolve,reject)}
  };function run(single){let rows=tables[table].filter(r=>filters.every(f=>f(r)));if(mode==='insert'){rows=[{id:id(100+tables[table].length),active:true,...structuredClone(patch)}];tables[table].push(...rows)}if(mode==='update')rows.forEach(r=>Object.assign(r,structuredClone(patch)));if(range)rows=rows.slice(range[0],range[1]+1);if(limit)rows=rows.slice(0,limit);return {data:single?rows[0]||null:rows,error:null}}return query}};
}
const remote={id:'789',name:'pedido_ejemplo',language:'es_CL',category:'UTILITY',status:'APPROVED',components:[{type:'BODY',text:'Hola {{1}}, tu pedido {{2}} está preparado.'}]};
const request=async(_url,options={})=>{assert.notEqual(options.method,'POST','No live/implicit template submission');return new Response(JSON.stringify({data:[remote]}),{status:200})};

test('versioned categories, draft limits, variable registry and official payload',()=>{
  assert.equal(validateTemplatePolicy(policy).graphVersion,'v26.0');
  const result=compileTemplateDraft(draft,policy);assert.equal(result.components[1].example.body_text[0][1],'PED-100');
  assert.throws(()=>compileTemplateDraft(draft,policy,true),/Confirma/);
  assert.doesNotThrow(()=>compileTemplateDraft({...draft,purposeConfirmed:true},policy,true));
  for(const change of [{category:'FREE_SERVICE'},{body:'Hola {{2}}, detalle.'},{body:'{{1}}'},{bindings:[{key:'1',field:'sql:select',example:'x'}]},{buttons:[{type:'URL',text:'Ver',value:'https://user:secret@example.cl'}]}])assert.throws(()=>compileTemplateDraft({...draft,...change},policy));
  assert.deepEqual(resolveTemplateValues(draft.bindings,{nombre_cliente:'Ana'},{'1':'Otro','2':'PED-100'}),['Ana','PED-100']);
  assert.throws(()=>resolveTemplateValues(draft.bindings,{nombre_cliente:'Ana'},{'2':''}));
});
test('active roles only, signed template events do not require a phone ID, redacted errors',()=>{
  assert.equal(whatsappRoleAllowed('vendedor',true,false),true);assert.equal(whatsappRoleAllowed('vendedor',true,true),false);assert.equal(whatsappRoleAllowed('administrador',false,true),false);
  const event={object:'whatsapp_business_account',entry:[{id:'456',changes:[{field:'message_template_status_update',value:{message_template_id:789,event:'APPROVED'}}]}]};
  assert.equal(validWhatsAppWebhookAccount(event,'456','123'),true);assert.equal(validWhatsAppWebhookAccount(event,'wrong','123'),false);
  assert.match(metaFunctionalError({error:{code:190,message:'secret'}}),/token.*revisión/i);
  const redacted=JSON.stringify(redactMeta({access_token:'secret',nested:{message:'Bearer private-token',app_secret:'other'},detail:'test-secret'},['test-secret']));
  for(const secret of ['test-secret','private-token','"secret"','"other"'])assert.equal(redacted.includes(secret),false);
});
test('drafts are saved without any Meta request; seller cannot manage; explicit confirmation required',async()=>{
  const db=memory();let calls=0;const never=async()=>{calls++;throw Error('Unexpected network')};
  await templateManagement(db,env,id(1),true,'save',{draft},never);assert.equal(calls,0);
  const row=db.tables.whatsapp_templates[0];assert.equal(row.local_state,'DRAFT');assert.equal(row.meta_template_id,undefined);
  await assert.rejects(templateManagement(db,env,id(2),false,'save',{draft},never),/administradores/);
  await assert.rejects(templateManagement(db,env,id(1),true,'submit',{id:row.id,revision:row.revision},never),/confirma/);
  assert.equal(calls,0);
});
test('Meta sync imports without duplicates, preserves unsent draft and hides it from sellers',async()=>{
  const db=memory();await syncWhatsAppTemplates(db,env,id(1),request);await syncWhatsAppTemplates(db,env,id(1),request);
  assert.equal(db.tables.whatsapp_templates.length,1);const row=db.tables.whatsapp_templates[0];row.draft=draft;row.local_state='DRAFT';
  await syncWhatsAppTemplates(db,env,id(1),request);assert.deepEqual(row.draft,draft);
  const seller=await templateManagement(db,env,id(2),false,'list');assert.equal(seller.templates[0].draft,null);assert.equal(row.draft,draft);
  await syncWhatsAppTemplates(db,env,id(1),async()=>new Response(JSON.stringify({data:[]})));
  assert.equal(row.status,'UNAVAILABLE');assert.equal((await templateManagement(db,env,id(2),false,'list')).templates.length,0);
});
test('template status webhook is idempotent and fetches authoritative state',async()=>{
  const db=memory();let calls=0;const get=async(...args)=>{calls++;return request(...args)};
  const payload={entry:[{id:'456',time:100,changes:[{field:'message_template_status_update',value:{event:'APPROVED',message_template_id:789}}]}]};
  await processTemplateWebhook(db,env,payload,get);await processTemplateWebhook(db,env,payload,get);
  assert.equal(calls,1);assert.equal(db.tables.whatsapp_webhook_events.length,1);assert.equal(db.tables.whatsapp_templates[0].status,'APPROVED');
});
test('invalid token is controlled and never exposes provider details',async()=>{
  await assert.rejects(syncWhatsAppTemplates(memory(),env,id(1),async()=>new Response(JSON.stringify({error:{code:190,message:'test-secret'}}),{status:401})),e=>/token.*revisión/i.test(e.message)&&!e.message.includes('test-secret')&&!JSON.stringify(e).includes('test-secret'));
});

test('imported media, named variables, catalog and unknown components cannot be silently lost',async()=>{
 const supported={...remote,parameter_format:'POSITIONAL'};
 assert.equal(templateEditBlocker(supported),null);
 for(const change of [
  {parameter_format:'NAMED'}, {category:'AUTHENTICATION'},
  {components:[...remote.components,{type:'HEADER',format:'IMAGE',example:{header_handle:['sample']}}]},
  {components:[...remote.components,{type:'HEADER',format:'TEXT',text:'Hola {{1}}'}]},
  {components:[...remote.components,{type:'BUTTONS',buttons:[{type:'CATALOG',text:'Ver catálogo'}]}]},
  {components:[...remote.components,{type:'BUTTONS',buttons:[{type:'URL',text:'Ver',url:'https://example.cl/{{1}}'}]}]},
  {components:[...remote.components,{type:'CAROUSEL',cards:[]}]},
 ]) {
  const imported={...supported,...change};assert.match(templateEditBlocker(imported),/conservar/);
  const db=memory();await syncWhatsAppTemplates(db,env,id(1),async()=>Response.json({data:[imported]}));
  const saved=db.tables.whatsapp_templates[0],before=structuredClone(saved);
  await assert.rejects(templateManagement(db,env,id(1),true,'save',{id:saved.id,revision:saved.revision,draft}),/conservar/);
  assert.deepEqual(saved,before);
  const listed=await templateManagement(db,env,id(1),true,'list');assert.match(listed.templates[0].editBlockedReason,/conservar/);
 }
});

test('changed remote components block approval before any Meta POST; text edit uses supported fields',async()=>{
 const db=memory();await syncWhatsAppTemplates(db,env,id(1),request);const saved=db.tables.whatsapp_templates[0];
 await templateManagement(db,env,id(1),true,'save',{id:saved.id,revision:saved.revision,draft:{...draft,purposeConfirmed:true}});
 let writes=0;
 const changed=async(_url,options={})=>{if(options.method==='POST'){writes++;throw Error('Unexpected POST')}return Response.json({data:[{...remote,components:[...remote.components,{type:'HEADER',format:'IMAGE'}]}]})};
 await assert.rejects(templateManagement(db,env,id(1),true,'submit',{id:saved.id,revision:saved.revision,confirmSubmit:true},changed),/conservar/);
 assert.equal(writes,0);assert.equal(saved.local_state,'DRAFT');
 const supported=async(url,options={})=>{if(options.method!=='POST')return request(url,options);writes++;assert.equal(url,'https://graph.facebook.com/v26.0/789');assert.deepEqual(Object.keys(JSON.parse(options.body)).sort(),['category','components']);return Response.json({success:true})};
 await templateManagement(db,env,id(1),true,'submit',{id:saved.id,revision:saved.revision,confirmSubmit:true},supported);
 assert.equal(writes,1);assert.equal(saved.status,'PENDING');
});
test('explicit mocked approval uses WABA endpoint; timeout stays uncertain and cannot resubmit',async()=>{
  for(const uncertain of [false,true]) {
    const db=memory();await templateManagement(db,env,id(1),true,'save',{draft:{...draft,purposeConfirmed:true}});
    const row=db.tables.whatsapp_templates[0];let writes=0;
    const meta=async(url,options={})=>{
      if(options.method!=='POST')return new Response(JSON.stringify({data:[]}));
      writes++;assert.equal(url,'https://graph.facebook.com/v26.0/456/message_templates');
      assert.equal(JSON.parse(options.body).category,'UTILITY');assert.equal(JSON.parse(options.body).components[1].example.body_text[0][0],'Cliente de ejemplo');
      if(uncertain)throw Error('timeout');
      return new Response(JSON.stringify({id:'789',status:'PENDING',category:'UTILITY'}));
    };
    const submit=()=>templateManagement(db,env,id(1),true,'submit',{id:row.id,revision:row.revision,confirmSubmit:true},meta);
    if(uncertain){await assert.rejects(submit(),/incierto/);assert.equal(row.local_state,'UNCERTAIN');await assert.rejects(submit(),/confirma/)}
    else{await submit();assert.equal(row.status,'PENDING');assert.equal(row.draft,null);assert.equal(row.meta_template_id,'789')}
    assert.equal(writes,1);
  }
});

test('exact migration: eight drafts, seller RPCs, consent audit, persistent opt-out, monotonic delivery and private metadata',async()=>{
  const db=new PGlite();try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create table profiles(id uuid primary key,role text,active boolean);
      create table companies(id uuid primary key,name text,contact_name text,source text,status text,whatsapp text,phone text);
      create table contacts(id uuid primary key,company_id uuid,full_name text,whatsapp text,phone text);
      create table campaigns(id uuid primary key);
      create table activity_logs(id uuid default gen_random_uuid(),actor_id uuid,entity_type text,entity_id uuid,action text,metadata jsonb);
      create function public.current_role() returns text language sql as $$select 'administrador'::text$$;
      create function public.set_updated_at() returns trigger language plpgsql as $$begin new.updated_at=now();return new;end$$;`);
    await db.exec(fs.readFileSync('supabase/whatsapp_meta_integration.sql','utf8'));
    await db.exec(`grant all on all tables in schema public to authenticated,service_role;
      insert into profiles values('${id(1)}','administrador',true),('${id(2)}','vendedor',true),('${id(3)}','vendedor',false);
      insert into companies(id,name,phone) values('${id(10)}','Cliente','56912345678');
      insert into contacts values('${id(11)}','${id(10)}','Contacto',null,'56911111111');
      insert into whatsapp_settings(phone_number_id,business_account_id,active) values('123','456',true);`);
    await db.exec(fs.readFileSync('supabase/migrations/20261007005501_whatsapp_inbox_reads.sql','utf8'));
    await db.exec(migration);
    const seeds=(await db.query('select draft,status,local_state,meta_template_id from whatsapp_templates')).rows;assert.equal(seeds.length,8);
    for(const row of seeds){assert.equal(row.status,'DRAFT');assert.equal(row.local_state,'DRAFT');assert.equal(row.meta_template_id,null);assert.doesNotThrow(()=>compileTemplateDraft(row.draft,policy))}
    assert.equal((await db.query('select count(*)::int n from whatsapp_messages')).rows[0].n,0);
    await db.query('select crm_whatsapp_inbox($1)',[id(2)]);await assert.rejects(db.query('select crm_whatsapp_inbox($1)',[id(3)]));
    const consent=(source='WEB',phone='56912345678',contact=null)=>db.query('select crm_whatsapp_consent($1,$2,$3,$4,true,$5,$6)',[id(2),id(10),contact,phone,source,'Autorización explícita de prueba']);
    await assert.rejects(consent(null));await assert.rejects(consent('WEB','56999999999'));await consent();await consent('CLIENTE','56911111111',id(11));
    assert.equal((await db.query("select count(*)::int n from activity_logs where action='consent_recorded'")).rows[0].n,2);
    await db.query("insert into whatsapp_messages(company_id,phone_number,direction,body,meta_message_id) values($1,'56912345678','inbound','SALIR','in-1')",[id(10)]);
    await db.query("insert into whatsapp_messages(company_id,phone_number,direction,body,meta_message_id) values($1,'56912345678','inbound','Hola','in-2')",[id(10)]);
    assert.equal((await db.query('select whatsapp_opt_in from companies')).rows[0].whatsapp_opt_in,false);
    assert.equal((await db.query('select whatsapp_status from companies')).rows[0].whatsapp_status,'opt_out');
    assert.equal((await db.query("select count(*)::int n from activity_logs where action='customer_opt_out'")).rows[0].n,1);
    assert.equal((await db.query('select whatsapp_opt_in from contacts')).rows[0].whatsapp_opt_in,true);
    await db.query("insert into whatsapp_messages(company_id,phone_number,direction,body,meta_message_id) values($1,'+56911111111','inbound',' salir ','in-contact-stop')",[id(10)]);
    const withdrawn=(await db.query('select whatsapp_status,whatsapp_opt_in,whatsapp_opt_in_source from contacts')).rows[0];
    assert.deepEqual(withdrawn,{whatsapp_status:'opt_out',whatsapp_opt_in:false,whatsapp_opt_in_source:'CLIENTE'});
    await db.query("insert into whatsapp_messages(company_id,phone_number,direction,body,meta_message_id,status,raw_payload) values($1,'56912345678','outbound','Ejemplo','out-1','sent','{\"request_id\":\"preserved\"}')",[id(10)]);
    for(const status of ['read','delivered','sent','failed'])await db.query('select crm_whatsapp_message_status($1,$2)', ['out-1',{entry:[{changes:[{value:{statuses:[{id:'out-1',status,timestamp:'1791340000',pricing:{category:'utility'}}]}}]}]}]);
    const saved=(await db.query("select status,raw_payload from whatsapp_messages where meta_message_id='out-1'")).rows[0];assert.equal(saved.status,'read');assert.equal(saved.raw_payload.request_id,'preserved');
    await db.exec('set role authenticated');await assert.rejects(db.query('select * from whatsapp_templates'));await assert.rejects(db.query('select provider_error from whatsapp_messages'));await db.query('select body from whatsapp_messages');await assert.rejects(consent());
  } finally {await db.close()}
});
