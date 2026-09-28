import test from 'node:test';
import assert from 'node:assert/strict';
import { copilotConfig } from '../supabase/functions/crm-copilot/config.ts';
import { createGeminiSession, geminiSetup, geminiUsage, geminiHistory } from '../supabase/functions/crm-copilot/gemini.ts';
import { liveHandler, ownedVoice } from '../supabase/functions/crm-copilot/live.ts';
import { redactSecrets } from '../supabase/functions/crm-copilot/safety.ts';
import { GeminiProtocol, geminiSocketUrl, pcm16, decodePcm16 } from '../src/modules/copilot/geminiProtocol.ts';

const env = { GEMINI_API_KEY:'private-google-fixture', OPENAI_API_KEY:'private-openai-fixture' };
const config = (overrides = {}) => copilotConfig(k => ({ ...env, ...overrides })[k]);
const user='00000000-0000-4000-8000-000000000001', conv='00000000-0000-4000-8000-000000000002', voice='00000000-0000-4000-8000-000000000003', msg='00000000-0000-4000-8000-000000000004';
const req = (path, body) => new Request('https://crm.test/'+path, body ? {method:'POST',body:JSON.stringify(body)} : {});
function source(overrides={}) {
  const writes=[];
  return { actor:{id:user,role:'administrador'},writes,
    async select(path) {
      if (path.includes('live_session_created')) return [{id:voice,conversation_id:conv,created_at:new Date().toISOString(),metadata_redacted:{role:'administrador',protocol:'gemini',liveId:voice,maxSeconds:900}}];
      if (path.startsWith('copilot_conversations')) return [{id:conv,created_at:new Date().toISOString(),metadata:{engine:'central',role:'administrador'}}];
      if (path.startsWith('copilot_messages')) return [{id:msg,role:'assistant',content:'Ventas: 100 CLP, margen provisional.',metadata:{voiceSessionId:voice,delegationId:'read_1'}}];
      return [];
    },
    async request(path, init) { writes.push({path,body:JSON.parse(init.body)}); return [{id:voice}]; }, ...overrides };
}
test('Catalog keeps OpenAI and Gemini separate from reasoning and never leaks keys', async()=>{
  const response=await liveHandler(req('voice-providers'),source(),config(),'trace',{});
  const data=await response.json();
  assert.equal(data.defaultId,'gemini'); assert.equal(data.providers.length,2);
  assert.ok(data.providers.every(p=>p.available)); assert.ok(!JSON.stringify(data).includes('private-'));
  const noGoogle=await (await liveHandler(req('voice-providers'),source(),config({GEMINI_API_KEY:''}),'trace',{})).json();
  assert.equal(noGoogle.defaultId,'openai'); assert.equal(noGoogle.providers[0].available,false);
});
test('Gemini configuration uses only manager tool, audio, transcripts and barge-in',()=>{
  const setup=geminiSetup(config().gemini,'Reglas');
  assert.deepEqual(setup.tools[0].functionDeclarations.map(t=>t.name),['ask_manager']);
  assert.equal(setup.realtimeInputConfig.activityHandling,'START_OF_ACTIVITY_INTERRUPTS');
  assert.deepEqual(setup.generationConfig.responseModalities,['AUDIO']);
  assert.ok(!JSON.stringify(setup).includes(env.GEMINI_API_KEY));
  assert.match(setup.systemInstruction.parts[0].text,/No hay herramientas de escritura/);
});
test('Ephemeral mint locks setup, uses one session, expires and sends key only in server header',async()=>{
  let sent;
  const output=await createGeminiSession(config().gemini,'Reglas',new AbortController().signal,async(url,init)=>{
    sent={url,init,body:JSON.parse(init.body)};return Response.json({name:'auth_tokens/test-capability'});
  });
  assert.equal(sent.init.headers['x-goog-api-key'],env.GEMINI_API_KEY);
  assert.equal(sent.body.uses,1); assert.ok(sent.body.bidiGenerateContentSetup.tools);
  assert.ok(Date.parse(sent.body.expireTime)>Date.now());
  assert.equal(output.credential,'auth_tokens/test-capability');
  assert.ok(!JSON.stringify(output).includes(env.GEMINI_API_KEY));
});
test('Provider failures do not expose upstream private text or silently switch to OpenAI',async()=>{
  for(const status of [400,401,403,429,500]) await assert.rejects(createGeminiSession(config().gemini,'',new AbortController().signal,async()=>new Response('private-body',{status})),e=>!e.message.includes('private-body'));
  await assert.rejects(createGeminiSession(config({GEMINI_API_KEY:''}).gemini,'',new AbortController().signal),/no esta configurado/);
});
test('Google keys are redacted from stored history and prompt data',()=>{
  const key='AIza'+'x'.repeat(35);
  assert.ok(!redactSecrets(key).includes(key));
  const history=geminiHistory([{role:'user',content:key},{role:'assistant',content:'Resultado'}]);
  assert.equal(history[1].role,'model'); assert.ok(!JSON.stringify(history).includes(key));
});
test('Gemini voice with DeepSeek needs no OpenAI key; audit has no temporary capability',async()=>{
  const original=globalThis.fetch;
  globalThis.fetch=async()=>Response.json({name:'auth_tokens/test-capability'});
  const s=source();
  try {
    // With no available reasoning credential, fail before minting instead of bypassing model catalog.
    const denied=await liveHandler(req('voice-session',{protocol:'gemini',conversationId:conv}),s,config({OPENAI_API_KEY:''}),'trace',{});
    assert.notEqual(denied.status,201);
    const originalSelect=s.select;
    s.select=async path=>path.startsWith('prospecting_ai_integrations') ? [{status:'verified',models:['deepseek-v4-pro']}] : originalSelect(path);
    const ok=await liveHandler(req('voice-session',{protocol:'gemini',conversationId:conv,modelChoice:'deepseek:deepseek-v4-pro'}),s,config({OPENAI_API_KEY:'',PROSPECTING_SECRET_ENCRYPTION_KEY:'fixture-encryption-secret'}),'trace',{});
    const data=await ok.json(); assert.equal(ok.status,201); assert.equal(data.protocol,'gemini');
    assert.equal(data.credential,'auth_tokens/test-capability');
    assert.ok(!JSON.stringify(s.writes).includes('test-capability'));
    assert.equal(s.writes.at(-1).body.metadata_redacted.protocol,'gemini');
  } finally { globalThis.fetch=original; }
});
test('Gemini result reloads authorized persisted answer and strips browser supplied text',async()=>{
  const s=source();
  const r=await liveHandler(req('voice-result',{voiceSessionId:voice,messageId:msg,delegationId:'read_1',content:'inventar'}),s,config({OPENAI_API_KEY:''}),'trace',{});
  assert.equal(r.status,200); const data=await r.json();
  assert.match(data.spokenResult,/100 CLP/); assert.ok(!data.spokenResult.includes('inventar'));
  const wrong=await liveHandler(req('voice-result',{voiceSessionId:voice,messageId:msg,delegationId:'another'}),s,config(),'trace',{});
  assert.equal(wrong.status,403);
});
test('Expired, ended, other-role and other-conversation Gemini sessions fail closed',async()=>{
  await assert.rejects(ownedVoice(source({actor:{id:user,role:'vendedor'}}),voice));
  await assert.rejects(ownedVoice(source(),voice,'different'));
  const original=source();
  await assert.rejects(ownedVoice(source({select:async p=>{
    const items=await original.select(p);
    if(p.includes('live_session_created')) items[0].created_at=new Date(Date.now()-1800000).toISOString();
    return items;
  }}),voice));
  await assert.rejects(ownedVoice(source({select:async p=>p.includes('live_session_ended')?[{id:voice}]:original.select(p)}),voice));
});

