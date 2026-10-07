import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import {readMessageForm, validateMessageFile, resolveMessageRecipient} from '../supabase/functions/_shared/direct-message.ts';
import {sendDirectEmail, directEmailMime} from '../supabase/functions/gmail-integration/direct-email.ts';
import {getWhatsAppConversation, sendWhatsAppReply} from '../supabase/functions/crm-agent/whatsapp-conversation.ts';
import {getMessageRecipients} from '../supabase/functions/crm-agent/message-recipients.ts';

const companyId='00000000-0000-4000-8000-000000000001', contactId='00000000-0000-4000-8000-000000000002', phone='56912345678';
const pdf={name:'cotizacion.pdf',type:'application/pdf',bytes:new TextEncoder().encode('%PDF-1.7 test')};
const env=keys=>keys.map(k=>({META_WHATSAPP_ACCESS_TOKEN:'synthetic-token',META_WHATSAPP_PHONE_NUMBER_ID:'p1',META_WHATSAPP_BUSINESS_ACCOUNT_ID:'b1',META_WHATSAPP_PRODUCTION_APPROVED:'true',META_WHATSAPP_APP_SECRET:'synthetic',META_WHATSAPP_WEBHOOK_VERIFY_TOKEN:'synthetic'})[k]).find(Boolean)||'';
const inbound=()=>({id:'in1',meta_message_id:'in1',company_id:companyId,phone_number:phone,direction:'inbound',status:'received',occurred_at:new Date().toISOString(),raw_payload:{entry:[{changes:[{value:{metadata:{phone_number_id:'p1'},messages:[{id:'in1',from:phone,type:'text',text:{body:'Cotizacion por favor'},timestamp:String(Math.floor(Date.now()/1000)-30)}]}}]}]}});
function fixture(extra={}) {
 const tables={companies:[{id:companyId,name:'Cliente prueba',email:'cliente@example.com',phone,whatsapp_opt_in:true,whatsapp_status:'opt_in'}],contacts:[{id:contactId,company_id:companyId,full_name:'Contacto prueba',email:'contacto@example.com',phone:'56922222222'}],email_messages:[],interactions:[],whatsapp_settings:[{active:true,phone_number_id:'p1',business_account_id:'b1'}],whatsapp_messages:[inbound()],...extra};
 const db={tables,from(name){let filters=[],start=0,end=Infinity,op='select',value;const q={
  select(){return q},eq(k,v){filters.push(r=>r[k]===v);return q},in(k,v){filters.push(r=>v.includes(r[k]));return q},gte(k,v){filters.push(r=>r[k]>=v);return q},
  order(){return q},limit(n){end=n;return q},range(a,b){start=a;end=b+1;return q},insert(v){op='insert';value=v;return q},update(v){op='update';value=v;return q},
  maybeSingle(){return q.then(r=>({...r,data:r.data?.[0]||null}))},then(resolve,reject){return Promise.resolve().then(()=>{
   if(op==='insert'){if(value.id&&tables[name].some(r=>r.id===value.id))return{error:{code:'23505'}};tables[name].push({...value,created_at:new Date().toISOString()});return{error:null}}
   const rows=tables[name].filter(r=>filters.every(f=>f(r)));if(op==='update')rows.forEach(r=>Object.assign(r,value));return{data:rows.slice(start,end).map(r=>({...r})),count:rows.length,error:null};
  }).then(resolve,reject)}
 };return q}};return db;
}
const payload=(extra={})=>({companyId,phone,email:'cliente@example.com',subject:'Cotizacion solicitada',text:'Te adjunto el documento.',requestId:crypto.randomUUID(),confirmSend:true,...extra});
const prepare=async()=>({sender:'crm@example.com',accessToken:'synthetic',dailyLimit:20,recordSent:async()=>{}});
function formRequest(files=[pdf],extra={}){const form=new FormData();form.set('message',JSON.stringify(payload(extra)));for(const f of files)form.append('files',new Blob([f.bytes],{type:f.type}),f.name);return new Request('https://fixture.invalid/send',{method:'POST',body:form});}

