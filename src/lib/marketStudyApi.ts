import { getSupabaseFunctionUrl, supabase } from './supabase';
import type { InventoryRecord } from './inventoryApi';
import type { ForeignTradeOperationDetail } from '../types/foreignTrade';
import type { MarketReview, MarketReviewInput, StoredMarketObservation, previewMarketImport } from '../../supabase/functions/_shared/market-study-contract';
export interface MarketBootstrap {observations:StoredMarketObservation[];reviews:MarketReview[];inventory:(InventoryRecord & {stock_warnings?:string[]})[];inventoryAvailable:boolean;inventoryWarnings:string[];imports:ForeignTradeOperationDetail[];importsComplete:boolean;warnings:string[];readAt:string}
async function request<T>(route:string,body?:unknown,signal?:AbortSignal):Promise<T>{
 const token=(await supabase?.auth.getSession())?.data.session?.access_token;
 if(!token)throw new Error('Inicia sesión para usar Estudio de Mercado.');
 const response=await fetch(getSupabaseFunctionUrl('market-study',route),{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),cache:'no-store',signal});
 const result=await response.json().catch(()=>({error:'El servicio no está disponible en este entorno.'}));
 if(!response.ok)throw new Error(result.error||`Consulta no disponible (${response.status}).`);
 return result as T;
}
export const getMarketBootstrap=(signal?:AbortSignal)=>request<MarketBootstrap>('bootstrap',undefined,signal);
export const previewMarketResearch=(body:unknown)=>request<ReturnType<typeof previewMarketImport>>('imports/preview',body);
export const importMarketResearch=(body:unknown)=>request<{inserted:number;duplicates:number}>('imports/commit',body);
export const reviewMarketResearch=(body:MarketReviewInput)=>request<MarketReview>('reviews',body);
