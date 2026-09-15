import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

const source=await readFile(new URL('../supabase/functions/accounting-center/index.ts',import.meta.url),'utf8');
const tree=ts.createSourceFile('index.ts',source,ts.ScriptTarget.Latest,true);
const code=ts.transpileModule(tree.statements.filter(n=>!ts.isImportDeclaration(n)).map(n=>n.getText(tree)).join('\n'),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const user='22222222-2222-4222-8222-222222222222', entity='33333333-3333-4333-8333-333333333333';
let handler, role='administrador', active=true, rpcError=false;
const calls=[];
const context=vm.createContext({Request,Response,Headers,URL,crypto,console:{log(){},error(){},warn(){}},Deno:{serve(fn){handler=fn;},env:{get(key){return {SUPABASE_URL:'https://fixture.invalid',SUPABASE_ANON_KEY:'anon',SUPABASE_SERVICE_ROLE_KEY:'service',CRM_APP_URL:'https://app.invalid'}[key];}}},fetch:async(url,options={})=>{
  const u=new URL(url);
  if(u.pathname==='/auth/v1/user')return Response.json({id:user});
  if(u.pathname==='/rest/v1/profiles')return Response.json([{id:user,role,active}]);
  calls.push({url:u,body:options.body?JSON.parse(options.body):null});
  if(u.pathname.startsWith('/rest/v1/rpc/'))return rpcError?Response.json({message:'Periodo cerrado'},{status:409}):Response.json({existing:false,amountClp:5000000});
  if(u.pathname==='/rest/v1/accounting_loans')return Response.json([]);
  throw new Error(`Unexpected fetch: ${u.pathname}`);
}});
vm.runInContext(code,context);
const call=(route,body,auth=true)=>handler(new Request(`https://app.invalid/functions/v1/accounting-center/${route}`,{method:body?'POST':'GET',headers:{...(auth?{Authorization:'Bearer fixture'}:{}),'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})}));
let response=await call(`loans?entityId=${entity}`,null,false);assert.equal(response.status,401);assert.equal(calls.length,0);
for(const r of ['vendedor','visualizador']){role=r;assert.equal((await call(`loans?entityId=${entity}`)).status,403);}
role='administrador';active=false;assert.equal((await call('loans/save',{})).status,403);active=true;
response=await call(`loans?entityId=${entity}`);assert.equal(response.status,200);assert.match(response.headers.get('Cache-Control'),/no-store/);
assert.equal(calls.at(-1).url.searchParams.get('entity_id'),`eq.${entity}`);assert.match(calls.at(-1).url.searchParams.get('select'),/accounting_journal_entries/);
assert.equal((await call('loans?entityId=bad')).status,400);
await call('loans/save',{id:entity,p_actor_id:'spoofed'});assert.equal(calls.at(-1).body.p_actor_id,user);
const action={loanId:entity,transactionId:user,kind:'received',p_confirm:true,p_actor_id:'spoofed'};
response=await call('loans/preview',action);assert.equal(response.status,200);assert.equal(calls.at(-1).body.p_confirm,false);assert.equal(calls.at(-1).body.p_actor_id,user);
role='finanzas';response=await call('loans/post',{...action,p_confirm:false});assert.equal(response.status,200);assert.equal(calls.at(-1).body.p_confirm,true);
rpcError=true;response=await call('loans/post',action);assert.equal(response.status,409);assert.match(JSON.stringify(await response.json()),/Periodo cerrado/);
const before=calls.length;response=await call('loans/post',{...action,transactionId:'invalid'});assert.equal(response.status,400);assert.equal(calls.length,before);
console.log('PASS loans API: real handler auth/roles, trusted actor, preview cannot post, finance posting, exact entity, no-store, UUID validation and database errors.');