test('multipart validates content, metadata, counts and explicit confirmation',async()=>{
 const result=await readMessageForm(formRequest(),'email');assert.equal(result.files[0].name,pdf.name);assert.deepEqual(result.files[0].bytes,pdf.bytes);
 await assert.rejects(readMessageForm(formRequest([pdf,pdf]),'whatsapp'),/un adjunto/);
 await assert.rejects(readMessageForm(formRequest(Array(6).fill(pdf)),'email'),/cinco/);
 await assert.rejects(readMessageForm(formRequest([{...pdf,bytes:new TextEncoder().encode('<html>')}]),'email'),/formato/);
 await assert.rejects(readMessageForm(formRequest([],{confirmSend:false}),'email'),/Confirma/);
 for(const change of [{name:'bad\r\n.pdf'},{name:'secret.exe'},{type:'text/html'},{size:11*1024*1024}])assert.throws(()=>validateMessageFile({name:pdf.name,type:pdf.type,size:12,...change}));
 assert.throws(()=>validateMessageFile({name:'foto.jpg',type:'image/jpeg',size:6*1024*1024}));
 const huge=new Request('https://fixture.invalid/send',{method:'POST',headers:{'content-type':'multipart/form-data','content-length':String(12*1024*1024)},body:'x'});await assert.rejects(readMessageForm(huge,'email'),/10 MB/);
});
test('directory includes all companies and individual contacts, contact identity is scoped',async()=>{
 const db=fixture();const data=await getMessageRecipients(db);assert.equal(data.recipients.length,2);assert.equal(data.recipients[1].email,'contacto@example.com');
 assert.equal((await resolveMessageRecipient(db,companyId,contactId)).recipient.phone,'56922222222');
 db.tables.contacts[0].company_id='foreign';await assert.rejects(resolveMessageRecipient(db,companyId,contactId),/no pertenece/);
});
test('MIME includes base64 text and true attachment bytes, rejects header injection',()=>{
 const mime=Buffer.from(directEmailMime('crm@example.com','cliente@example.com','Cotizacion','Gracias',[pdf]),'base64url').toString();
 assert.match(mime,/multipart\/mixed/);assert.match(mime,/filename\*=UTF-8''cotizacion.pdf/);assert.ok(mime.includes(Buffer.from(pdf.bytes).toString('base64')));
 assert.throws(()=>directEmailMime('crm@example.com','bad\r\n@example.com','a','b',[]));
 assert.throws(()=>directEmailMime('crm@example.com','a@example.com','a\r\nBcc: injected','b',[]));
});
test('email sends once, records actual recipient and rejects duplicate key',async()=>{
 const db=fixture(),p=payload({contactId,email:'contacto@example.com'});let calls=0;
 const request=async(url,o)=>{calls++;assert.equal(url,'https://gmail.googleapis.com/gmail/v1/users/me/messages/send');assert.match(Buffer.from(JSON.parse(o.body).raw,'base64url').toString(),/To: contacto@example.com/);return Response.json({id:'gmail1'})};
 assert.equal((await sendDirectEmail(db,p,[pdf],'admin',prepare,request)).accepted,true);assert.equal(db.tables.email_messages[0].status,'sent');assert.equal(db.tables.interactions[0].contact_id,contactId);
 await assert.rejects(sendDirectEmail(db,p,[pdf],'admin',prepare,request),/intento ya existe/);assert.equal(calls,1);
});
for(const failure of ['timeout',500,408])test(`email ${failure} remains reserved without retry`,async()=>{
 const db=fixture();let calls=0;const send=async()=>{calls++;if(failure==='timeout')throw Error('timeout');return Response.json({}, {status:failure})};
 const result=await sendDirectEmail(db,payload(),[],'admin',prepare,send);assert.equal(result.outcome,'uncertain');assert.equal(db.tables.email_messages[0].status,'pending');
 await assert.rejects(sendDirectEmail(db,payload(),[],'admin',prepare,send),/pendiente/);assert.equal(calls,1);
});
test('email known rejection is failed; limit or changed destination prevents send',async()=>{
 const db=fixture();assert.equal((await sendDirectEmail(db,payload(),[],'admin',prepare,async()=>Response.json({}, {status:400}))).outcome,'rejected');assert.equal(db.tables.email_messages[0].status,'failed');
 let calls=0;const never=async()=>{calls++;throw Error('must not send')};
 await assert.rejects(sendDirectEmail(fixture(),payload({email:'other@example.com'}),[],'admin',prepare,never),/no coincide/);
 assert.equal((await sendDirectEmail(fixture(),payload(),[],'admin',async()=>({...await prepare(),dailyLimit:0}),never)).outcome,'rejected');
 const changed=fixture();assert.equal((await sendDirectEmail(changed,payload(),[],'admin',async()=>{changed.tables.companies[0].email='changed@example.com';return prepare()},never)).outcome,'rejected');assert.equal(calls,0);
});
test('concurrent email requests with same key send only once',async()=>{
 const db=fixture(),p=payload();let calls=0;await Promise.allSettled([1,2].map(()=>sendDirectEmail(db,p,[],'admin',prepare,async()=>{calls++;return Response.json({id:'once'})})));assert.equal(calls,1);
});
test('WhatsApp uploads attachment privately, sends media ID and stores hash only',async()=>{
 const db=fixture(),calls=[];const result=await sendWhatsAppReply(db,env,payload(),'admin',async(url,o)=>{calls.push(url);if(url.endsWith('/media')){assert.ok(o.body instanceof FormData);return Response.json({id:'media1'})}const b=JSON.parse(o.body);assert.equal(b.type,'document');assert.equal(b.document.id,'media1');assert.equal(b.document.filename,pdf.name);return Response.json({messages:[{id:'wamid.out'}]})},[pdf]);
 assert.equal(result.accepted,true);assert.equal(calls.length,2);const stored=db.tables.whatsapp_messages.at(-1);assert.match(stored.raw_payload.attachments[0].sha256,/^[a-f0-9]{64}$/);assert.equal('bytes' in stored.raw_payload.attachments[0],false);
});
test('WhatsApp revalidates opt-out after media upload and never sends on upload failure',async()=>{
 for(const stop of [true,false]){const db=fixture();let calls=0;const result=await sendWhatsAppReply(db,env,payload(),'admin',async()=>{calls++;if(stop){db.tables.companies[0].whatsapp_status='opt_out';return Response.json({id:'media1'})}return Response.json({}, {status:500})},[pdf]);assert.equal(result.outcome,'rejected');assert.equal(calls,1);}
});
test('WhatsApp 5xx keeps uncertain reservation',async()=>{
 const db=fixture();assert.equal((await sendWhatsAppReply(db,env,payload(),'admin',async()=>Response.json({}, {status:503}))).outcome,'uncertain');assert.equal(db.tables.whatsapp_messages.at(-1).status,'pending');
});
test('new contact can use approved template only with consent for that exact number',async()=>{
 const db=fixture({whatsapp_messages:[]});const company=await getWhatsAppConversation(db,env,companyId,phone);assert.equal(company.canReply,false);assert.equal(company.canTemplate,true);
 const contact=await getWhatsAppConversation(db,env,companyId,'56922222222',0,contactId);assert.equal(contact.canReply,false);assert.equal(contact.canTemplate,false);
});
test('email authorization ignores editable user metadata and rejects inactive profiles',()=>{
 const source=fs.readFileSync(new URL('../supabase/functions/gmail-integration/index.ts',import.meta.url),'utf8');const guard=source.slice(source.indexOf('async function requireAdmin'),source.indexOf('async function encryptSecret'));
 assert.doesNotMatch(guard,/user_metadata/);assert.match(guard,/profile\?\.active !== true/);assert.ok(source.indexOf('const user = await requireAdmin')<source.indexOf('route === "send-direct"'));
});
