import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {chromium} from 'playwright';
import fs from 'node:fs/promises';
const output='tmp/direct-message-browser';await fs.mkdir(output,{recursive:true});
const bundle=await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {DirectMessageDialog} from './src/modules/campaigns/DirectMessageDialog';createRoot(document.getElementById('root')).render(<DirectMessageDialog onClose={()=>document.getElementById('root').textContent='Cerrado'}/>);`,loader:'tsx',resolveDir:process.cwd()},bundle:true,write:false,outfile:output+'/fixture.js',format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},plugins:[{name:'auth-fixture',setup(b){b.onLoad({filter:/[/\\]lib[/\\]supabase\.ts$/},()=>({loader:'js',contents:`export const isSupabaseConfigured=true;export const supabase={auth:{getSession:async()=>({data:{session:{access_token:'synthetic-only'}}})},from:()=>{const q={select:()=>q,eq:()=>q,order:()=>q,limit:async()=>({data:[],error:null})};return q}};export const getSupabaseFunctionUrl=(s,r)=>'https://fixture.invalid/'+s+'/'+r;`}));}}]});
const js=bundle.outputFiles.find(f=>f.path.endsWith('.js')).text,css=bundle.outputFiles.filter(f=>f.path.endsWith('.css')).map(f=>f.text).join('\n');
const companyId='00000000-0000-4000-8000-000000000001', contactId='00000000-0000-4000-8000-000000000002';
const recipients=[{companyId,contactId:'',companyName:'Empresa de prueba',name:'Empresa de prueba',email:'empresa@example.com',phone:'56912345678'},{companyId,contactId,companyName:'Empresa de prueba',name:'Contacto especifico',email:'contacto@example.com',phone:'56922222222'}];
const browser=await chromium.launch({headless:true,channel:'chrome'}),context=await browser.newContext({viewport:{width:1280,height:950},serviceWorkers:'block'});
const sent=[],errors=[],unexpected=[];
await context.route('**/*',async route=>{const r=route.request(),u=new URL(r.url());if(u.origin!=='https://fixture.invalid'){unexpected.push(u.href);return route.abort()}
 const json=b=>route.fulfill({contentType:'application/json',body:JSON.stringify(b)});
 if(u.pathname==='/app')return route.fulfill({contentType:'text/html',body:'<html lang="es"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div></html>'});
 if(u.pathname.endsWith('/message-recipients'))return json({recipients});
 if(u.pathname.endsWith('/status'))return json({connected:true,connectedEmail:'crm@example.com',sentToday:0,dailyLimit:20});
 if(u.pathname.endsWith('/send-direct')){const form=await new Response(r.postDataBuffer(),{headers:{'content-type':r.headers()['content-type']}}).formData();const p=JSON.parse(form.get('message'));assert.equal(p.contactId,contactId);assert.equal(p.email,'contacto@example.com');assert.equal(form.getAll('files').length,2);assert.equal(form.getAll('files')[0].name,'cotizacion.pdf');sent.push(p);return json({accepted:true,id:p.requestId,outcome:'accepted',warning:null})}
 if(u.pathname.endsWith('/meta-whatsapp-conversation'))return json({companyId,phone:'56922222222',name:'Contacto especifico',canReply:true,canTemplate:false,reasons:[],templateReasons:['Sin consentimiento'],expiresAt:new Date(Date.now()+3600000).toISOString(),messages:[],nextOffset:null});
 unexpected.push(u.href);return route.abort();
});
const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(10000);
async function mount(){await page.goto('https://fixture.invalid/app');await page.addStyleTag({content:'*{box-sizing:border-box}body{font-family:Arial;background:#f5f7f8}button{padding:10px;border:1px solid #ccdadd;border-radius:6px;background:white;color:#143a44;cursor:pointer}button:disabled{opacity:.5}button.primary-button{background:#087b80;color:white}'+css});await page.addScriptTag({content:js});await page.getByRole('option',{name:/Contacto especifico/}).waitFor({state:'attached'});}
try{
 await mount();await page.getByLabel('Buscar cliente o contacto').fill('especifico');assert.equal(await page.getByRole('option').count(),2);await page.getByLabel('Destinatario',{exact:true}).selectOption(`${companyId}:${contactId}`);await page.getByRole('button',{name:'Correo',exact:true}).click();await page.getByText(/Desde crm@example.com/).waitFor();
 await page.getByLabel('Asunto',{exact:true}).fill('Cotizacion de prueba');await page.getByLabel('Mensaje',{exact:true}).fill('Adjunto los documentos solicitados.');
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1UAAAAASUVORK5CYII=','base64');
 await page.getByLabel('Archivos adjuntos',{exact:true}).setInputFiles([{name:'cotizacion.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.7 test')},{name:'producto.png',mimeType:'image/png',buffer:png}]);
 assert.equal(sent.length,0);await page.getByRole('img',{name:'producto.png'}).waitFor();
 for(const width of [1280,390,320]){await page.setViewportSize({width,height:850});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));const box=await page.getByRole('dialog').boundingBox();assert.ok(box.x>=0&&box.y>=0&&box.width<=width);await page.screenshot({path:`${output}/direct-${width}.png`});}
 await page.getByRole('button',{name:'Revisar envio',exact:true}).click();assert.equal(sent.length,0);await page.getByText('Confirmar correo a contacto@example.com',{exact:true}).waitFor();await page.getByRole('button',{name:'Confirmar y enviar',exact:true}).click();await page.getByText('Correo aceptado por Gmail.',{exact:true}).waitFor();assert.equal(sent.length,1);assert.equal(await page.getByLabel('Asunto',{exact:true}).inputValue(),'');
 await mount();await page.getByLabel('Destinatario',{exact:true}).selectOption(`${companyId}:${contactId}`);await page.getByRole('button',{name:'Abrir conversacion',exact:true}).click();await page.getByRole('heading',{name:'Contacto especifico',exact:true}).waitFor();await page.getByLabel('Archivos adjuntos',{exact:true}).setInputFiles({name:'cotizacion.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.7 test')});assert.equal(sent.length,1);await page.getByRole('button',{name:'Quitar cotizacion.pdf',exact:true}).waitFor();await page.screenshot({path:`${output}/whatsapp-320.png`});
 assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);console.log('PASS direct messaging UI: company/contact search, email review+attachments, WhatsApp contact+attachment, desktop/mobile; mocked sends only');
}finally{await browser.close()}
