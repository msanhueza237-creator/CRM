import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import ts from 'typescript';
import {whatsappMessageBody,storedWhatsAppBody,replyWindow,splitWhatsAppEvents} from '../supabase/functions/_shared/whatsapp-content.ts';
import {getWhatsAppConversation,sendWhatsAppReply} from '../supabase/functions/crm-agent/whatsapp-conversation.ts';
import {getWhatsAppConfig} from '../supabase/functions/crm-agent/whatsapp-dispatch.ts';
import {validWhatsAppWebhookAccount} from '../supabase/functions/crm-agent/whatsapp-policy.ts';
const companyId='00000000-0000-4000-8000-000000000001', phone='56912345678';
const envelope=(message,extra={})=>({object:'whatsapp_business_account',entry:[{id:'b1',changes:[{field:'messages',value:{metadata:{phone_number_id:'p1'},messages:[message],...extra}}]}]});
const inbound=(extra={})=>({id:'in1',company_id:companyId,direction:'inbound',phone_number:'+'+phone,meta_message_id:'wamid.in1',message_type:'text',status:'received',occurred_at:new Date().toISOString(),body:'Hola',raw_payload:envelope({id:'wamid.in1',from:phone,type:'text',text:{body:'Hola'},timestamp:String(Math.floor(Date.now()/1000)-60)}),...extra});
const defaults={META_GRAPH_API_VERSION:'v26.0',META_WHATSAPP_ACCESS_TOKEN:'private-token',META_WHATSAPP_PHONE_NUMBER_ID:'p1',META_WHATSAPP_BUSINESS_ACCOUNT_ID:'b1',META_WHATSAPP_PRODUCTION_APPROVED:'true',META_WHATSAPP_APP_SECRET:'private-secret',META_WHATSAPP_WEBHOOK_VERIFY_TOKEN:'verify'};
const env=(keys)=>keys.map(k=>defaults[k]).find(Boolean)||'';
const request=()=>({companyId,phone,text:'Gracias por tu consulta',requestId:crypto.randomUUID(),confirmSend:true});
function dbFixture(extra={}) {
 const tables={companies:[{id:companyId,name:'Cliente prueba',whatsapp_status:'sin_consentimiento'}],whatsapp_settings:[{active:true,phone_number_id:'p1',business_account_id:'b1'}],whatsapp_messages:[inbound()],...extra};
 return {tables,from(name){let filters=[],order=[],start=0,end=Infinity,op='select',value;const q={
  select(){return q},eq(k,v){filters.push(r=>r[k]===v);return q},in(k,v){filters.push(r=>v.includes(r[k]));return q},
  order(k,o){order.push([k,o.ascending]);return q},limit(n){end=n;return q},range(a,b){start=a;end=b+1;return q},
  insert(v){op='insert';value=v;return q},update(v){op='update';value=v;return q},maybeSingle(){return q.then(r=>({...r,data:r.data?.[0]||null}))},
  then(resolve,reject){return Promise.resolve().then(()=>{
   if(op==='insert'){if(tables[name].some(r=>r.id===value.id))return {error:{code:'23505'},data:null};tables[name].push({...value,occurred_at:new Date().toISOString()});return {error:null,data:null}}
   let rows=tables[name].filter(r=>filters.every(f=>f(r)));if(op==='update')rows.forEach(r=>Object.assign(r,value));
   rows.sort((a,b)=>{for(const [k,asc] of order){const n=String(a[k]).localeCompare(String(b[k]));if(n)return asc?n:-n}return 0});
   return {data:rows.slice(start,end).map(r=>({...r})),error:null};
  }).then(resolve,reject)}
 };return q}};
}
test('catalog order preserves quantities, unit prices, currency and customer text',()=>{
 const body=whatsappMessageBody({type:'order',order:{text:'Necesito cotizacion',product_items:[{product_retailer_id:'SKU1',quantity:2,item_price:34500,currency:'CLP'}]}});
 assert.match(body,/Necesito cotizacion/);assert.match(body,/2 unidad\(es\) x 34.500 CLP = 69.000 CLP/);assert.match(body,/no confirma venta ni pago/);
 const r=inbound({body:'[mensaje order recibido]',raw_payload:envelope({id:'wamid.in1',type:'order',order:{product_items:[]}})});
 assert.match(storedWhatsAppBody(r),/Pedido del catalogo/);
});
test('reads every message and status in batched webhooks',()=>{
 const raw=envelope({id:'one'}, {messages:[{id:'one'},{id:'two'}],statuses:[{id:'sent'}]});
 raw.entry.push({changes:[{value:{messages:[{id:'three'}]}}]});
 const events=splitWhatsAppEvents(raw);assert.equal(events.length,4);assert.equal(events[1].entry[0].changes[0].value.messages[0].id,'two');
});
test('reply window uses Meta event time, matching account and sender, never local receipt time',()=>{
 const now=Date.now(),r=inbound();assert.equal(replyWindow(r,'p1',now).open,true);
 assert.equal(replyWindow(r,'other',now).open,false);
 for(const timestamp of [undefined,'bad',String(Math.floor(now/1000)+60),String(Math.floor(now/1000)-86400)]){
  const changed=structuredClone(r);changed.raw_payload.entry[0].changes[0].value.messages[0].timestamp=timestamp;
  assert.equal(replyWindow(changed,'p1',now).open,false);
 }
 const changed=structuredClone(r);changed.phone_number='56999999999';assert.equal(replyWindow(changed,'p1').open,false);
});
test('history is chronological, scoped by company AND phone and omits raw payloads',async()=>{
 const db=dbFixture();db.tables.whatsapp_messages.push(inbound({id:'other-phone',phone_number:'56922222222'}),inbound({id:'other-company',company_id:'foreign'}));
 const data=await getWhatsAppConversation(db,env,companyId,phone);assert.equal(data.messages.length,1);assert.equal(data.canReply,true);
 assert.equal('raw_payload' in data.messages[0],false);assert.equal(JSON.stringify(data).includes('private-token'),false);
 assert.equal(db.tables.companies[0].whatsapp_status,'sin_consentimiento');
 await assert.rejects(getWhatsAppConversation(db,env,companyId,'56999999999'),/No hay mensajes/);
 await assert.rejects(getWhatsAppConversation(db,env,companyId,phone,-1));
});
test('history exposes older pages without truncation presented as complete',async()=>{
 const db=dbFixture({whatsapp_messages:Array.from({length:55},(_,i)=>inbound({id:`in${i}`,occurred_at:new Date(Date.now()-i*1000).toISOString()}))});
 const first=await getWhatsAppConversation(db,env,companyId,phone);assert.equal(first.messages.length,50);assert.equal(first.nextOffset,50);
 const next=await getWhatsAppConversation(db,env,companyId,phone,50);assert.equal(next.messages.length,5);assert.equal(next.nextOffset,null);
});
test('manual reply sends exact text only after confirmation and keeps marketing opt-in unchanged',async()=>{
 const db=dbFixture(),p=request(),calls=[];
 const out=await sendWhatsAppReply(db,env,p,'u1',async(url,options)=>{calls.push(JSON.parse(options.body));return Response.json({messages:[{id:'wamid.out'}]})});
 assert.equal(out.accepted,true);assert.equal(calls[0].to,phone);assert.equal(calls[0].text.body,p.text);assert.equal(calls[0].type,'text');
 assert.equal(db.tables.whatsapp_messages.at(-1).status,'sent');assert.equal(db.tables.companies[0].whatsapp_status,'sin_consentimiento');
 await assert.rejects(sendWhatsAppReply(db,env,p,'u1',()=>{throw Error('must not send')}),/intento registrado/);
});
for(const [name,change,rows] of [
 ['confirmation',{confirmSend:false}],['empty',{text:' '}],['long',{text:'x'.repeat(4097)}],['invalid id',{requestId:'bad'}],['wrong number',{phone:'56999999999'}],
 ['optout',{}, {companies:[{id:companyId,name:'test',whatsapp_status:'opt_out'}]}],
 ['window expired',{}, {whatsapp_messages:[inbound({raw_payload:envelope({id:'wamid.in1',from:phone,timestamp:'1'})})]}],
 ['stop request',{}, {whatsapp_messages:[inbound({raw_payload:envelope({id:'wamid.in1',from:phone,timestamp:String(Math.floor(Date.now()/1000)-20),type:'text',text:{body:'SALIR'}})})]}],
])test(`rejects ${name} before reserving or contacting Meta`,async()=>{
 const db=dbFixture(rows),count=db.tables.whatsapp_messages.length;let calls=0;
 await assert.rejects(sendWhatsAppReply(db,env,{...request(),...change},'u1',async()=>{calls++;return Response.json({})}));
 assert.equal(calls,0);assert.equal(db.tables.whatsapp_messages.length,count);
});
test('concurrent identical requests contact Meta once',async()=>{
 const db=dbFixture(),p=request();let calls=0;
 await Promise.allSettled([1,2].map(()=>sendWhatsAppReply(db,env,p,'u1',async()=>{calls++;return Response.json({messages:[{id:'wamid.once'}]})})));
 assert.equal(calls,1);
});
test('uncertain send persists reservation and blocks retries with any key',async()=>{
 const db=dbFixture();const out=await sendWhatsAppReply(db,env,request(),'u1',async()=>{throw Error('timeout')});
 assert.equal(out.accepted,false);assert.match(out.warning,/incierto/);assert.equal(db.tables.whatsapp_messages.at(-1).status,'pending');
 await assert.rejects(sendWhatsAppReply(db,env,request(),'u1',()=>{throw Error('must not send')}),/incierto/);
 assert.equal((await getWhatsAppConversation(db,env,companyId,phone)).canReply,false);
});
test('Meta rejection is not represented as accepted',async()=>{
 const db=dbFixture();const out=await sendWhatsAppReply(db,env,request(),'u1',async()=>Response.json({error:{code:131047}},{status:400}));
 assert.equal(out.accepted,false);assert.match(out.warning,/ventana.*cerrada/);assert.doesNotMatch(out.warning,/131047/);assert.equal(db.tables.whatsapp_messages.at(-1).status,'failed');
});
test('conversation routes require active administrator; unsigned webhooks cannot fallback to public IDs',()=>{
 const source=fs.readFileSync(new URL('../supabase/functions/crm-agent/index.ts',import.meta.url),'utf8');
 const ast=ts.createSourceFile('index.ts',source,ts.ScriptTarget.Latest,true);
 const validation=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='validateMetaWebhookRequest').getText(ast);
 assert.doesNotMatch(validation,/fallbackValidation/);
 assert.match(source,/requireCrmAdmin\(req, supabase, true\)/);
});

