// Worker build avoids Node-only canvas dependencies in the Edge runtime.
import { parseHTML } from 'linkedom/worker';
import robotsParser from 'robots-parser';
import { marketSite } from '../_shared/market-native-contract.ts';
const agent='ClimactivaResearch';
async function read(response:Response,max:number) {
  const reader=response.body?.getReader();if(!reader)throw new Error('La fuente no entrego contenido.');
  const chunks:Uint8Array[]=[];let length=0;
  while(true){const item=await reader.read();if(item.done)break;length+=item.value.length;if(length>max){await reader.cancel();throw new Error('La fuente supera el tamano permitido.');}chunks.push(item.value);}
  const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  return new TextDecoder().decode(bytes);
}
export function productText(html:string) {
  const {document}=parseHTML(html) as {document:Document};
  const products:Record<string,unknown>[]=[];
  const visit=(value:unknown,depth=0)=>{if(depth>12||!value||typeof value!=='object')return;if(Array.isArray(value)){value.forEach(v=>visit(v,depth+1));return;}
    const r=value as Record<string,unknown>;if([r['@type']].flat().includes('Product'))products.push(r);else if(r['@graph'])visit(r['@graph'],depth+1);};
  for(const node of document.querySelectorAll('script[type="application/ld+json"]')){try{visit(JSON.parse(node.textContent||''));}catch{/* Invalid metadata is not evidence. */}}
  for(const node of document.querySelectorAll('script,style,nav,header,footer,form,aside,iframe,button,[hidden],[aria-hidden="true"]'))node.remove();
  if(products.length>1)throw new Error('La pagina contiene varios productos. Selecciona una ficha individual.');
  const main=document.querySelector('main,[itemtype="https://schema.org/Product"],#product')||document.body;
  const clean=(s:unknown)=>{const d=parseHTML(`<html><body>${String(s??'')}</body></html>`) as {document:Document};return (d.document.body.textContent||'').replace(/\s+/g,' ').trim();};
  if(products.length===1){
    const p=products[0],offers=[p.offers].flat().filter(v=>v&&typeof v==='object') as Record<string,unknown>[];
    if(offers.length!==1||offers[0]['@type']==='AggregateOffer')throw new Error('Hay variantes o precios multiples; requiere revision manual.');
    const offer=offers[0],brand=p.brand&&typeof p.brand==='object'?(p.brand as Record<string,unknown>).name:p.brand;
    const facts={title:clean(p.name),brand:clean(brand),model:clean(p.model),sku:clean(p.sku),description:clean(p.description).slice(0,3000),
      price:offer.price,currency:offer.priceCurrency,availability:offer.availability,priceIncludesTax:offer.valueAddedTaxIncluded};
    const taxLines=(main?.textContent||'').split(/\n/).map(s=>s.trim()).filter(s=>s.length<180&&/\bIVA\b|impuesto|por unidad|pack de/i.test(s)).slice(0,6);
    return JSON.stringify(facts)+'\n'+taxLines.join('\n');
  }
  const headings=document.querySelectorAll('h1');
  if(headings.length!==1||!main)throw new Error('No se identifico una ficha individual de producto.');
  const text=(headings[0].textContent+'\n'+main.textContent).replace(/[ \t]+/g,' ').replace(/\n{3,}/g,'\n\n').trim();
  if(new TextEncoder().encode(text).length>20000)throw new Error('La ficha contiene demasiada informacion; no se enviara una lectura parcial.');
  return text;
}
export async function fetchPublicProduct(value:string,fetcher:typeof fetch=fetch) {
  const {url}=marketSite(value),signal=AbortSignal.timeout(22000);
  const get=async(target:string)=>fetcher(target,{redirect:'manual',signal,headers:{'User-Agent':agent,Accept:'text/html,text/plain','Cache-Control':'no-cache'}});
  const robots=await get(url.origin+'/robots.txt');
  let rules='';if(robots.status!==404){if(!robots.ok){await robots.body?.cancel();throw new Error('No se pudo verificar el permiso de lectura del sitio.');}rules=await read(robots,100000);}else await robots.body?.cancel();
  const parser=robotsParser(url.origin+'/robots.txt',rules),delay=parser.getCrawlDelay(agent)||0;
  if(parser.isAllowed(url.href,agent)===false||delay>5)throw new Error('El sitio no permite esta consulta automatizada.');
  if(delay>0)await new Promise(r=>setTimeout(r,delay*1000));
  const response=await get(url.href);
  if(!response.ok){await response.body?.cancel();throw new Error(response.status>=300&&response.status<400?'La fuente redirige. Abre el enlace y utiliza la direccion final.':'La fuente no esta disponible o restringe el acceso.');}
  if(!/^text\/html(?:;|$)/i.test(response.headers.get('content-type')||'')){await response.body?.cancel();throw new Error('La fuente no es una pagina de producto HTML.');}
  const html=await read(response,1500000);
  if(/cf-chl-|verify you are human|access denied|<title>[^<]*(?:captcha|just a moment)/i.test(html))throw new Error('El sitio solicita una verificacion humana. Consulta detenida.');
  return {text:productText(html),observed_at:new Date().toISOString()};
}
