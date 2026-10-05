import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { encryptApiKey } from '../../supabase/functions/prospecting-integrations/deepseek.ts';
const candidate=JSON.parse(fs.readFileSync('outputs/market-release/latest.json','utf8'));
const root=path.join(candidate.root,'e2e'),source=candidate.source;
fs.mkdirSync(path.join(root,'sql'),{recursive:true});
fs.mkdirSync(path.join(root,'functions/main'),{recursive:true});
const hash=b=>createHash('sha256').update(b).digest('hex'),manifest={productionCalls:false,bundles:[],sql:[]};
// Adapter prepended to the EXACT candidate bundle. Only provider transport is simulated.
const adapter=`const __nativeFetch=globalThis.fetch.bind(globalThis);
globalThis.fetch=async (input,init)=>{
 const url=String(input instanceof Request?input.url:input);
 if(url==='https://api.deepseek.com/responses'){
  const key=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const log=await __nativeFetch('http://kong:8000/rest/v1/fixture_provider_calls',{method:'POST',headers:{apikey:key,Authorization:'Bearer '+key,'Content-Type':'application/json'},body:'{}'});
  if(!log.ok)throw Error('Fixture counter unavailable');
  if(String(init?.body).includes('SYNTHETIC_TIMEOUT'))throw new DOMException('Synthetic provider timeout','TimeoutError');
  return Response.json({status:'completed',output:[],output_text:JSON.stringify({attributes:[{field:'model',value:'ABC',quote:'Modelo ABC'},{field:'price',value:'11900',quote:'Precio 11900 CLP'}]}),usage:{input_tokens:150,output_tokens:50}});
 }
 if(!url.startsWith('http://kong:8000/'))throw Error('Fixture forbids external transport');
 return __nativeFetch(input,init);
};\n`;
for(const name of ['market-study','market-research']){
 const original=fs.readFileSync(path.join(source,'outputs/market-extraction/bundles',name,'index.ts'));
 const wrapped=Buffer.concat([Buffer.from(adapter),original]);fs.mkdirSync(path.join(root,'functions',name),{recursive:true});fs.writeFileSync(path.join(root,'functions',name,'index.ts'),wrapped);
 manifest.bundles.push({name,originalSha256:hash(original),fixtureSha256:hash(wrapped)});
}
for(const name of ['schema.sql','agent_hub.sql','content_center.sql','agent_api_keys.sql','market_study.sql','market_research_api.sql','prospecting_deepseek_settings.sql','market_extraction.sql']){const b=fs.readFileSync(path.join(source,'supabase',name));fs.writeFileSync(path.join(root,'sql',name),b);manifest.sql.push({name,sha256:hash(b)});}
const syntheticSecret='synthetic-only-encryption-secret-2026-e2e';
fs.writeFileSync(path.join(root,'fixture-provider.json'),JSON.stringify({synthetic:true,encryption:syntheticSecret,cipher:await encryptApiKey('synthetic-provider-never-valid',syntheticSecret)}));
fs.writeFileSync(path.join(root,'functions/main/index.ts'),`if(Deno.env.get('VERIFY_JWT')!=='false')throw Error('Fixture router mode required');Deno.serve(async req=>{const name=new URL(req.url).pathname.split('/')[1];if(!['market-study','market-research'].includes(name))return new Response('Not found',{status:404});try{const worker=await EdgeRuntime.userWorkers.create({servicePath:'/home/deno/functions/'+name,memoryLimitMb:150,workerTimeoutMs:60000,noModuleCache:false,importMapPath:null,envVars:Object.entries(Deno.env.toObject())});return await worker.fetch(req);}catch{return Response.json({error:'Fixture worker failed'},{status:500});}});`);
for(const name of ['run.py','admin-extraction.py'])fs.copyFileSync(path.join('scripts/market-research-e2e',name),path.join(root,name));
fs.writeFileSync(path.join(root,'manifest.json'),JSON.stringify(manifest,null,2));console.log(JSON.stringify({root,bundles:manifest.bundles,schemas:manifest.sql.length}));
