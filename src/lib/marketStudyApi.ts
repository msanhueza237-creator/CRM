import { getSupabaseFunctionUrl, supabase } from './supabase';
import type { InventoryRecord } from './inventoryApi';
import type { ForeignTradeOperationDetail } from '../types/foreignTrade';
import type { NativeStudyJob } from '../../supabase/functions/_shared/market-native-contract';
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
export interface MarketExtractionSettingsData {
 policy:{enabled:boolean;revision:number;choice:string;daily_usd:number;pilot_usd:number;daily_jobs:number;public_hosts:string[]};
 choices:{choice:string;provider:string;model:string;input_usd_per_million:number;output_usd_per_million:number;rate_source:string;rate_checked_at:string}[];
}
export const getMarketExtractionSettings=()=>request<MarketExtractionSettingsData>('extraction-settings');
export const saveMarketExtractionSettings=(body:{revision:number;choice:string})=>request<MarketExtractionSettingsData>('extraction-settings',body);
export interface ResearchAccessData {
 schema_version:1;
 usage?:{jobs:number;unknown_jobs:number;estimated_usd:number;held_usd:number;last_job_at:string|null;skus:string[]};
 policy:MarketExtractionSettingsData['policy'] & {approved_until:string|null};
 scopes:string[];
 integrations:{id:string;provider:string;skus:string[];expires_at:string;active:boolean;key_prefix:string}[];
}
export const getResearchAccess=()=>request<ResearchAccessData>('research-access');
export const createResearchAccess=(config:unknown)=>request<{id:string;api_key:string;expires_at:string}>('research-access',{action:'create',config});
export const revokeResearchAccess=(id:string)=>request<{revoked:boolean}>('research-access',{action:'revoke',config:{id,confirm:'REVOKE'}});
export interface NativeStudySettings {
 enabled:boolean;daily_usd:number;daily_jobs:number;spent_usd:number;jobs_today:number;
 selection:{choice:string;revision:number};choices:MarketExtractionSettingsData['choices'];jobs:NativeStudyJob[];
}
export const getNativeStudySettings=()=>request<NativeStudySettings>('native-settings');
export const selectNativeStudyModel=(body:{choice:string;revision:number})=>request<NativeStudySettings>('native-settings',body);
export const runNativeStudy=(body:{id:string;sku:string;url:string;revision:number})=>request<NativeStudyJob>('studies',body,AbortSignal.timeout(85000));
