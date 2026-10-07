import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {chromium} from 'playwright';
import fs from 'node:fs/promises';
const output='tmp/whatsapp-inbox-browser';await fs.mkdir(output,{recursive:true});
const bundle=await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {MemoryRouter,Routes,Route} from 'react-router-dom';import {MessagesPage} from './src/modules/messages/MessagesPage';import {AppLayout} from './src/modules/layout/AppLayout';import './src/styles.css';createRoot(document.getElementById('root')).render(<MemoryRouter initialEntries={['/mensajes']}><Routes><Route element={<AppLayout/>}><Route path='/mensajes' element={<MessagesPage/>}/></Route></Routes></MemoryRouter>);`,loader:'tsx',resolveDir:process.cwd()},bundle:true,write:false,outfile:output+'/fixture.js',format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},plugins:[{name:'auth-fixture',setup(b){
  b.onLoad({filter:/[/\\]lib[/\\]supabase\.ts$/},()=>({loader:'js',contents:`export const isSupabaseConfigured=true;export const supabase={auth:{getSession:async()=>({data:{session:{access_token:'synthetic-only'}}})}};export const getSupabaseFunctionUrl=(s,r)=>'https://fixture.invalid/'+s+'/'+r;`}));
  b.onLoad({filter:/[/\\]auth[/\\]AuthContext\.tsx$/},()=>({loader:'js',contents:`export const useAuth=()=>({user:{id:'fixture-admin',name:'Administrador',role:'administrador'},isDemoMode:false,signOut:()=>{}});`}));
}}]});
const js=bundle.outputFiles.find(f=>f.path.endsWith('.js')).text,css=bundle.outputFiles.filter(f=>f.path.endsWith('.css')).map(f=>f.text).join('\n');
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const rows=Array.from({length:32},(_,i)=>({companyId:i===2?null:id(i+1),phone:`5691234${String(i).padStart(4,'0')}`,companyName:i===0?'Contacto WhatsApp (56912340000)':`Empresa ${i}`,name:i===0?'Contacto nuevo de WhatsApp':`Cliente ${i}`,isNew:i===0,unreadCount:i<2?1:0,latestInboundId:id(i+100),preview:i===0?'Hola, necesito una cotizacion para mi local.':'Consulta por disponibilidad y despacho',direction:'inbound',status:'received',lastAt:new Date(Date.now()-i*3600000).toISOString()}));
const browser=await chromium.launch({headless:true,channel:'chrome'}),context=await browser.newContext({viewport:{width:1280,height:950},serviceWorkers:'block'});
const errors=[],unexpected=[],receipts=[];let fail=false;
await context.route('**/*',async route=>{const r=route.request(),u=new URL(r.url());if(u.origin!=='https://fixture.invalid'){unexpected.push(u.href);return route.abort()}
 const json=b=>route.fulfill({contentType:'application/json',body:JSON.stringify(b)});
 if(u.pathname==='/app')return route.fulfill({contentType:'text/html',body:'<html lang="es"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div></html>'});
 if(u.pathname.endsWith('/whatsapp-inbox')){
   if(fail)return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'No se pudo cargar la bandeja de mensajes.'})});
   const q=u.searchParams,s=q.get('search').toLowerCase(),f=q.get('filter'),offset=Number(q.get('offset')),limit=Number(q.get('limit'));
   const filtered=rows.filter(v=>(f!=='unread'||v.unreadCount)&&(f!=='new'||v.isNew)&&`${v.name} ${v.phone} ${v.companyName}`.toLowerCase().includes(s));
   return json({summary:{conversations:rows.length,unreadMessages:rows.filter(v=>v.unreadCount).length,unreadConversations:rows.filter(v=>v.unreadCount).length,newContacts:1},conversations:filtered.slice(offset,offset+limit),total:filtered.length,offset,limit});
 }
 if(u.pathname.endsWith('/meta-whatsapp-conversation')){const row=rows.find(v=>v.phone===u.searchParams.get('phone'));return json({companyId:row.companyId||'',phone:row.phone,name:row.name,canReply:false,canTemplate:false,reasons:['Ventana de 24 horas cerrada.'],templateReasons:['Sin consentimiento'],expiresAt:null,nextOffset:null,messages:[{id:row.latestInboundId,direction:'inbound',body:row.preview,status:'received',occurredAt:row.lastAt,type:'text'}]})}
 if(u.pathname.endsWith('/whatsapp-read')){const p=JSON.parse(r.postData());receipts.push(p);const row=rows.find(v=>v.phone===p.phone);assert.deepEqual(p.messageIds,[row.latestInboundId]);assert.equal(p.companyId,row.companyId);row.unreadCount=p.read?0:1;return json({updated:1})}
 if(u.pathname.endsWith('/message-recipients'))return json({recipients:[]});
 unexpected.push(`${r.method()} ${u.href}`);return route.abort();
});
const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(10000);
try {
 await page.goto('https://fixture.invalid/app');await page.addStyleTag({content:css});await page.addScriptTag({content:js});
 await page.getByRole('button',{name:'Abrir conversacion con Contacto nuevo de WhatsApp',exact:true}).waitFor();assert.equal(await page.locator('.messages-row').count(),30);assert.equal(receipts.length,0);
 for(const width of [1280,390,320]){await page.setViewportSize({width,height:850});await page.screenshot({path:`${output}/inbox-${width}.png`});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));const rowsBox=await page.locator('.messages-row').first().boundingBox();assert.ok(rowsBox.width<=width);}
 await page.getByRole('button',{name:'Pagina siguiente',exact:true}).click();await page.getByRole('button',{name:'Abrir conversacion con Cliente 31',exact:true}).waitFor();assert.equal(await page.locator('.messages-row').count(),2);
 await page.getByRole('button',{name:/No leidas/}).click();await page.getByRole('button',{name:'Abrir conversacion con Contacto nuevo de WhatsApp',exact:true}).waitFor();assert.equal(await page.locator('.messages-row').count(),2);
 await page.getByRole('button',{name:'Abrir conversacion con Contacto nuevo de WhatsApp',exact:true}).click();await page.getByRole('dialog').waitFor();await page.waitForFunction(()=>document.querySelector('.messages-nav-badge')?.textContent==='1');assert.equal(receipts.length,1);assert.equal(await page.getByRole('button',{name:'Enviar respuesta',exact:true}).isDisabled(),true);await page.screenshot({path:`${output}/dialog-320.png`});
 await page.getByRole('button',{name:'Cerrar conversacion',exact:true}).click();await page.getByRole('button',{name:/Contactos nuevos/}).click();await page.getByRole('button',{name:'Marcar como no leido: Contacto nuevo de WhatsApp',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.messages-nav-badge')?.textContent==='2');assert.equal(receipts.at(-1).read,false);
 await page.getByRole('button',{name:/Todas/}).click();await page.getByLabel('Buscar conversacion').fill('Cliente 31');await page.getByRole('button',{name:'Abrir conversacion con Cliente 31',exact:true}).waitFor();assert.equal(await page.locator('.messages-row').count(),1);
 await page.getByLabel('Buscar conversacion').fill('Sin coincidencia');await page.getByText('No hay conversaciones que coincidan.',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Nuevo mensaje',exact:true}).click();await page.getByRole('dialog').waitFor();assert.ok(await page.getByRole('button',{name:'Correo',exact:true}).isVisible());await page.keyboard.press('Escape');
 fail=true;await page.getByRole('button',{name:'Actualizar mensajes',exact:true}).click();await page.getByRole('alert').waitFor();assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);
 console.log('PASS inbox UI: desktop/mobile, badge, paging, filters, search, per-message reads, mark unread, compose and error; zero sends');
} finally {await browser.close()}
