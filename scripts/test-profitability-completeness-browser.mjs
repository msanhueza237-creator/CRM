import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import os from 'node:os';
import {build} from 'esbuild';
import {chromium} from 'playwright';
import {customerProfitability} from '../supabase/functions/accounting-center/customer-profitability.ts';
const repo=fileURLToPath(new URL('..',import.meta.url));
const output=process.argv[2]||await fs.mkdtemp(path.join(os.tmpdir(),'profitability-browser-'));
await fs.mkdir(output,{recursive:true});
const bundle=await build({stdin:{resolveDir:repo,loader:'tsx',contents:`
import React from 'react';import {createRoot} from 'react-dom/client';
import {CustomerProfitabilityOverview} from './src/modules/dashboard/CustomerProfitabilityOverview';
createRoot(document.getElementById('root')).render(<main style={{padding:12}}><p>DATOS SINTÉTICOS — PRUEBA AISLADA</p><CustomerProfitabilityOverview from="2026-09-01" to="2026-09-14" refreshedAt="synthetic" periodLabel="Prueba septiembre" /></main>);
`},bundle:true,write:false,outfile:output+'/fixture.js',format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},plugins:[{name:'synthetic-auth',setup(b){b.onLoad({filter:/[/\\]lib[/\\]supabase\.ts$/},()=>({loader:'js',contents:`export const isSupabaseConfigured=true;export const supabase={auth:{getSession:async()=>({data:{session:{access_token:'synthetic-only'}}})}};export const getSupabaseFunctionUrl=(name,route)=>'https://fixture.invalid/'+route;export const getSupabaseStorageUrl=()=>{throw Error('Disabled')};export const getSupabaseAnonKey=()=> 'synthetic-only';`}));}}]});
const js=bundle.outputFiles.find(f=>f.path.endsWith('.js')).text;
const css=await fs.readFile(path.join(repo,'src/styles.css'),'utf8')+'\n'+await fs.readFile(path.join(repo,'src/modules/dashboard/dashboard.css'),'utf8');
const docs=Array.from({length:24},(_,i)=>({id:'doc-'+i,entity_id:'entity',source_type:'FACTO',folio:String(i),issued_on:'2026-09-05',document_type:'sales_invoice',counterpart_tax_id:i===2?'':`${12345000+i}-9`,counterpart_name:`Cliente sintético ${i}`,currency:i===3?'USD':'CLP',net_amount:1000+i,exempt_amount:0,total_clp:(1000+i)*1.19,tax_amount:(1000+i)*.19,status:'validated',data_quality:'validated'}));
const lines=[{id:'cost',account_id:'cost',debit_clp:600,credit_clp:0},{id:'stock',account_id:'stock',debit_clp:0,credit_clp:600}].map(l=>({...l,accounting_journal_entries:{id:'entry',source_document_id:'doc-0',status:'posted',entry_date:'2026-09-05'}}));
const accounts=[{id:'cost',classification:'cost_of_sales'},{id:'stock',classification:'inventory'}];
const browser=await chromium.launch({headless:true,channel:'chrome'});
const context=await browser.newContext({serviceWorkers:'block',viewport:{width:1280,height:900}});
const calls=[],unexpected=[],errors=[];let fail=false;
await context.route('**/*',async route=>{
 const req=route.request(),url=new URL(req.url());
 if(url.origin!=='https://fixture.invalid'||req.method()!=='GET'||url.pathname!=='/customer-profitability'){unexpected.push(req.method()+' '+url.origin+url.pathname);return route.abort();}
 calls.push(Object.fromEntries(url.searchParams));
 if(fail)return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Fallo sintético de lectura'})});
 const r=customerProfitability(docs,lines,accounts,'2026-09-01','2026-09-14',url.searchParams.get('query')||'',20,Number(url.searchParams.get('offset')),{cohort:url.searchParams.get('cohort'),sourceObservedAt:'2020-01-01'});
 return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(r)});
});
try{
 const page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
 await page.setContent('<html lang="es"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div></html>');
 await page.addStyleTag({content:css});await page.addScriptTag({content:js});
 await page.getByText(/Universo del período y búsqueda: 24/).waitFor();
 await page.getByText(/Fuente de más de 24 horas/).waitFor();
 await page.getByLabel('Grupo de completitud').selectOption('pending');
 await page.getByText('Página 1 de 2',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Clientes siguientes',exact:true}).click();
 await page.getByText('Página 2 de 2',{exact:true}).waitFor();assert.equal(calls.at(-1).offset,'20');assert.equal(calls.at(-1).cohort,'pending');
 const issue=page.locator('tbody details').first();await issue.locator('summary').click();
 const href=await issue.locator('a').first().getAttribute('href');assert.match(href,/^\/finanzas-contabilidad\?view=facto&document=doc-/);
 for(const width of [1280,390,320]){await page.setViewportSize({width,height:900});await page.screenshot({path:path.join(output,`resolution-${width}.png`),fullPage:true});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),'page overflow at '+width);}
 await page.getByLabel('Grupo de completitud').selectOption('verified');await page.locator('tbody tr').filter({hasText:'Cliente sintético 0'}).waitFor();
 assert.equal(await page.locator('tbody tr').count(),1);
 fail=true;await page.getByLabel('Grupo de completitud').selectOption('all');await page.getByRole('alert').waitFor();
 fail=false;await page.getByRole('button',{name:'Reintentar consulta'}).click();await page.getByText(/Universo del período y búsqueda: 24/).waitFor();assert.equal(await page.getByRole('alert').count(),0);
 await page.getByLabel('Buscar empresa por nombre o RUT').fill('SIN-COINCIDENCIAS');await page.getByText(/Universo del período y búsqueda: 0/).waitFor();
 assert.equal(await page.locator('tbody tr').count(),0);assert.deepEqual(unexpected,[]);assert.deepEqual(errors,[]);
 await fs.writeFile(path.join(output,'results.json'),JSON.stringify({passed:true,productionAccess:false,allNetworkIntercepted:true,methods:['GET'],checks:['cohort pagination','document action links','old source','320/390/1280 layout','recovery','no matches'],calls,unexpected,errors},null,2));
 console.log('PASS isolated profitability UI: cohorts, pagination, resolution links, mobile, recovery, no-data; GET only');
}finally{await browser.close();}
