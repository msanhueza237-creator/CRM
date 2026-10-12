import assert from 'node:assert/strict';
import {encryptApiKey} from '../supabase/functions/prospecting-integrations/deepseek.ts';
import {scenario} from './whatsapp-automation-fixture.mjs';
const secret='synthetic-encryption-fixture-only-32bytes';
const encrypted=await encryptApiKey('synthetic-only',secret);
export function audioScenario(){
 const s=scenario(),calls=[];
 s.incoming.message_type='audio';
 const message=s.incoming.raw_payload.entry[0].changes[0].value.messages[0];
 message.type='audio';message.audio={id:'123456'};delete message.text;
 s.db.tables.prospecting_ai_integrations=[{provider:'deepseek',status:'verified',models:['deepseek-flash'],api_key_encrypted:encrypted}];
 const transcript='Necesito un medidor para refrigerante R treinta y dos';
 const interpretation={query:'Manómetro R32',observation:'El cliente consulta por un manómetro para R32.',needsClarification:false,intent:'products',requests:[{query:'Manómetro R32',quantity:null}]};
 const env=keys=>keys.includes('OPENAI_API_KEY')?'synthetic-only':keys.includes('PROSPECTING_SECRET_ENCRYPTION_KEY')?secret:s.env(keys);
 const bytes=new Uint8Array(46);const view=new DataView(bytes.buffer);
 bytes.set(new TextEncoder().encode('RIFF'),0);view.setUint32(4,38,true);bytes.set(new TextEncoder().encode('WAVEfmt '),8);view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,16000,true);view.setUint32(28,32000,true);view.setUint16(32,2,true);view.setUint16(34,16,true);bytes.set(new TextEncoder().encode('data'),36);view.setUint32(40,2,true);
 const fetcher=async(url,options)=>{
  calls.push(url);assert.equal(options.redirect,'error');
  if(url==='https://graph.facebook.com/v26.0/123456')return Response.json({id:'123456',url:'https://lookaside.fbsbx.com/media/audio',mime_type:'audio/wav'});
  if(url==='https://lookaside.fbsbx.com/media/audio')return new Response(bytes);
  if(url==='https://api.openai.com/v1/audio/transcriptions'){
   assert.ok(options.body instanceof FormData);assert.equal(options.body.get('model'),'gpt-4o-mini-transcribe');assert.equal(options.body.get('language'),'es');
   assert.deepEqual(new Uint8Array(await options.body.get('file').arrayBuffer()),bytes);
   return Response.json({text:transcript});
  }
  if(url==='https://api.deepseek.com/responses'){
   const payload=JSON.parse(options.body);assert.equal(payload.model,'deepseek-flash');
   assert.equal(payload.input[1].content.length,1);assert.equal(payload.input[1].content[0].type,'input_text');
   assert.equal(JSON.parse(payload.input[1].content[0].text).transcript,transcript);
   assert.doesNotMatch(options.body,/input_image|base64|data:audio|synthetic-only/);
   return Response.json({output:[{content:[{type:'output_text',text:JSON.stringify(interpretation)}]}]});
  }
  return s.fetcher(url,options);
 };
 return {s,calls,env,fetcher,bytes,transcript,interpretation};
}
