import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
const output=path.resolve('outputs/market-extraction/browser');await fs.mkdir(output,{recursive:true});
const bundle=await build({stdin:{resolveDir:process.cwd(),loader:'tsx',contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {MarketExtractionSettings} from './src/modules/market-study/MarketExtractionSettings';import './src/modules/market-study/market-study.css';createRoot(document.getElementById('root')).render(<div className="market-page"><MarketExtractionSettings/></div>);`},bundle:true,write:false,outfile:output+'/test.js',format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},plugins:[{name:'synthetic-only-api',setup(b){b.onLoad({filter:/marketStudyApi\.ts$/},()=>({loader:'js',contents:`const req=async body=>{const r=await fetch('https://fixture.invalid/settings',{method:body?'POST':'GET',body:body?JSON.stringify(body):undefined});const result=await r.json();if(!r.ok)throw Error(result.error);return result};export const getMarketExtractionSettings=()=>req();export const saveMarketExtractionSettings=body=>req(body);`}));}}]});
const script=bundle.outputFiles.find(f=>f.path.endsWith('.js')).text,css=bundle.outputFiles.filter(f=>f.path.endsWith('.css')).map(f=>f.text).join('\n');
const choices=['deepseek:deepseek-flash','deepseek:deepseek-v4-pro','openai:synthetic-model'].map(choice=>({choice,provider:choice.split(':')[0],model:choice.split(':')[1],input_usd_per_million:0.3,output_usd_per_million:1.2,rate_checked_at:'2026-10-03'}));
let policy={enabled:false,revision:1,choice:choices[0].choice,daily_usd:1,pilot_usd:5,daily_jobs:50,public_hosts:[]},conflict=false;const writes=[],unexpected=[],errors=[];
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 const context=await browser.newContext({serviceWorkers:'block',viewport:{width:1280,height:800}});
 await context.route('**/*',async route=>{const req=route.request();if(req.url()==='https://fixture.invalid/app')return route.fulfill({contentType:'text/html',body:'<html lang="es"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div></html>'});
  if(req.url()!=='https://fixture.invalid/settings'){unexpected.push(req.url());return route.abort();}
  if(req.method()==='POST'){const v=req.postDataJSON();writes.push(v);assert.deepEqual(Object.keys(v).sort(),['choice','revision']);if(conflict)return route.fulfill({status:409,contentType:'application/json',body:'{"error":"La selección cambió; actualiza."}'});assert.equal(v.revision,policy.revision);policy={...policy,revision:policy.revision+1,choice:v.choice};}
  return route.fulfill({contentType:'application/json',body:JSON.stringify({policy,choices})});
 });
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto('https://fixture.invalid/app');await page.addStyleTag({content:css});await page.addScriptTag({content:script});
 await page.getByText('Proveedor de extracción del investigador',{exact:true}).click();await page.getByText('Piloto desactivado',{exact:true}).waitFor();
 const select=page.getByLabel('Proveedor y modelo de extracción');assert.equal(await select.inputValue(),'deepseek:deepseek-flash');await select.selectOption('openai:synthetic-model');await page.getByRole('button',{name:'Guardar selección para lotes nuevos'}).click();await page.getByText('Selección guardada. Los lotes existentes conservan su modelo.').waitFor();assert.equal(policy.enabled,false);
 for(const width of [1280,390,320]){await page.setViewportSize({width,height:900});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:path.join(output,`selector-${width}.png`),fullPage:true});}
 conflict=true;await select.selectOption('deepseek:deepseek-v4-pro');await page.getByRole('button',{name:'Guardar selección para lotes nuevos'}).click();await page.getByRole('alert').waitFor();assert.equal(policy.choice,'openai:synthetic-model');assert.deepEqual(unexpected,[]);assert.deepEqual(errors,[]);
 await fs.writeFile(path.join(output,'results.json'),JSON.stringify({passed:true,syntheticOnly:true,viewports:[1280,390,320],checks:['DeepSeek initial','manual provider/model change','selection-only payload','disabled pilot remains disabled','revision conflict visible','no horizontal overflow'],writes},null,2));console.log('PASS extraction selector desktop/mobile and manual revision conflict; no real network');
}finally{await browser.close();}
