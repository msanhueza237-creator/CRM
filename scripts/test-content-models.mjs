import test from 'node:test';
import assert from 'node:assert/strict';
import { encryptApiKey } from '../supabase/functions/prospecting-integrations/deepseek.ts';
import { contentModelCatalog, contentModelRouter, callModelJson } from '../supabase/functions/content-center/model-generation.ts';

const user = '11111111-1111-4111-8111-111111111111';
const productId = '22222222-2222-4222-8222-222222222222';
const secret = 'content-fixture-encryption-secret-not-production';
const key = 'fixture-private-model-key';
const encrypted = await encryptApiKey(key, secret);
const environment = { SUPABASE_URL: 'https://fixture.invalid', SUPABASE_ANON_KEY: 'fixture-anon', SUPABASE_SERVICE_ROLE_KEY: 'fixture-service', PROSPECTING_SECRET_ENCRYPTION_KEY: secret };
const env = k => environment[k];
const integration = { status: 'verified', models: ['deepseek-v4-pro', 'deepseek-flash'], api_key_encrypted: encrypted };
const modelAnswer = data => ({ status: 'completed', output: [{type:'message',content:[{type:'output_text',text:JSON.stringify(data)}]}],usage:{input_tokens:80,output_tokens:30} });

test('Catalogo de contenido comparte DeepSeek, no necesita OpenAI y las referencias no son seleccionables', async () => {
  const catalog = await contentModelCatalog({select:async()=>[integration]}, env);
  assert.equal(catalog.defaultId,'deepseek:deepseek-v4-pro');
  assert.deepEqual(catalog.models.map(m=>m.id),['deepseek:deepseek-v4-pro','deepseek:deepseek-flash']);
  assert.ok(catalog.references.length >= 2 && catalog.references.every(m=>m.available === false));
  assert.doesNotMatch(JSON.stringify(catalog),/fixture-private|api_key_encrypted|encryption-secret/);
  const calls = [];
  const source = {actor:{id:user,role:'administrador'},select:async()=>[integration],request:async(...args)=>calls.push(args)};
  for(const model of [null,'reference:gemma','openai:review','https://evil.invalid','not-allowed']) {
    await assert.rejects(contentModelRouter(source,model,'request',env,async()=>assert.fail('No provider')));
  }
  assert.equal(calls.length,0);
});

test('Modelo por defecto de Contenido es independiente del Copiloto y puede configurarse', async () => {
  const catalog = await contentModelCatalog({select:async()=>[integration]},k=>({ ...environment, COPILOT_DEFAULT_MODEL_CHOICE:'openai:auto', CONTENT_DEFAULT_MODEL_CHOICE:'deepseek:deepseek-flash',OPENAI_API_KEY:'fixture-openai'})[k]);
  assert.equal(catalog.defaultId,'deepseek:deepseek-flash');
  assert.deepEqual(catalog.models.filter(m=>m.provider==='openai').map(m=>m.id),['openai:default']);
});

test('DeepSeek conserva esquema JSON y audita en Contenido sin prompts ni secretos', async () => {
  const writes = [], calls = [];
  const source = {actor:{id:user,role:'vendedor'},select:async()=>[integration],request:async(path,init)=>writes.push({path,data:JSON.parse(init.body)})};
  const {router} = await contentModelRouter(source,'deepseek:deepseek-flash','request',env,async(url,init)=>{
    assert.equal(url,'https://api.deepseek.com/responses');
    assert.equal(init.headers.Authorization,`Bearer ${key}`);
    calls.push(JSON.parse(init.body)); return Response.json(modelAnswer({valid:true,unsupported_claims:[]}));
  });
  const schema={type:'object',properties:{valid:{type:'boolean'}}};
  const result = await callModelJson('test',schema,{private_product_text:'ONLY_IN_REQUEST'},700,router,env);
  assert.equal(result.model,'deepseek-flash');
  assert.deepEqual(calls[0].text.format.schema,schema);
  assert.equal(calls[0].text.format.strict,true);
  assert.equal(writes.length,2);
  assert.ok(writes.every(w=>w.path==='rest/v1/content_history'));
  assert.doesNotMatch(JSON.stringify(writes),/ONLY_IN_REQUEST|fixture-private|api_key_encrypted|encryption-secret/);
});

test('Respuesta vacia, incompleta o JSON invalido no se convierte en borrador',async()=>{
  for(const payload of [{status:'incomplete',output_text:'{}'},{output_text:'broken'},{output_text:'null'},{output_text:'[]'}]) {
    const router={policy:{defaultModel:'fixture'},call:async()=>payload};
    await assert.rejects(callModelJson('test',{}, {},700,router,env),e=>/^CONTENT_AI_/.test(e.code));
  }
});

let handler;
const previousDeno = globalThis.Deno;
globalThis.Deno={env:{get:env},serve:callback=>{handler=callback;}};
await import('../supabase/functions/content-center/index.ts');
globalThis.Deno=previousDeno;

