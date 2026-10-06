export const MARKET_SITES = [
  {name:'Refrimarket', host:'www.refrimarket.com'},
  {name:'RefriRepuestos', host:'refrirepuestos.cl'},
  {name:'ANWO', host:'www.anwo.cl'},
  {name:'MoretoClima', host:'www.moretoclima.cl'},
  {name:'Antartic', host:'antartic.cl'},
  {name:'Acondiparts Center', host:'www.acondiparts.cl'},
  {name:'Climalider', host:'climalider.cl'},
  {name:'Frioline', host:'frioline.cl'},
] as const;
export interface MarketAttribute {field:string;value:string;quote:string}
export interface NativeStudyJob {
  id:string; sku:string; source_url:string; state:'running'|'completed'|'failed'|'unknown';
  created_at:string; finished_at:string|null; reserved_usd:number; estimated_usd:number|null;
  selection:{choice:string;provider:string;model:string};
  result:{attributes?:MarketAttribute[];text?:string;observed_at?:string;error?:string};
}
export function marketSite(value:string) {
  let url:URL;
  try {url=new URL(value);} catch {throw new Error('Ingresa una URL HTTPS de producto.');}
  const site=MARKET_SITES.find(s=>s.host.replace(/^www\./,'')===url.hostname.replace(/^www\./,''));
  if(!site||url.protocol!=='https:'||url.port||url.username||url.password||url.search||url.hash||url.href.length>1500||/\/(?:admin|login|account|cart|checkout)(?:\/|$)/i.test(url.pathname))
    throw new Error('Fuente no admitida: usa una ficha HTTPS de los sitios disponibles, sin parametros ni acceso privado.');
  return {site,url};
}