test('webhook validates signature and configured account before accepting a batch',async()=>{
 const source=fs.readFileSync(new URL('../supabase/functions/crm-agent/index.ts',import.meta.url),'utf8');
 const ast=ts.createSourceFile('index.ts',source,ts.ScriptTarget.Latest,true);
 const names=['validateMetaWebhookRequest','validateMetaWebhookAccount','createMetaSignature'];
 const sourceFunctions=ast.statements.filter(n=>ts.isFunctionDeclaration(n)&&names.includes(n.name?.text)).map(n=>n.getText(ast)).join('\n');
 const compiled=ts.transpileModule(sourceFunctions,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 const api=new Function('Deno','stripOptionalQuotes','getWhatsAppConfig','firstEnvValue','validWhatsAppWebhookAccount',`${compiled};return {validateMetaWebhookRequest,createMetaSignature};`)({env:{get:k=>defaults[k]}},v=>String(v||'').trim(),getWhatsAppConfig,env,validWhatsAppWebhookAccount);
 const body=JSON.stringify(envelope({id:'in1',type:'text',text:{body:'hello'}}));
 const signature=await api.createMetaSignature(body,defaults.META_WHATSAPP_APP_SECRET);
 for(const supplied of ['', 'sha256=bad']){
  const req=new Request('https://test/webhook',{method:'POST',headers:{'x-hub-signature-256':supplied},body});
  assert.equal((await api.validateMetaWebhookRequest(req,new URL(req.url),dbFixture())).valid,false);
 }
 const req=new Request('https://test/webhook',{method:'POST',headers:{'x-hub-signature-256':signature},body});
 assert.equal((await api.validateMetaWebhookRequest(req.clone(),new URL(req.url),dbFixture())).valid,true);
 assert.equal((await api.validateMetaWebhookRequest(req.clone(),new URL(req.url),dbFixture({whatsapp_settings:[{active:true,phone_number_id:'p1',business_account_id:'other'}]}))).valid,false);
 const mixed=JSON.parse(body);mixed.entry.push({id:'b1',changes:[{value:{metadata:{phone_number_id:'other'},messages:[{id:'other'}]}}]});
 const mixedBody=JSON.stringify(mixed);const mixedSig=await api.createMetaSignature(mixedBody,defaults.META_WHATSAPP_APP_SECRET);
 const mixedReq=new Request(req.url,{method:'POST',headers:{'x-hub-signature-256':mixedSig},body:mixedBody});
 assert.equal((await api.validateMetaWebhookRequest(mixedReq,new URL(req.url),dbFixture())).valid,false);
});