test('Cancelled Gemini delegation rejects a persisted result before audio delivery',async()=>{
  const original=source();
  const s=source({select:async p=>p.startsWith('copilot_audit_events?select=id&id=eq.')?[{id:voice}]:original.select(p)});
  const r=await liveHandler(req('voice-result',{voiceSessionId:voice,messageId:msg,delegationId:'read_1'}),s,config(),'trace',{});
  assert.equal(r.status,409); assert.equal((await r.json()).cancelled,true);
  assert.equal(s.writes.length,0);
});

test('Session creation fails closed when audit cannot persist the capability ownership',async()=>{
  const original=globalThis.fetch;
  globalThis.fetch=async()=>Response.json({name:'auth_tokens/not-delivered'});
  try {
    const s=source({request:async()=>{throw new Error('storage unavailable');}});
    const r=await liveHandler(req('voice-session',{protocol:'gemini',conversationId:conv}),s,config(),'trace',{});
    assert.notEqual(r.status,201); assert.ok(!(await r.text()).includes('not-delivered'));
  }finally{globalThis.fetch=original;}
});

test('Disabled voice never mints a token; ownership query is scoped to the authenticated user',async()=>{
  const disabled=await liveHandler(req('voice-session',{protocol:'gemini'}),source(),config({COPILOT_GEMINI_LIVE_ENABLED:'false'}),'trace',{});
  assert.equal(disabled.status,503);
  const original=source(),paths=[];
  await ownedVoice(source({select:async p=>{paths.push(p);return original.select(p);}}),voice);
  assert.ok(paths.every(p=>p.includes(`user_id=eq.${user}`)));
});
test('Usage drops arbitrary content and unknown prices are not reported as free',async()=>{
  const s=source();
  const r=await liveHandler(req('voice-usage',{voiceSessionId:voice,seconds:1,tokens:{promptTokenCount:20,responseTokenCount:5,totalTokenCount:25,apiKey:'bad',promptTokensDetails:[{modality:'AUDIO',tokenCount:20}]} }),s,config(),'trace',{});
  assert.equal(r.status,200);
  const m=s.writes.at(-1).body.metadata_redacted; assert.equal(m.estimatedUsd,null); assert.equal(m.protocol,'gemini');
  assert.equal(m.tokens.promptTokensDetails[0].tokenCount,20); assert.ok(!JSON.stringify(m).includes('bad'));
  assert.equal(geminiUsage({totalTokenCount:Infinity}).totalTokenCount,0);
});
test('Audio PCM is little-endian, bounded and rejects malformed chunks',()=>{
  const samples=decodePcm16(pcm16(new Float32Array([-2,-1,0,0.5,1,2,NaN])));
  assert.deepEqual([...samples.slice(0,3)],[-1,-1,0]);
  assert.ok(Math.abs(samples[3]-0.5)<0.001); assert.equal(samples[6],0);
  assert.throws(()=>decodePcm16(btoa('x')));
  assert.throws(()=>geminiSocketUrl('permanent-key'));
  assert.match(geminiSocketUrl('auth_tokens/test'),/BidiGenerateContentConstrained\?access_token=/);
});