async function endpoint({route='generate',role='administrador',authenticated=true,modelChoice,providerStatus,invalidVerification=false,missingVerification=false,invalidVariants=false,numericLie=false}={}) {
  const previousFetch = globalThis.fetch, beforeDeno = globalThis.Deno;
  const writes=[], modelCalls=[], reads=[];
  globalThis.Deno={env:{get:env}};
  globalThis.fetch=async(url,init={})=>{
    const u=new URL(url), body=init.body?JSON.parse(init.body):null;
    assert.notEqual(u.hostname,'api.openai.com','DeepSeek must not depend on OpenAI');
    assert.ok(!/facebook|instagram|meta\.com/.test(u.hostname),'Never send publications');
    if(u.hostname==='api.deepseek.com') {
      modelCalls.push(body);
      if(providerStatus)return new Response('private raw error '+key,{status:providerStatus});
      if(body.text.format.name==='verify_social_grounding') return Response.json(modelAnswer(missingVerification?{valid:true}:{valid:!invalidVerification,unsupported_claims:invalidVerification?['claim unsupported']:[]}));
      return Response.json(modelAnswer({variants:invalidVariants?[]:[{channel:'instagram',body:numericLie?'Manometro con precio 999999999 pesos.':'Manometro de prueba para trabajos de climatizacion.',hashtags:['Climactiva'],cta:'Conoce mas en climactiva.cl',fact_keys_used:['name','description']}]}));
    }
    assert.equal(u.hostname,'fixture.invalid');
    if(u.pathname==='/auth/v1/user')return Response.json({id:user});
    if(init.method && init.method!=='GET') {
      assert.ok(['content_publications','content_history'].some(t=>u.pathname.endsWith('/'+t)),'Only draft/history writes');
      writes.push({path:u.pathname,body}); return Response.json(body.map(r=>({id:crypto.randomUUID(),...r})));
    }
    reads.push(u.pathname);
    if(u.pathname.endsWith('/profiles'))return Response.json([{id:user,role,active:true}]);
    if(u.pathname.endsWith('/prospecting_ai_integrations'))return Response.json([integration]);
    if(u.pathname.endsWith('/content_products'))return Response.json([{id:productId,name:'Manometro de prueba',description_text:'Manometro de prueba para trabajos de climatizacion.',sku:'QA-MAN',price:1000,stock:10,source_status:'active',sync_status:'synced',primary_image_url:'https://example.test/tool.jpg'}]);
    if(u.pathname.endsWith('/content_channels'))return Response.json([{id:'33333333-3333-4333-8333-333333333333',code:'instagram'}]);
    return Response.json([]);
  };
  try {
    const request=new Request('https://fixture.invalid/functions/v1/content-center/'+route,{method:route==='models'?'GET':'POST',headers:authenticated?{Authorization:'Bearer fixture-user-token'}:{},...(route==='models'?{}:{body:JSON.stringify({productId,channels:['instagram'],modelChoice})})});
    const response=await handler(request);
    return {status:response.status,body:await response.json(),writes,modelCalls,reads};
  } finally {globalThis.fetch=previousFetch;globalThis.Deno=beforeDeno;}
}

test('Endpoint genera y verifica con DeepSeek por defecto, guarda solo borradores',async()=>{
  const result=await endpoint();
  assert.equal(result.status,201,JSON.stringify(result.body));
  assert.equal(result.modelCalls.length,2);
  assert.ok(result.modelCalls.every(c=>c.model==='deepseek-v4-pro'));
  assert.ok(result.body.publications.every(p=>p.status==='pending_approval'&&p.model_name==='deepseek-v4-pro'));
  assert.doesNotMatch(JSON.stringify(result.body),/fixture-private|api_key_encrypted|encryption-secret/);
});
test('Seleccion Flash se usa en generacion y revision, no vuelve al modelo por defecto',async()=>{
  const result=await endpoint({modelChoice:'deepseek:deepseek-flash',role:'vendedor'});
  assert.equal(result.status,201,JSON.stringify(result.body));
  assert.ok(result.modelCalls.every(c=>c.model==='deepseek-flash'));
});
test('Catalogo exige autenticacion y permiso, sin descifrar ni hacer llamadas IA',async()=>{
  for(const options of [{authenticated:false},{role:'visualizador'}]) {
    const result=await endpoint({route:'models',...options});
    assert.equal(result.status,options.authenticated===false?401:403);
    assert.equal(result.modelCalls.length,0);assert.equal(result.writes.length,0);
    assert.ok(!result.reads.includes('/rest/v1/prospecting_ai_integrations'));
  }
  const ok=await endpoint({route:'models'});assert.equal(ok.status,200);assert.equal(ok.modelCalls.length,0);
});
test('Generacion sin permiso o modelo desconocido no llama IA ni guarda borradores',async()=>{
  for(const options of [{authenticated:false},{role:'visualizador'},{modelChoice:'unapproved'},{modelChoice:'reference:gemma'}]) {
    const result=await endpoint(options);assert.ok([401,403,409].includes(result.status));
    assert.equal(result.modelCalls.length,0);assert.equal(result.writes.length,0);
  }
});
test('Verificacion ausente o invalida, variantes faltantes y cifras inventadas bloquean guardado',async()=>{
  for(const options of [{invalidVerification:true},{missingVerification:true},{invalidVariants:true},{numericLie:true}]) {
    const result=await endpoint(options); assert.ok([422,502].includes(result.status),JSON.stringify(result.body));
    assert.ok(result.writes.every(w=>w.path.endsWith('/content_history')));
  }
});
test('Fallo DeepSeek no cambia de proveedor y no expone error privado',async()=>{
  const result=await endpoint({providerStatus:402});assert.equal(result.status,503);
  assert.equal(result.modelCalls.length,1);assert.match(result.body.error,/saldo insuficiente/);
  assert.doesNotMatch(JSON.stringify(result.body),/private raw error|fixture-private/);
  assert.ok(result.writes.every(w=>w.path.endsWith('/content_history')));
});
