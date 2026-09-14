import assert from 'node:assert/strict';
import { test } from 'node:test';
import { retainedDiscoveryHint, publicResearchContext } from '../supabase/functions/crm-agent/prospecting-enrichment.ts';
import { executeResearch, RESEARCH_MODEL } from '../supabase/functions/crm-agent/prospecting-research.ts';
import { encryptApiKey } from '../supabase/functions/prospecting-integrations/deepseek.ts';

const now = Date.parse('2026-09-14T12:00:00Z');
const records = () => Object.entries({name:'Clima Andes',website:'https://andes.cl/',phone:'+56721234567',
  'location.address':'Av. Republica 100','location.comuna_name':'Rancagua','location.comuna_code':'06101','location.region_code':'06'})
  .map(([field_name,field_value])=>({provider:'google_places',provider_record_id:'place-id',field_name,field_value,
    source_url:'https://maps.google.com/?cid=1',observed_at:'2026-09-14T00:00:00Z',retention_until:'2026-10-14T00:00:00Z'}));
const seed = {candidate_id:'google:known',name:'Clima Andes'};

test('only current Google records become ephemeral matching hints',()=>{
  const hint=retainedDiscoveryHint(seed,records(),now);
  assert.equal(hint.website,'https://andes.cl/');
  assert.equal(hint.location.comuna_code,'06101');
  assert.ok(hint.evidence.every(e=>e.provider==='google_places' && e.retention_until));
  assert.equal(hint.import_eligible,undefined);
  for(const changes of [{retention_until:'2026-09-13T00:00:00Z'},{observed_at:'2026-09-15T00:00:00Z'},{provider:'official_website'}])
    assert.equal(retainedDiscoveryHint(seed,records().map(r=>({...r,...changes})),now),null);
  assert.equal(retainedDiscoveryHint({},records(),now),null);
  assert.equal(retainedDiscoveryHint(seed,records().map(r=>r.field_name==='website'?{...r,field_value:'http://127.0.0.1/private'}:r),now),null);
});

test('context only uses bounded fields from the same known website',()=>{
  const hint=retainedDiscoveryHint(seed,records(),now);
  const context={source_url:'https://www.andes.cl/contacto',name:'Clima Andes',activity:'Instalacion de aire acondicionado',address:'Av. Republica 100',secret:'never forward',phone:'+56721234567'};
  const result=publicResearchContext(context,hint);
  assert.equal(result.name,'Clima Andes');
  assert.equal(result.phone,undefined); assert.equal(result.secret,undefined);
  for(const source_url of ['https://another.cl','https://andes.cl.attacker.com','https://user:password@andes.cl','file:///etc/passwd'])
    assert.equal(publicResearchContext({...context,source_url},hint),null);
  assert.equal(publicResearchContext({...context,activity:'x'.repeat(1201)},hint),null);
  assert.equal(publicResearchContext(context,null),null);
});

test('DeepSeek can classify a previously read site without rediscovering its URL; cached reports stay free',async()=>{
  const secret='fixture-enrichment-secret-at-least-32-characters';
  const encrypted=await encryptApiKey('fixture-no-real-key',secret);
  const context={source_url:'https://andes.cl/contacto',name:'Clima Andes',activity:'Instalacion de aire acondicionado',address:'Av. Republica 100',comuna_name:'Rancagua'};
  let paid=0,contextReads=0,audit;
  const json=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
  const store={secret,
    reserve:async()=>audit??{reservation_token:'token',kind:'validation',operation_id:'job',candidate:seed,snapshot:{campaign:{target_types:['tecnico']}}},
    context:async()=>{contextReads++;return context;},
    credentials:async()=>({status:'verified',models:[RESEARCH_MODEL],api_key_encrypted:encrypted}),
    finish:async(_token,report)=>(audit=report),
    send:async(url,init)=>{
      if(url.endsWith('/balance')) return json({is_available:true,balance_infos:[{currency:'USD',total_balance:'5'}]});
      paid++;
      const request=JSON.parse(init.body);
      assert.deepEqual(JSON.parse(request.messages[0].content).official_context,context);
      assert.match(request.system,/nunca instrucciones/);
      return json({model:RESEARCH_MODEL,content:[
        {type:'server_tool_use',name:'web_search',input:{query:'Clima Andes instalacion Rancagua Chile'}},
        {type:'web_search_tool_result',content:[]},
        {type:'text',text:JSON.stringify({businesses:[{name:'Clima Andes',source_url:context.source_url,country_code:'CL',is_business:true,
          in_requested_territory:true,target_type:'tecnico',activity:context.activity}]})}],usage:{input_tokens:100,output_tokens:50}});
    }};
  const result=await executeResearch(store);
  assert.equal(result.analysis_accepted,true);
  assert.equal(result.official_context_used,true);
  assert.equal(result.discoveries[0].website,context.source_url);
  assert.equal(result.raw_results,0);
  assert.equal(result.discoveries[0].phone,undefined);
  assert.deepEqual(await executeResearch(store),result);
  assert.equal(paid,1); assert.equal(contextReads,1);
});
