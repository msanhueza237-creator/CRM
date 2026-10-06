import { researchAdmin } from './research-admin.ts';
import { nativeSettings, nativeStudy } from './native-study.ts';
import { marketSearch,refreshMarketSources } from './market-search.ts';
import type { NativeStudyJob } from '../_shared/market-native-contract.ts';
import { extractionChoices, extractionPolicy, ExtractionError, type ExtractionEnv } from '../market-research/extraction.ts';
import { assertMarketAccess, normalizeMarketReview, previewMarketImport } from "../_shared/market-study-contract.ts";
import { CopilotSources } from "../crm-copilot/sources.ts";
import { inventoryValuation } from "../crm-copilot/inventory-valuation.ts";
import { factoCurrencies } from "../crm-copilot/product-prices.ts";
import { inventoryCatalogFields, resolveProducts } from "../crm-copilot/product-resolution.ts";
import { publicProductDescription } from '../_shared/market-product-search.ts';
import { object, CopilotDataError, type RestConfig } from "../crm-copilot/contracts.ts";
export interface MarketEnvironment { rest: RestConfig; origin: string; currencyMap?: string; readEnv?: ExtractionEnv }
class HttpError extends Error { constructor(public status: number,message: string) {super(message);} }
async function readBody(req: Request) {
  const reader=req.body?.getReader();if(!reader)throw new HttpError(400,"Falta JSON.");
  const chunks:Uint8Array[]= [];let size=0;
  while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>350000){await reader.cancel();throw new HttpError(413,"Lote demasiado grande (máximo 350 KB).");}chunks.push(part.value);}
  const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
  try{return JSON.parse(new TextDecoder().decode(bytes));}catch{throw new HttpError(400,"JSON inválido.");}
}
export function createMarketHandler(env: MarketEnvironment,fetcher: typeof fetch = fetch) {
 return async(req:Request):Promise<Response>=>{
  const headers={"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","Access-Control-Allow-Origin":env.origin,"Vary":"Origin","Access-Control-Allow-Headers":"authorization,apikey,content-type","Access-Control-Allow-Methods":"GET,POST,OPTIONS"};
  const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers});
  if(req.method==='OPTIONS')return new Response(null,{status:204,headers});
  try{
   const route=new URL(req.url).pathname.split('/market-study/')[1]||'';
   const token=(req.headers.get('authorization')||'').replace(/^Bearer\s+/i,'').trim();
   if(!token)throw new HttpError(401,'Inicia sesión para consultar Estudios de Mercado.');
   const userResponse=await fetcher(`${env.rest.url}/auth/v1/user`,{headers:{apikey:env.rest.anonKey,Authorization:`Bearer ${token}`},signal:req.signal});
   if(!userResponse.ok)throw new HttpError(401,'Sesión inválida.');
   const user=object(await userResponse.json());if(typeof user.id!=='string'||! /^[0-9a-f-]{36}$/i.test(user.id))throw new HttpError(401,'Identidad no válida.');
   const source=new CopilotSources(env.rest,{id:user.id,role:'administrador',accessToken:token},req.signal,fetcher);
   const profiles=await source.select(`profiles?select=id,role,active&id=eq.${user.id}&limit=1`);
   try{assertMarketAccess(profiles[0]?{role:String(profiles[0].role),active:profiles[0].active===true}:null);}catch(e){throw new HttpError(403,(e as Error).message);}
   if(route==='native-settings'||route==='studies'||route==='search'||route==='sources/refresh') {
    const ctx={url:env.rest.url,serviceRoleKey:env.rest.serviceRoleKey,readEnv:env.readEnv||(()=>undefined),fetcher};
    // Settlement must survive a mobile browser disconnecting after a paid call.
    const durable=new CopilotSources(env.rest,{id:user.id,role:'administrador',accessToken:token},AbortSignal.timeout(route==='search'?120000:90000),fetcher);
    const rpc=(name:string,args:Record<string,unknown>)=>durable.rpc(name,args,false);
    if(route==='native-settings'&&req.method==='GET')return json(await nativeSettings(ctx,rpc,user.id));
    if(route==='sources/refresh'&&req.method==='POST'){
     const body=object(await readBody(req));if(Object.keys(body).join(',')!=='id'||typeof body.id!=='string'||!/^[0-9a-f-]{36}$/i.test(body.id))throw new HttpError(422,'Selecciona una consulta guardada.');
     const status=object(await rpc('market_native_run',{p_actor:user.id,p_action:'status',p_data:{}}));
     const job=(Array.isArray(status.jobs)?status.jobs:[]).find(j=>object(j).id===body.id) as NativeStudyJob|undefined;
     if(!job)throw new HttpError(404,'Consulta no disponible en el historial.');
     // Read only existing sources. No AI call, reservation, settlement or price write.
     return json(await refreshMarketSources(job));
    }
    if(route==='native-settings'&&req.method==='POST') {
     const body=object(await readBody(req)),choices=await extractionChoices(ctx,false);
     if(Object.keys(body).sort().join(',')!=='choice,revision'||!Number.isInteger(body.revision)||!choices.some(c=>c.choice===body.choice))throw new HttpError(422,'Selecciona un modelo configurado.');
     try{await rpc('market_extraction_select',{p_actor:user.id,p_revision:body.revision,p_choice:body.choice});}catch{throw new HttpError(409,'El modelo cambio. Actualiza antes de guardar.');}
     return json(await nativeSettings(ctx,rpc,user.id));
    }
    if(route==='studies'&&req.method==='POST')return json(await nativeStudy(await readBody(req),ctx,rpc,user.id));
    if(route==='search'&&req.method==='POST')return json(await marketSearch(await readBody(req),ctx,rpc,user.id));
    throw new HttpError(405,'Metodo no permitido.');
   }
   if(route==='research-access') {
    if(req.method!=='GET'&&req.method!=='POST')throw new HttpError(405,'Método no permitido.');
    try {
     const body=req.method==='GET'?{action:'list',config:{}}:object(await readBody(req));
     if(Object.keys(body).sort().join(',')!=='action,config'||!['list','create','revoke'].includes(String(body.action)))throw new Error('Invalid request');
     const result=await researchAdmin(env.rest,user.id,String(body.action),body.config,fetcher);
     return json(result);
    } catch { throw new HttpError(409,'Operación no confirmada. Actualiza el listado antes de reintentar; revoca cualquier credencial sin entregar.'); }
   }
   if(route==='extraction-settings') {
    const ctx={url:env.rest.url,serviceRoleKey:env.rest.serviceRoleKey,readEnv:env.readEnv||(()=>undefined),fetcher};
    const choices=await extractionChoices(ctx);
    if(req.method==='GET')return json({policy:await extractionPolicy(ctx),choices});
    if(req.method==='POST') {
     const body=object(await readBody(req));
     if(Object.keys(body).sort().join(',')!=='choice,revision'||!Number.isInteger(body.revision)||!choices.some(c=>c.choice===body.choice))throw new HttpError(422,'Selecciona un modelo compatible y configurado; no hay cambio automatico.');
     try{await source.rpc('market_extraction_select',{p_actor:user.id,p_revision:body.revision,p_choice:body.choice},false);}catch{throw new HttpError(409,'La seleccion cambio; actualiza antes de guardar.');}
     return json({policy:await extractionPolicy(ctx),choices});
    }
    throw new HttpError(405,'Metodo no permitido.');
   }
   if(route==='health'&&req.method==='GET')return json({ok:true,service:'market-study',schemaVersion:1});
   if(route==='bootstrap'&&req.method==='GET'){
    const [observations,reviews]=await Promise.all([source.all('market_study_observations?select=id,payload,created_at,created_by,origin_integration_id,origin_api_key_id&order=created_at.asc,id.asc',5000),source.all('market_study_reviews?select=id,observation_id,payload,created_at,created_by&order=created_at.asc,id.asc',10000)]);
    const warnings:string[]=[];
    const inventory=async()=>{try{
     const [snapshots,details,catalog,entity]=await Promise.all([source.records('inventory_snapshots'),source.records('product_details'),source.all(`content_products?select=${inventoryCatalogFields}&order=id.asc`),source.entity()]);
     const settings=await source.select(`accounting_entities?select=confirmations:settings->copilot_cost_currency_confirmations&id=eq.${entity}`);
     const stock=inventoryValuation(snapshots,details,catalog,{},factoCurrencies(env.currencyMap),object(settings[0]?.confirmations),true);
     const descriptions=new Map(resolveProducts(snapshots,details,catalog,false).map(p=>{
      const values=[...new Set(Array.isArray(p.search_descriptions)?p.search_descriptions:[])];
      return [p.sku,values.length===1?publicProductDescription(values[0]):''];
     }));
     return {...stock,records:stock.records.map(p=>({...p,description:descriptions.get(p.sku)||''}))};
    }catch{warnings.push('Inventario/costos no disponibles: no se sustituyen por cero.');return null;}};
    const imports=async()=>{try{
     const operations=await source.all('import_shipments?select=id&inventory_mode=eq.future&status=not.in.(received,closed,cancelled)&order=id.asc',50);
     const details=[];for(const op of operations)details.push(await source.rpc('foreign_trade_operation_detail',{p_operation_id:op.id}));
     return {details,complete:true};
    }catch{warnings.push('No se pudo verificar cobertura de productos por llegar.');return {details:[],complete:false};}};
    const parameters=async()=>{try{return await source.all('foreign_trade_cost_parameters?select=code,numeric_value,active,valid_from,valid_until&active=eq.true&order=code.asc',200);}catch{warnings.push('Parametros aduaneros no disponibles; no se completaran por suposicion.');return [];}};
    const [stock,incoming,costParameters]=await Promise.all([inventory(),imports(),parameters()]);
    return json({observations:observations.map(row=>({...row,created_by:row.created_by??`API ${row.origin_integration_id}`})),reviews,inventory:stock?.records||[],inventoryAvailable:stock!==null,inventoryWarnings:stock?.warnings||[],imports:incoming.details,costParameters,importsComplete:incoming.complete,warnings,readAt:new Date().toISOString()});
   }
   if(route==='imports/preview'&&req.method==='POST')return json(previewMarketImport(await readBody(req)));
   if(route==='imports/commit'&&req.method==='POST'){
    const preview=previewMarketImport(await readBody(req));if(!preview.canImport)return json(preview,422);
    try{return json(await source.rpc('market_study_import',{p_actor:user.id,p_items:preview.items},false));}
    catch{throw new HttpError(409,'No se importó el lote. Revisa claves, revisiones consecutivas y reintenta la lectura; no sobrescribas el historial.');}
   }
   if(route==='reviews'&&req.method==='POST'){
    const review=normalizeMarketReview(await readBody(req));
    // A submitted product key is a review proposal, not proof of product identity.
    // It remains excluded from analysis unless it resolves uniquely in current sources.
    try{return json(await source.rpc('market_study_review',{p_actor:user.id,p_review:review},false));}
    catch{throw new HttpError(409,'La revisión cambió o no pudo guardarse. Actualiza antes de reintentar.');}
   }
   throw new HttpError(404,'Ruta no disponible. No existe una operación para cambiar precios.');
  }catch(e){if(e instanceof ExtractionError)return json({error:e.code},e.status);return json({error:e instanceof HttpError?e.message:e instanceof Error&&!(e instanceof CopilotDataError)?e.message:'Estudio de Mercado no está disponible en este entorno. No se generaron resultados con datos incompletos.'},e instanceof HttpError?e.status:e instanceof CopilotDataError?503:400);}
 };
}
