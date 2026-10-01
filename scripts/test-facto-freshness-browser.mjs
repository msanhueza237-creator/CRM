import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import os from 'node:os';
import {build} from 'esbuild';
import {chromium} from 'playwright';

// Real page + hook + API client; synthetic auth/network only. No Vite or .env loading.
const repo=fileURLToPath(new URL('..',import.meta.url)).replace(/\\/g,'/').replace(/\/$/,'');
const output=process.argv[2] || await fs.mkdtemp(path.join(os.tmpdir(),'facto-freshness-'));
await fs.mkdir(output,{recursive:true});
const bundle=await build({stdin:{resolveDir:repo,loader:'tsx',contents:`
 import React from 'react'; import {createRoot} from 'react-dom/client';
 import {MemoryRouter} from 'react-router-dom';
 import {AccountingCenterPage} from './src/modules/accounting/AccountingCenterPage';
 createRoot(document.getElementById('root')).render(<MemoryRouter initialEntries={['/finanzas-contabilidad?view=facto']}>
 <div style={{padding:12,background:'#fff3bf'}}>PRUEBA LOCAL — DATOS SINTÉTICOS — API SIMULADA</div>
 <main style={{padding:16}}><AccountingCenterPage /></main></MemoryRouter>);
`},bundle:true,write:false,outfile:output+'/fixture.js',format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},
plugins:[{name:'isolate-production',setup(b){
 b.onLoad({filter:/[/\\]lib[/\\]supabase\.ts$/},()=>({loader:'js',contents:`
 export const isSupabaseConfigured=true;
 export const supabase={auth:{getSession:async()=>({data:{session:window.__fixtureMode==='expired-session'?null:{access_token:'synthetic-not-a-real-token'}}})}};
 export const getSupabaseFunctionUrl=(name,route='')=>'https://crm-fixture.invalid/functions/v1/'+name+'/'+route;
 export const getSupabaseStorageUrl=()=>{throw Error('Storage disabled in fixture')};
 export const getSupabaseAnonKey=()=> 'synthetic-not-a-real-key';
 `}));
 b.onLoad({filter:/[/\\]auth[/\\]AuthContext\.tsx$/},()=>({loader:'js',contents:`export const useAuth=()=>({user:{id:'synthetic',role:'administrador'},isDemoMode:true,loading:false});`}));
 b.onLoad({filter:/\.css$/},()=>({loader:'css',contents:''}));
}}]});
const code=bundle.outputFiles.find(f=>f.path.endsWith('.js'))?.text||bundle.outputFiles[0].text;
const css=await fs.readFile(repo+'/src/styles.css','utf8')+'\n'+await fs.readFile(repo+'/src/modules/accounting/accountingCenter.css','utf8');
const now=new Date().toISOString(),old='2020-01-01T00:00:00Z';
const run=(id,status,extra={})=>({id,status,from_date:'2026-01-01',to_date:'2026-09-30',created_at:now,updated_at:now,
 source_records:2,in_range_records:2,inserted_records:1,updated_records:1,inconsistent_records:0,skipped_records:0,receivables:0,payables:0,...extra});
const fixture=()=>({entity:{id:'synthetic-entity',name:'EMPRESA SINTETICA'},profile:{role:'administrador',permissions:['import','post']},
 sources:[],batches:[],receivables:[],payables:[],checks:[],bankAccounts:[],paymentEvents:[],periods:[],
 summary:{as_of:now.slice(0,10)},factoFreshness:{integrationUpdatedAt:now,accountingSyncedAt:old,stale:true},factoReceivableSyncRuns:[],
 factoSyncRuns:[run('complete','completed'),run('cancel','cancelled'),run('expired','running',{lease_expires_at:old}),run('legacy','running',{updated_at:old})]});
