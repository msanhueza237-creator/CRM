import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {chromium} from 'playwright';
import fs from 'node:fs/promises';
const output='tmp/whatsapp-management-browser';await fs.mkdir(output,{recursive:true});
const bundle=await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {MemoryRouter} from 'react-router-dom';import {WhatsAppPage} from './src/modules/messages/WhatsAppPage';import './src/styles.css';createRoot(document.getElementById('root')).render(<MemoryRouter initialEntries={['/mensajes?tab=templates']}><WhatsAppPage/></MemoryRouter>);`,loader:'tsx',resolveDir:process.cwd()},bundle:true,write:false,outfile:output+'/fixture.js',format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},plugins:[{name:'auth-fixture',setup(b){
  b.onLoad({filter:/[/\\]lib[/\\]supabase\.ts$/},()=>({loader:'js',contents:`export const isSupabaseConfigured=true;export const supabase={auth:{getSession:async()=>({data:{session:{access_token:'synthetic-only'}}})}};export const getSupabaseFunctionUrl=(s,r)=>'https://fixture.invalid/'+s+'/'+r;`}));
  b.onLoad({filter:/[/\\]auth[/\\]AuthContext\.tsx$/},()=>({loader:'js',contents:`export const useAuth=()=>({user:{id:'fixture-admin',name:'Administrador',role:window.fixtureRole||'administrador'},isDemoMode:false,signOut:()=>{}});`}));
}}]});
const js=bundle.outputFiles.find(f=>f.path.endsWith('.js')).text,css=bundle.outputFiles.filter(f=>f.path.endsWith('.css')).map(f=>f.text).join('\n');
const migration=await fs.readFile('supabase/migrations/20261007012541_whatsapp_template_management.sql','utf8');
const policy=JSON.parse(migration.match(/management_policy jsonb not null default '(.*?)'::jsonb/s)[1]);
const draft={internalName:'Cobranza de factura',name:'cobranza_factura_pendiente',language:'es_CL',category:'UTILITY',header:'',body:'Hola {{1}}, tu factura {{2}} está pendiente de pago. Responde si necesitas información.',footer:'Clima Activa',description:'Factura real, sin promoción',bindings:[{key:'1',field:'nombre_cliente',example:'Cliente de ejemplo'},{key:'2',field:'numero_factura',example:'12345'}],buttons:[],purposeConfirmed:false};
const rows=[{id:'draft-1',internal_name:draft.internalName,meta_template_name:draft.name,language:'es_CL',category:'UTILITY',preview_body:draft.body,description:draft.description,components:[],variable_bindings:draft.bindings,draft,local_state:'DRAFT',status:'DRAFT',meta_template_id:null,rejected_reason:null,last_synced_at:null,created_at:'2026-10-07T01:00:00Z',updated_at:'2026-10-07T01:00:00Z',revision:1,active:true}];
const browser=await chromium.launch({headless:true,channel:'chrome'});const context=await browser.newContext({viewport:{width:1280,height:900},serviceWorkers:'block'});
const errors=[],unexpected=[],operations=[];
await context.route('**/*',async route=>{const r=route.request(),u=new URL(r.url());if(u.origin!=='https://fixture.invalid'){unexpected.push(u.href);return route.abort()}
 const json=body=>route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
 if(u.pathname==='/app')return route.fulfill({contentType:'text/html',body:'<html lang="es"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root" style="padding:16px;max-width:1200px;margin:auto"></div></html>'});
 if(u.pathname.endsWith('/whatsapp-template-management')){
   if(r.method()==='POST'){const p=JSON.parse(r.postData());operations.push(p.operation);assert.notEqual(p.operation,'submit','No approval during browser test');if(p.operation==='save'){rows[0]={...rows[0],draft:p.draft,revision:rows[0].revision+1}}return json({ok:true})}
   return json({templates:rows,policy,variableFields:['manual','nombre_cliente','numero_factura'],configuration:{wabaId:'456',phoneNumberId:'123',graphVersion:'v26.0',blockers:[],webhookFields:['messages','message_template_status_update','message_template_quality_update','template_category_update','message_template_components_update']}});
 }
 unexpected.push(`${r.method()} ${u.href}`);return route.abort();
});
async function mount(role='administrador'){const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto('https://fixture.invalid/app');await page.evaluate(role=>window.fixtureRole=role,role);await page.addStyleTag({content:css});await page.addScriptTag({content:js});await page.getByText('Cobranza de factura',{exact:true}).waitFor();return page}
try {
 const page=await mount();assert.equal(operations.length,0);
 for(const width of [1280,390,320]){await page.setViewportSize({width,height:850});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:`${output}/templates-${width}.png`});}
 await page.getByRole('button',{name:'Editar Cobranza de factura',exact:true}).click();await page.getByRole('dialog').waitFor();assert.equal(await page.getByRole('dialog').locator('label').filter({hasText:/^Cuerpo/}).locator('textarea').inputValue(),draft.body);await page.screenshot({path:`${output}/editor-320.png`});assert.ok(await page.getByRole('dialog').evaluate(el=>el.scrollWidth<=el.clientWidth+1));
 await page.getByLabel('Confirmo la finalidad de esta categoría.',{exact:false}).check();await page.getByRole('button',{name:'Guardar borrador',exact:true}).click();await page.getByRole('dialog').waitFor({state:'detached'});assert.deepEqual(operations,['save']);
 await page.getByRole('button',{name:'Revisar aprobación de Cobranza de factura',exact:true}).click();const submit=page.getByRole('button',{name:'Enviar a Meta para aprobación',exact:true});assert.equal(await submit.isDisabled(),true);await page.getByLabel('Revisé el texto y sus ejemplos ficticios.',{exact:false}).check();assert.equal(await submit.isEnabled(),true);await page.screenshot({path:`${output}/approval-320.png`});await page.getByRole('button',{name:'Cancelar',exact:true}).click();assert.deepEqual(operations,['save']);
 await page.getByRole('button',{name:'Configuración',exact:true}).click();await page.getByText('456',{exact:true}).waitFor();assert.equal(await page.getByText('message_template_components_update',{exact:true}).count(),1);
 const seller=await mount('vendedor');assert.equal(await seller.getByRole('button',{name:'Nueva plantilla',exact:true}).count(),0);assert.equal(await seller.getByRole('button',{name:'Configuración',exact:true}).count(),0);assert.equal(await seller.getByRole('button',{name:'Editar Cobranza de factura',exact:true}).count(),0);
 assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);console.log('PASS templates UI desktop/mobile, editor, explicit approval preview, configuration and seller restrictions; no submissions or messages');
} finally {await browser.close()}
