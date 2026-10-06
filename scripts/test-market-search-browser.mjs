import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {build} from 'esbuild';
import {chromium} from 'playwright';
const output=path.resolve('tmp/market-search-browser');await fs.mkdir(output,{recursive:true});
const source=`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {MemoryRouter} from 'react-router-dom';import {MarketInvestigator} from './src/modules/market-study/MarketInvestigator';import {MarketStudyPage} from './src/modules/market-study/MarketStudyPage';import './src/modules/market-study/market-study.css';const now=new Date().toISOString();const current={key:'current:HT816',sku:'HT816',name:'Termostato HT-816',mode:'current',stock:10,stockAt:now,eta:null,price:20000,priceCurrency:'CLP',priceAt:now,cost:12000,costCurrency:'CLP',costAt:now,costStatus:'recorded',costSource:'Facto',path:'/inventario',notices:[]};const products=[current,{...current,key:'transit:operation:line',mode:'transit',cost:9000,costStatus:'estimated',costSource:'Importacion de prueba',eta:'2026-12-31'}];function Demo(){const [key,setKey]=useState(current.key);return <MarketInvestigator products={products} selectedKey={key} onSelect={setKey} reload={()=>{}} savedJobIds={[]}/>};createRoot(document.getElementById('root')).render(<MemoryRouter initialEntries={['/estudio-mercado?tab=research&product=current:HT816']}><main className="market-page" style={{maxWidth:1200,margin:'auto',padding:16}}><h1>Estudio de Mercado</h1>{window.pageTest?<MarketStudyPage/>:<Demo/>}</main></MemoryRouter>);`;
const bundle=await build({stdin:{contents:source,loader:'tsx',resolveDir:process.cwd()},bundle:true,write:false,outfile:output+'/fixture.js',format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},plugins:[{name:'auth-fixture',setup(b){b.onLoad({filter:/[/\\]lib[/\\]supabase\.ts$/},()=>({loader:'js',contents:`export const supabase={auth:{getSession:async()=>({data:{session:{access_token:'synthetic-only'}}})}};export const getSupabaseFunctionUrl=(s,r)=>'https://fixture.invalid/'+s+'/'+r;`}));}}]});
const js=bundle.outputFiles.find(f=>f.path.endsWith('.js')).text,css=bundle.outputFiles.filter(f=>f.path.endsWith('.css')).map(f=>f.text).join('\n');
const choice='deepseek:deepseek-flash',now=new Date().toISOString();
const settings={enabled:true,web_search_supported:true,daily_usd:.25,daily_jobs:10,spent_usd:0,jobs_today:0,selection:{choice,revision:1},choices:[{choice,provider:'deepseek',model:'deepseek-flash'}],jobs:[]};
const offer=(seller,amount,extra={})=>({url:`https://${seller}/ht816`,seller,title:'Termostato HT-816',amount,currency:'CLP',vat:'gross',vat_percent:19,package_quantity:1,availability:'available',identity:'model_match',observed_at:now,evidence:'Precio por unidad con IVA 19%',warning:'Equivalencia tecnica pendiente',...extra});
const offers=[offer('nuevo-oferente.cl',23800),offer('precio-menor.cl',17850),offer('sin-datos.cl',null,{currency:null,vat:'unknown',package_quantity:null,identity:'possible'}),offer('internacional.com',9,{currency:'USD'})];
const calls=[],errors=[],unexpected=[];
const browser=await chromium.launch({headless:true,channel:'chrome'}),context=await browser.newContext({viewport:{width:1280,height:1000},serviceWorkers:'block'});
await context.route('**/*',async route=>{
 const req=route.request(),u=new URL(req.url());if(u.origin!=='https://fixture.invalid'){unexpected.push(u.href);return route.abort();}
 if(u.pathname==='/app')return route.fulfill({contentType:'text/html',body:'<html lang="es"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div></html>'});
 calls.push({route:u.pathname,method:req.method()});let response;
 if(u.pathname.endsWith('/native-settings'))response=settings;
 else if(u.pathname.endsWith('/search')){const p=req.postDataJSON();assert.deepEqual(Object.keys(p).sort(),['id','revision','sku','title']);assert.equal(p.sku,'HT816');assert.equal(p.title,'Termostato HT-816');const j={id:p.id,sku:p.sku,source_url:'https://www.google.com/search?q=HT816',state:'completed',selection:{choice,model:'deepseek-flash'},reserved_usd:.25,estimated_usd:null,created_at:now,result:{kind:'market_search',offers,queries:['HT816 precio Chile'],coverage:'Web indexada, no censo exhaustivo.'}};settings.jobs=[j];settings.spent_usd=.25;settings.jobs_today=1;response=j;}
 else if(u.pathname.endsWith('/bootstrap'))response={observations:[],reviews:[],inventory:[{sku:'OTHER',name:'Otro producto'},{sku:'HT816',name:'Termostato HT-816',net_price:20000,price_currency:'CLP'}],inventoryAvailable:true,imports:[],importsComplete:true,inventoryWarnings:[],warnings:[],readAt:now};
 else{unexpected.push(u.pathname);return route.abort();}
 return route.fulfill({contentType:'application/json',body:JSON.stringify(response)});
});
const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
async function mount(pageTest=false){await page.goto('https://fixture.invalid/app');if(pageTest)await page.evaluate(()=>window.pageTest=true);await page.addStyleTag({content:'*{box-sizing:border-box}body{margin:0;background:#f7f9fa;font-family:Arial,sans-serif}'+css});await page.addScriptTag({content:js});await page.getByRole('heading',{name:'Nueva investigacion'}).waitFor();}
try{
 await mount();await page.getByRole('button',{name:'Buscar en el mercado',exact:true}).click();await page.getByRole('link',{name:'nuevo-oferente.cl'}).waitFor();
 assert.equal(calls.filter(c=>c.route.endsWith('/search')).length,1);assert.equal(await page.getByRole('button',{name:'Buscar en el mercado',exact:true}).isDisabled(),true);
 const summary=await page.locator('.market-price-summary').innerText();assert.match(summary,/20\.000/);assert.match(summary,/12\.000/);assert.match(summary,/9\.000/);assert.match(summary,/55%/);
 const table=page.getByRole('region',{name:'Comparativa de precios'}).getByRole('table');
 assert.match(await table.getByRole('row').nth(2).innerText(),/precio-menor/);assert.match(await table.getByRole('row').nth(3).innerText(),/nuevo-oferente/);
 await page.getByLabel('Ordenar ofertas',{exact:true}).selectOption('highest');assert.match(await table.getByRole('row').nth(2).innerText(),/nuevo-oferente/);
 await page.getByLabel('Oferente o producto').fill('internacional');assert.equal(await table.getByRole('row').count(),3);assert.match(await table.getByRole('row').last().innerText(),/Base no comparable/);
 await page.getByLabel('Oferente o producto').fill('');await page.getByLabel('Solo con precio publicado').check();assert.equal(await table.getByRole('row').count(),5);await page.getByLabel('Solo con precio publicado').uncheck();
 for(const width of [1280,390,320]){await page.setViewportSize({width,height:950});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:path.join(output,`comparison-${width}.png`),fullPage:true});}
 await page.getByLabel('Margen con costo',{exact:true}).selectOption('transit');assert.match(await table.getByRole('row').filter({hasText:'precio-menor.cl'}).innerText(),/40%/);
 await table.getByRole('row').filter({hasText:'nuevo-oferente.cl'}).getByRole('button',{name:'Revisar oferta de nuevo-oferente.cl',exact:true}).click();await page.getByRole('heading',{name:'Revision de la fuente · HT816'}).waitFor();assert.equal(await page.getByLabel('Precio observado').inputValue(),'23800');assert.equal(await page.getByRole('button',{name:'Guardar para comparar'}).isDisabled(),true);
 assert.equal(calls.some(c=>c.route.includes('/imports/commit')||c.route.endsWith('/reviews')),false);
 await mount(true);assert.equal(await page.getByRole('combobox',{name:'Producto',exact:true}).inputValue(),'current:HT816');
 assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);await fs.writeFile(path.join(output,'results.json'),JSON.stringify({passed:true,network:'mocked',checks:['automatic search without URL','unknown competitor domain','current and incoming costs','sorting and filtering','currency isolation','no automatic price changes or equivalence approval','320/390/1280 layout','URL product selection preserved']},null,2));
 console.log('PASS automatic market search and comparative table, desktop/mobile');
}finally{await browser.close();}
