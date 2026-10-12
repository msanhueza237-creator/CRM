import {test} from 'node:test';
import assert from 'node:assert/strict';
import {audioScenario} from './whatsapp-audio-fixture.mjs';
import {run} from './whatsapp-automation-fixture.mjs';
const openai='https://api.openai.com/v1/audio/transcriptions',deepseek='https://api.deepseek.com/responses';

for(const stage of ['OpenAI','DeepSeek'])for(const [status,providerCode,expected] of [[401,'private','configuration'],[403,'private','configuration'],[429,'insufficient_quota','quota'],[402,'credit_balance_exhausted','quota'],[429,'rate_limit_exceeded','rate_limit'],[500,'private','unavailable']])test(`${stage} ${status}/${providerCode}: explicit safe error and no fallback`,async()=>{
 const f=audioScenario(),seen=[],before=structuredClone(f.s.db.tables);
 const result=await run(f.s,async(url,options)=>{seen.push(url);if(url===(stage==='OpenAI'?openai:deepseek))return Response.json({error:{code:providerCode,message:'private-provider-body synthetic-only'}},{status});return f.fetcher(url,options);},f.env);
 assert.equal(result.processingError.code,expected);assert.equal(result.processingError.provider,stage);assert.equal(result.plan.text,null);assert.equal(result.plan.canSend,false);
 assert.doesNotMatch(JSON.stringify(result),/private-provider-body|synthetic-only/);assert.equal(f.s.calls.length,0);assert.deepEqual(f.s.db.tables,before);
 assert.equal(seen.filter(url=>url===openai).length,1);assert.equal(seen.filter(url=>url===deepseek).length,stage==='OpenAI'?0:1);
 assert.ok(seen.every(url=>url!== 'https://api.openai.com/v1/responses'));
});
for(const stage of ['OpenAI','DeepSeek'])for(const failure of ['timeout','bad-json','oversized'])test(`${stage} ${failure} does not expose its response or use old product data`,async()=>{
 const f=audioScenario();const result=await run(f.s,async(url,o)=>{if(url===(stage==='OpenAI'?openai:deepseek)){if(failure==='timeout')throw Error('private-endpoint-token');return new Response(failure==='bad-json'?'private-endpoint-token':'x'.repeat(128*1024+1));}return f.fetcher(url,o);},f.env);
 assert.equal(result.processingError.provider,stage);assert.equal(result.processingError.code,'unavailable');assert.equal(result.plan.text,null);assert.doesNotMatch(JSON.stringify(result),/private-endpoint-token/);assert.equal(f.s.calls.length,0);
});
for(const text of ['', ' ', 'x'.repeat(4097), null])test(`unusable transcript (${typeof text}/${text?.length}) never calls DeepSeek`,async()=>{
 const f=audioScenario();let ds=0;
 const result=await run(f.s,async(url,o)=>{if(url===openai)return Response.json({text});if(url===deepseek)ds++;return f.fetcher(url,o);},f.env);
 assert.equal(result.processingError.code,'invalid_transcript');assert.equal(ds,0);assert.equal(f.s.calls.length,0);
});
for(const missing of ['deepseek-integration','deepseek-model','deepseek-decrypt','meta'])test(`missing ${missing} stops before external processing`,async()=>{
 const f=audioScenario();if(missing==='deepseek-integration')f.s.db.tables.prospecting_ai_integrations=[];
 if(missing==='deepseek-model')f.s.db.tables.prospecting_ai_integrations[0].models=[];
 if(missing==='deepseek-decrypt')f.s.db.tables.prospecting_ai_integrations[0].api_key_encrypted='invalid-private';
 const result=await run(f.s,f.fetcher,missing==='meta'?keys=>keys.includes('META_WHATSAPP_ACCESS_TOKEN')&&keys.length===1?'':f.env(keys):f.env);
 assert.equal(result.processingError.code,'configuration');assert.equal(f.calls.length,0);assert.doesNotMatch(JSON.stringify(result),/invalid-private/);
});
for(const failure of ['too-large','empty','bad-signature','redirect','foreign-host','wrong-id','aac'])test(`audio ${failure} does not reach either model`,async()=>{
 const f=audioScenario();let provider=0;
 const result=await run(f.s,async(url,o)=>{
  if(url===openai||url===deepseek)provider++;
  if(String(url).includes('graph.facebook.com')&&['foreign-host','wrong-id','aac'].includes(failure))return Response.json({id:failure==='wrong-id'?'333':'123456',url:failure==='foreign-host'?'https://evil.example/audio':'https://lookaside.fbsbx.com/media/audio',mime_type:failure==='aac'?'audio/aac':'audio/wav'});
  if(url==='https://lookaside.fbsbx.com/media/audio'){
   if(failure==='redirect')return new Response(null,{status:302,headers:{location:'https://evil.example'}});
   if(failure==='too-large')return new Response(new Uint8Array(10*1024*1024+1));
   if(failure==='empty')return new Response(new Uint8Array());
   if(failure==='bad-signature')return new Response('<html>');
  }
  return f.fetcher(url,o);
 },f.env);
 assert.ok(result.processingError);assert.equal(provider,0);assert.equal(result.plan.text,null);
});
for(const [mime,signature] of [['audio/ogg','OggS'],['audio/mpeg','ID3'],['audio/mp4','0000ftyp'],['audio/webm',null]])test(`${mime} uses its declared format and OpenAI before DeepSeek`,async()=>{
 const f=audioScenario();let transcribed=false;
 const result=await run(f.s,async(url,o)=>{
  if(String(url).includes('graph.facebook.com'))return Response.json({id:'123456',url:'https://lookaside.fbsbx.com/media/audio',mime_type:mime+'; codecs=opus'});
  if(url==='https://lookaside.fbsbx.com/media/audio')return new Response(signature?new TextEncoder().encode(signature):new Uint8Array([26,69,223,163]));
  if(url===openai){assert.equal(o.body.get('file').type,mime);transcribed=true;return Response.json({text:f.transcript});}
  return f.fetcher(url,o);
 },f.env);
 assert.equal(transcribed,true);assert.equal(result.plan.reason,'audio_context_product_answer');
});
test('DeepSeek interpretation changes downstream product lookup; transcription is not just relabelled',async()=>{
 const f=audioScenario();f.interpretation.query='producto desconocido';f.interpretation.requests=[{query:'producto desconocido',quantity:null}];
 const result=await run(f.s,f.fetcher,f.env);assert.doesNotMatch(result.plan.text,/32.000/);assert.match(result.plan.text,/No encontré/);assert.equal(f.s.calls.length,0);
});
test('DeepSeek can ask clarification and prevents any product reads or made-up quantities',async()=>{
 const f=audioScenario();f.interpretation.needsClarification=true;f.interpretation.observation='¿Para qué refrigerante necesitas el instrumento?';
 const result=await run(f.s,f.fetcher,f.env);assert.equal(result.plan.reason,'media_clarification_required');assert.equal(result.plan.requires,'transcription');assert.equal(f.s.calls.length,0);
});
test('both providers are fixed for audio regardless of explicit image provider selection',async()=>{
 const f=audioScenario();f.s.query.set('imageProvider','openai');const result=await run(f.s,f.fetcher,f.env);
 assert.equal(result.mediaAnalysis.interpretationProvider,'deepseek');assert.ok(f.calls.includes(deepseek));assert.ok(!f.calls.includes('https://api.openai.com/v1/responses'));
});
for(const restriction of ['closed','optout','wrong-account','wrong-sender'])test(`${restriction} audio never downloads or calls a model`,async()=>{
 const f=audioScenario(),event=f.s.incoming.raw_payload.entry[0].changes[0].value;
 if(restriction==='closed')event.messages[0].timestamp='1';if(restriction==='optout')f.s.db.tables.companies[0].whatsapp_status='opt_out';
 if(restriction==='wrong-account')event.metadata.phone_number_id='other-account';if(restriction==='wrong-sender')event.messages[0].from='56999999999';
 const result=await run(f.s,f.fetcher,f.env);assert.equal(result.plan.action,'ignore');assert.equal(f.calls.length,0);
});
test('audio context excludes foreign companies/phones and marked financial/identity data',async()=>{
 const f=audioScenario();let inspected=false;
 const base={...structuredClone(f.s.incoming),message_type:'text',raw_payload:{},occurred_at:new Date(Date.now()-1000).toISOString()};
 f.s.db.tables.whatsapp_messages.push({...base,id:'foreign-company',company_id:'00000000-0000-4000-8000-000000000099',body:'FOREIGN_COMPANY'}, {...base,id:'foreign-phone',phone_number:'+56999999999',body:'FOREIGN_PHONE'}, {...base,id:'same-phone',body:'Margen privado 99887766\nNecesito un instrumento para R32\nRUT 15427713-7\nCliente Privado'});
 const result=await run(f.s,async(url,o)=>{if(url===deepseek){assert.doesNotMatch(o.body,/FOREIGN_COMPANY|FOREIGN_PHONE|99887766|15427713|Cliente Privado/);assert.match(o.body,/instrumento para R32/);inspected=true;}return f.fetcher(url,o);},f.env);
 assert.equal(inspected,true);assert.equal(result.plan.canSend,false);
});

