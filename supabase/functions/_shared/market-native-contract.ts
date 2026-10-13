export const MARKET_SITES = [
  {name:'RefriRepuestos', host:'refrirepuestos.cl'},
  {name:'ANWO', host:'www.anwo.cl'},
  {name:'MoretoClima', host:'www.moretoclima.cl'},
  {name:'Antartic', host:'antartic.cl'},
  {name:'Acondiparts Center', host:'www.acondiparts.cl'},
  {name:'Climalider', host:'climalider.cl'},
  {name:'Frioline', host:'frioline.cl'},
] as const;
export interface MarketAttribute {field:string;value:string;quote:string}
export interface MarketWebOffer {
  url:string; seller:string; title:string; observed_at:string; image_url?:string;
  amount:number|null; currency:string|null; vat:'gross'|'net'|'unknown';
  vat_percent:number|null; package_quantity:number|null; availability:string;
  identity:'model_match'|'similar'|'different'|'possible'; evidence:string; warning:string;
  match_reasons?:string[]; conflicts?:string[];
  vat_assumed?:boolean; package_assumed?:boolean; currency_assumed?:boolean;
  price_error?:string;
  technical?:{fingerprint:string;unit:'unit'|'kg'|'m'|'l';package_quantity:number};
  search_scope?:{eligible:boolean;sector:string|null;capacity_evidence:string|null};
}
export interface NativeStudyJob {
  id:string; sku:string; source_url:string; state:'running'|'completed'|'failed'|'unknown';
  created_at:string; finished_at:string|null; reserved_usd:number; estimated_usd:number|null;
  selection:{choice:string;provider:string;model:string};
  result:{attributes?:MarketAttribute[];text?:string;observed_at?:string;error?:string;
    kind?:'market_search';product_title?:string;product_profile?:{description?:string;brand?:string;category?:string};queries?:string[];offers?:MarketWebOffer[];search_restriction?:string;
    source_count?:number;coverage?:string;usage_note?:string;refreshed_at?:string; source_revision?:number; source_history?:{revision:number;refreshed_at:string;request_id:string}[];
    original_result?:NativeStudyJob['result'];refresh_batch?:string;source_policy?:'chile_cl_only'};
}
export function isChileMarketUrl(value:string) {
  try{return publicProductUrl(value).hostname.endsWith('.cl');}catch{return false;}
}
// Public links from search are not restricted to the example competitor list.
// Network-level DNS/IP validation is additionally required before fetching them.
export function publicProductUrl(value:string) {
  let u:URL;try{u=new URL(value);}catch{throw new Error('Enlace publico invalido.');}
  if(u.protocol!=='https:'||u.username||u.password||u.port||u.href.length>1500||
    !/^([a-z0-9][a-z0-9-]*\.)+[a-z]{2,63}$/i.test(u.hostname)||
    /(?:^|\.)(?:localhost|local|internal|test|invalid|example|lan|home|onion)$/i.test(u.hostname)||
    /\/(?:admin|login|account|cart|checkout|auth|api)(?:\/|$)/i.test(u.pathname)||
    [...u.searchParams.keys()].some(k=>/token|secret|key|auth|session|password|signature|credential|email|phone/i.test(k)||/^(?:add[-_]?to[-_]?cart|remove_item|wc-ajax|checkout|quantity|action|cmd|add|buy|remove|submit|purchase)$/i.test(k)))
    throw new Error('El enlace no corresponde a una fuente publica HTTPS.');
  for(const k of [...u.searchParams.keys()])if(/^utm_|^(?:gclid|fbclid)$/i.test(k))u.searchParams.delete(k);
  u.hash='';return u;
}
// Search indexes sometimes return WooCommerce add-to-cart links. Only the
// explicit product-detail path can become a read-only source; no action is sent.
// All other action URLs remain rejected by publicProductUrl.
export function publicProductSourceUrl(value:string) {
  let u:URL;try{u=new URL(value);}catch{throw new Error('Enlace publico invalido.');}
  if(u.searchParams.has('add-to-cart')&&/^\/(?:producto|product)\/[^/]+\/?$/.test(u.pathname)&&
    u.searchParams.getAll('add-to-cart').length===1&&/^\d+$/.test(u.searchParams.get('add-to-cart')||'')){
    u.searchParams.delete('add-to-cart');u.searchParams.delete('quantity');
  }
  return publicProductUrl(u.href);
}
export function marketSite(value:string) {
  let url:URL;
  try {url=new URL(value);} catch {throw new Error('Ingresa una URL HTTPS de producto.');}
  const site=MARKET_SITES.find(s=>s.host.replace(/^www\./,'')===url.hostname.replace(/^www\./,''));
  if(!site||url.protocol!=='https:'||url.port||url.username||url.password||url.search||url.hash||url.href.length>1500||/\/(?:admin|login|account|cart|checkout)(?:\/|$)/i.test(url.pathname))
    throw new Error('Fuente no admitida: usa una ficha HTTPS de los sitios disponibles, sin parametros ni acceso privado.');
  return {site,url};
}