const browser=await chromium.launch({headless:true,channel:'chrome'});
const context=await browser.newContext({serviceWorkers:'block',viewport:{width:1280,height:900}});
const results=[];let calls=[],unexpected=[],mode='success',data=fixture(),release,readFailure='';
await context.route('**/*',async route=>{
 const request=route.request(),url=new URL(request.url());
 if(url.origin!=='https://crm-fixture.invalid'){unexpected.push({origin:url.origin,method:request.method()});return route.abort();}
 const endpoint=url.pathname.replace('/functions/v1/accounting-center/','');
 calls.push({endpoint,method:request.method(),...(request.method()==='POST'?{body:request.postDataJSON()}: {})});
 const respond=(status,payload)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(payload)});
 if(endpoint==='bootstrap'&&request.method()==='GET'&&readFailure==='network')return route.abort();
 if(endpoint==='bootstrap'&&request.method()==='GET')return respond(mode==='bootstrap-error'?503:200,mode==='bootstrap-error'?{error:'Fallo sintético de lectura'}:data);
 if(endpoint==='facto/sync'&&request.method()==='POST'){
   await new Promise(resolve=>{release=resolve;});
   if(mode==='conflict')return respond(409,{error:'Ya existe una consolidación en curso (synthetic).'});
   if(mode==='close-unconfirmed')return respond(503,{error:'No se pudo confirmar el cierre de synthetic. No se garantiza reversión de los lotes; revisar antes de reintentar.'});
   data.factoSyncRuns.unshift(run('new-run','completed'));
   return respond(200,{runId:'new-run',status:'completed',accepted:3,inserted:2,updated:1,backups:3,receivables:0,payables:0,reportedBalances:0,inconsistent:0});
 }
 unexpected.push({endpoint,method:request.method()});return route.abort();
});
try{
 for(const testMode of ['success','conflict','close-unconfirmed','expired-session','bootstrap-error']){
  mode=testMode;calls=[];release=undefined;data=fixture();const errors=[];
  const page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
  await page.setContent('<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div></html>');
  await page.evaluate(value=>window.__fixtureMode=value,testMode==='expired-session'?'success':testMode);
  await page.addStyleTag({content:css});await page.addScriptTag({content:code});
  if(testMode==='bootstrap-error'){
   await page.getByText('Fallo sintético de lectura',{exact:true}).waitFor();assert.equal(calls.filter(c=>c.method==='POST').length,0);
  }else{
   const button=page.getByRole('button',{name:'Actualizar ahora',exact:true});await button.waitFor();
   await page.getByText('Cancelada',{exact:true}).waitFor();
   await page.getByText('Interrumpida; pendiente de recuperar',{exact:true}).waitFor();
   await page.getByText('Sin actividad confirmada; revisar',{exact:true}).waitFor();
   const initialReads=calls.length;await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
   await page.getByRole('button',{name:'Actualizar',exact:true}).click();
   await page.waitForTimeout(100);assert.ok(calls.length>initialReads);assert.equal(calls.filter(c=>c.method==='POST').length,0);
   if(testMode==='success'){
    for(const width of [1280,390,320]){await page.setViewportSize({width,height:900});await page.screenshot({path:output+`/facto-history-${width}.png`,fullPage:true});
      const layout=await page.locator('.accounting-facto-history article').evaluateAll(rows=>rows.map(row=>{const box=row.getBoundingClientRect();const date=row.querySelector('div').getBoundingClientRect();return {row:box.width,date:date.width,overflow:row.scrollWidth>row.clientWidth+1};}));
      assert.ok(layout.every(r=>!r.overflow),'history overflow at '+width);
      if(width<761)assert.ok(layout.every(r=>r.date>=r.row-2),'date must retain full row width at '+width);}
    await page.setViewportSize({width:1280,height:900});
   }
   if(testMode==='success'){
    for(const failure of ['network','session']){
      readFailure=failure==='network'?'network':'';
      await page.evaluate(f=>{window.__fixtureMode=f==='session'?'expired-session':'success';window.dispatchEvent(new Event('focus'));},failure);
      const warning=page.getByRole('alert');await warning.waitFor();
      assert.match(await warning.innerText(),/Se conservan las cifras/);
      assert.match(await warning.innerText(),/Última lectura exitosa del CRM/);
      assert.equal(await page.getByText('Cancelada',{exact:true}).count(),1,'previous data retained');
      assert.equal(calls.filter(c=>c.method==='POST').length,0);
      readFailure='';await page.evaluate(()=>{window.__fixtureMode='success';window.dispatchEvent(new Event('focus'));});
      await warning.waitFor({state:'detached'});
    }
    for(const [state,label] of [[undefined,'Actualización sin confirmar'],['failed','Último intento fallido'],['cancelled','Último intento cancelado'],['partial','Consolidación con observaciones'],['old_reading','Lectura del conector de más de 24 horas'],['mirror_consolidated','Período consolidado en el espejo']]){
      data.factoFreshness.state=state;
      await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
      await page.locator('.accounting-facto-freshness .accounting-status').filter({hasText:label}).waitFor();
    }
   }
   if(testMode==='expired-session'){
    await page.evaluate(()=>window.__fixtureMode='expired-session');await button.click();
    await page.getByText('Tu sesión expiró. Vuelve a iniciar sesión.',{exact:true}).waitFor();
    assert.equal(calls.filter(c=>c.method==='POST').length,0);
   }else{
    await button.click();const busy=page.getByRole('button',{name:'Consolidando…',exact:true});await busy.waitFor();assert.equal(await busy.isDisabled(),true);
    assert.equal(calls.filter(c=>c.method==='POST').length,1);assert.equal(calls.find(c=>c.method==='POST').body.triggerType,'manual');
    assert.equal(typeof release,'function');release();
    const expected=testMode==='success'?'Documentos Facto actualizados. Esta sincronización no incluye asientos ni costos del Libro Diario.':testMode==='conflict'?'Ya existe una consolidación en curso (synthetic).':'No se pudo confirmar el cierre de synthetic. No se garantiza reversión de los lotes; revisar antes de reintentar.';
    await page.getByText(expected,{exact:true}).waitFor();
    if(testMode!=='success')assert.equal(await page.locator('.notice-banner.success').count(),0);
    assert.equal(calls.filter(c=>c.method==='POST').length,1);
   }
  }
  assert.deepEqual(errors,[]);results.push({mode:testMode,passed:true,reads:calls.filter(c=>c.method==='GET').length,syntheticWrites:calls.filter(c=>c.method==='POST').length});
  await page.close();console.log('PASS isolated real page/hook/client: '+testMode);
 }
 assert.deepEqual(unexpected,[]);
 await fs.writeFile(output+'/results.json',JSON.stringify({observedAt:new Date().toISOString(),productionAccess:false,network:'all requests intercepted; only fixture origin fulfilled',results,unexpected},null,2));
}finally{if(release)release();await browser.close();}
