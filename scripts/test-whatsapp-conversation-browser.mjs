import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {chromium} from 'playwright';
import fs from 'node:fs/promises';
const output='tmp/whatsapp-conversation-browser';await fs.mkdir(output,{recursive:true});
const bundle=await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {WhatsAppConversationDialog} from './src/modules/campaigns/WhatsAppConversationDialog';createRoot(document.getElementById('root')).render(<WhatsAppConversationDialog companyId="00000000-0000-4000-8000-000000000001" phone="56912345678" onClose={()=>document.getElementById('root').textContent='Cerrado'}/>);`,loader:'tsx',resolveDir:process.cwd()},bundle:true,write:false,outfile:output+'/fixture.js',format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},plugins:[{name:'auth-fixture',setup(b){b.onLoad({filter:/[/\\]lib[/\\]supabase\.ts$/},()=>({loader:'js',contents:`export const isSupabaseConfigured=true;export const supabase={auth:{getSession:async()=>({data:{session:{access_token:'synthetic-only'}}})}};export const getSupabaseFunctionUrl=(s,r)=>'https://fixture.invalid/'+s+'/'+r;`}));}}]});
const js=bundle.outputFiles.find(f=>f.path.endsWith('.js')).text,css=bundle.outputFiles.filter(f=>f.path.endsWith('.css')).map(f=>f.text).join('\n');
const now=new Date().toISOString(), data={companyId:'00000000-0000-4000-8000-000000000001',name:'Climactiva prueba',phone:'56912345678',canReply:true,reasons:[],expiresAt:new Date(Date.now()+3600000).toISOString(),nextOffset:null,messages:[
 {id:'1',direction:'outbound',body:'Plantilla: super_stars_catalogo',status:'read',occurredAt:now,type:'template'},
 {id:'2',direction:'inbound',body:'Hola Muchas Gracias',status:'received',occurredAt:now,type:'text'},
 {id:'3',direction:'inbound',body:'Pedido del catalogo\nProducto SKU1: 1 unidad(es) x 34.500 CLP = 34.500 CLP\nPedido recibido; no confirma venta ni pago.',status:'received',occurredAt:now,type:'order'}]};
const browser=await chromium.launch({headless:true,channel:'chrome'}),context=await browser.newContext({viewport:{width:1280,height:950},serviceWorkers:'block'});
const sent=[],errors=[],unexpected=[];let failing=false;
await context.route('**/*',async route=>{const r=route.request(),u=new URL(r.url());if(u.origin!=='https://fixture.invalid'){unexpected.push(u.href);return route.abort()}
 if(u.pathname==='/app')return route.fulfill({contentType:'text/html',body:'<html lang="es"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div></html>'});
 if(u.pathname.endsWith('/meta-whatsapp-conversation')){if(failing)return route.fulfill({status:503,body:JSON.stringify({error:'Sin conexion al historial'})});return route.fulfill({contentType:'application/json',body:JSON.stringify(data)})}
 if(u.pathname.endsWith('/meta-whatsapp-reply')){const p=r.postDataJSON();sent.push(p);assert.equal(p.confirmSend,true);assert.equal(p.phone,data.phone);assert.ok(p.requestId);data.messages.push({id:'4',direction:'outbound',body:p.text,status:'sent',occurredAt:now,type:'text'});return route.fulfill({contentType:'application/json',body:JSON.stringify({accepted:true,id:'4',outcome:'accepted',warning:null})})}
 unexpected.push(u.href);return route.abort();
});
const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(10000);
try{
 await page.goto('https://fixture.invalid/app');await page.addStyleTag({content:'*{box-sizing:border-box}body{font-family:Arial;background:#f5f7f8}button{padding:10px;border:1px solid #ccdadd;border-radius:6px;background:white;color:#143a44;cursor:pointer}button:disabled{opacity:.5}button.primary-button{background:#087b80;color:white}'+css});await page.addScriptTag({content:js});
 await page.getByText('Hola Muchas Gracias',{exact:true}).waitFor();assert.match(await page.getByRole('log').innerText(),/34.500 CLP/);assert.equal(sent.length,0);
 for(const width of [1280,390,320]){await page.setViewportSize({width,height:850});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));const box=await page.getByRole('dialog').boundingBox();assert.ok(box.x>=0&&box.y>=0&&box.width<=width);await page.screenshot({path:`${output}/conversation-${width}.png`});}
 await page.getByLabel('Respuesta',{exact:true}).fill('Gracias, revisamos tu pedido.');await page.getByLabel('Respuesta',{exact:true}).press('Enter');assert.equal(sent.length,0);
 await page.getByRole('button',{name:'Enviar respuesta',exact:true}).click();await page.getByText('Mensaje aceptado por Meta.',{exact:true}).waitFor();assert.equal(sent.length,1);assert.equal(await page.getByLabel('Respuesta',{exact:true}).inputValue(),'');
 data.canReply=false;data.reasons=['Ventana de 24 horas cerrada.'];data.expiresAt=new Date(Date.now()-1).toISOString();await page.getByRole('button',{name:'Actualizar conversacion',exact:true}).click();await page.getByText(data.reasons[0],{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Enviar respuesta',exact:true}).isDisabled(),true);
 failing=true;await page.getByRole('button',{name:'Actualizar conversacion',exact:true}).click();await page.getByText('Sin conexion al historial',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Enviar respuesta',exact:true}).isDisabled(),true);
 await page.getByRole('button',{name:'Cerrar conversacion',exact:true}).click();await page.getByText('Cerrado',{exact:true}).waitFor();assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);
 console.log('PASS conversation UI: history/order, manual send, expired window, read failure, 320/390/1280 layouts; no real messages');
}finally{await browser.close()}