test('Audio suspension metrics are allowlisted without microphone content or credentials',async()=>{
  const s=source();
  const r=await liveHandler(req('voice-usage',{voiceSessionId:voice,seconds:1,metrics:{captureFrames:45,audioPauses:1,audioRecoveries:1,captureStalls:0,hiddenCount:2,transcript:'private',apiKey:'private'}}),s,config(),'trace',{});
  assert.equal(r.status,200);
  assert.deepEqual(s.writes.at(-1).body.metadata_redacted.metrics,{captureFrames:45,audioPauses:1,audioRecoveries:1,captureStalls:0,hiddenCount:2});
});
test('Gemini supports multiple audio parts, transcripts and scoped manager delegation',()=>{
  const events=[],audio=[],sent=[];let cleared=0;
  const p=new GeminiProtocol(e=>events.push(e),d=>audio.push(d),()=>cleared++,e=>sent.push(e));
  p.receive({serverContent:{modelTurn:{parts:[{inlineData:{mimeType:'audio/pcm;rate=24000',data:'AAA='}},{inlineData:{mimeType:'audio/pcm',data:'AAA='}}]},inputTranscription:{text:'Ventas'},outputTranscription:{text:'Revisando'}}},10);
  assert.equal(audio.length,2); assert.equal(events.length,2);
  const call={toolCall:{functionCalls:[{id:'provider/1',name:'ask_manager',args:{question:'Cuanto vendimos'}}]}};
  p.receive(call,20); p.receive(call,20);
  const delegation=events.find(e=>e.type==='session.delegation.created').delegation;
  assert.equal(delegation.question,'Cuanto vendimos');
  assert.match(delegation.id,/^[\w-]+$/);
  assert.equal(p.result(delegation.id,'100 CLP'),true);
  assert.equal(p.result(delegation.id,'duplicado'),false);
  assert.equal(sent[0].toolResponse.functionResponses[0].id,'provider/1');
  p.receive({serverContent:{interrupted:true}},30);assert.equal(cleared,1);
});
test('Cancellation suppresses late tool results and does not run a replacement tool',()=>{
  const events=[],sent=[];
  const p=new GeminiProtocol(e=>events.push(e),()=>{},()=>{},e=>sent.push(e));
  p.receive({toolCall:{functionCalls:[{id:'a',name:'ask_manager',args:{question:'Ventas'}}]}},1);
  const id=events[0].delegation.id;
  p.receive({toolCallCancellation:{ids:['a']}},2);
  assert.equal(p.result(id,'late'),false); assert.equal(sent.length,0);
  p.receive({toolCall:{functionCalls:[{id:'b',name:'delete_customer',args:{question:'Borra'}}]}},3);
  assert.equal(events.filter(e=>e.type==='session.delegation.created').length,1);
  assert.match(sent[0].toolResponse.functionResponses[0].response.error,/no disponible/);
});
test('Ten consecutive turns use unique delegations and preserve the single manager route',()=>{
  const events=[],sent=[];const p=new GeminiProtocol(e=>events.push(e),()=>{},()=>{},e=>sent.push(e));
  for(let i=0;i<10;i++) {
    p.receive({toolCall:{functionCalls:[{id:`call${i}`,name:'ask_manager',args:{question:i?'Y el anterior?':'Ventas del mes'}}]}},i*100);
    p.result(events.at(-1).delegation.id,'Respuesta verificada');
  }
  assert.equal(new Set(events.map(e=>e.delegation.id)).size,10); assert.equal(sent.length,10); assert.equal(p.calls.size,0);
});