test('audio formal quote uses interpreted products and quantities, never voice as verified customer identity',async()=>{
 const {quoteConversationContext}=await import('../supabase/functions/crm-agent/whatsapp-quote.ts');
 const f=audioScenario();f.s.incoming.id='00000000-0000-4000-8000-000000000033';f.s.query.set('sourceMessageId',f.s.incoming.id);
 const provider=async(url,o)=>{
  if(url===openai)return Response.json({text:'Cotización formal de 2 unidades Manómetro R32. RUT 15427713-7 Cliente hablado Dirección hablada'});
  if(url===deepseek)return Response.json({output:[{content:[{type:'output_text',text:JSON.stringify({...f.interpretation,intent:'formal_quote',requests:[{query:'Manómetro R32',quantity:2}]})}]}]});
  return f.fetcher(url,o);
 };
 const before=structuredClone(f.s.db.tables),preview=await run(f.s,provider,f.env),context=await quoteConversationContext(f.s.db,f.env,f.s.query,provider);
 assert.equal(preview.plan.reason,'quote_customer_data_required');assert.equal(context.ready,false);assert.ok(context.missing.length>0);assert.equal(context.lines[0].quantity,2);assert.deepEqual(f.s.db.tables,before);
});

test('quote preparation does not process an opted-out audio',async()=>{
 const {quoteConversationContext}=await import('../supabase/functions/crm-agent/whatsapp-quote.ts');
 const f=audioScenario();f.s.incoming.id='00000000-0000-4000-8000-000000000033';f.s.query.set('sourceMessageId',f.s.incoming.id);f.s.db.tables.companies[0].whatsapp_status='opt_out';
 await assert.rejects(quoteConversationContext(f.s.db,f.env,f.s.query,f.fetcher),/conversación está bloqueada/);assert.equal(f.calls.length,0);
});

test('a valid long transcript keeps the final product instruction for DeepSeek',async()=>{
 const f=audioScenario(),text='Consulta comercial. '.repeat(100)+' Necesito Manómetro R32';let inspected=false;
 const result=await run(f.s,async(url,o)=>{
  if(url===openai)return Response.json({text});
  if(url===deepseek){assert.equal(JSON.parse(JSON.parse(o.body).input[1].content[0].text).transcript,text);inspected=true;return Response.json({output:[{content:[{type:'output_text',text:JSON.stringify(f.interpretation)}]}]});}
  return f.fetcher(url,o);
 },f.env);
 assert.equal(inspected,true);assert.equal(result.mediaAnalysis.transcript,text);
});
