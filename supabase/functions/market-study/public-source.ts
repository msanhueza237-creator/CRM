// Worker build avoids Node-only canvas dependencies in the Edge runtime.
import { parseHTML } from 'linkedom/worker';
import robotsParser from 'robots-parser';
import { marketSite, publicProductUrl } from '../_shared/market-native-contract.ts';
const agent='ClimactivaResearch';
async function read(response:Response,max:number) {
  const reader=response.body?.getReader();if(!reader)throw new Error('La fuente no entrego contenido.');
  const chunks:Uint8Array[]=[];let length=0;
  while(true){const item=await reader.read();if(item.done)break;length+=item.value.length;if(length>max){await reader.cancel();throw new Error('La fuente supera el tamano permitido.');}chunks.push(item.value);}
  const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  return new TextDecoder().decode(bytes);
}
export function productText(html:string,sourceUrl?:string) {
  const {document}=parseHTML(html) as {document:Document};
  const products:Record<string,unknown>[]=[];
  const visit=(value:unknown,depth=0)=>{if(depth>12||!value||typeof value!=='object')return;if(Array.isArray(value)){value.forEach(v=>visit(v,depth+1));return;}
    const r=value as Record<string,unknown>;if([r['@type']].flat().includes('Product'))products.push(r);else if(r['@graph'])visit(r['@graph'],depth+1);};
  for(const node of document.querySelectorAll('script[type="application/ld+json"]')){try{visit(JSON.parse(node.textContent||''));}catch{/* Invalid metadata is not evidence. */}}
  for(const node of document.querySelectorAll('script,style,nav,header,footer,form,aside,iframe,button,[hidden],[aria-hidden="true"]'))node.remove();
  if(products.length>1)throw new Error('La pagina contiene varios productos. Selecciona una ficha individual.');
  const heading=document.querySelector('h1'),cartContext=heading?.parentElement?.querySelector('#product')?heading.parentElement:null;
  const main=document.querySelector('main,[itemtype="https://schema.org/Product"]')||cartContext||document.querySelector('#content')||document.body;
  const clean=(s:unknown)=>{const d=parseHTML(`<html><body>${String(s??'')}</body></html>`) as {document:Document};return (d.document.body.textContent||'').replace(/\s+/g,' ').trim();};
  if(products.length===1){
    const p=products[0],offers=[p.offers].flat().filter(v=>v&&typeof v==='object') as Record<string,unknown>[];
    if(offers.length!==1||offers[0]['@type']==='AggregateOffer')throw new Error('Hay variantes o precios multiples; requiere revision manual.');
    const offer=offers[0],brand=p.brand&&typeof p.brand==='object'?(p.brand as Record<string,unknown>).name:p.brand;
    const facts={title:clean(p.name).slice(0,160),brand:clean(brand).slice(0,120),model:clean(p.model).slice(0,120),sku:clean(p.sku).slice(0,120),
      price:offer.price,currency:offer.priceCurrency,availability:offer.availability,priceIncludesTax:offer.valueAddedTaxIncluded,singleProduct:true,description:clean(p.description).slice(0,3000)};
    const taxLines=(main?.textContent||'').split(/\n/).map(s=>s.trim()).filter(s=>s.length<180&&/\bIVA\b|impuesto|por unidad|pack de/i.test(s)).slice(0,6);
    return JSON.stringify(facts)+'\n'+taxLines.join('\n');
  }
  const headings=document.querySelectorAll('h1');
  if(headings.length!==1||!main)throw new Error('No se identifico una ficha individual de producto.');
  const meta=(key:string)=>document.querySelector(`meta[property="${key}"],meta[name="${key}"]`)?.getAttribute('content');
  const nodes=[...main.querySelectorAll('[itemprop="price"]')];
  const price=meta('product:price:amount')||meta('og:price:amount')||(nodes.length===1?nodes[0].getAttribute('content'):null);
  const currency=meta('product:price:currency')||meta('og:price:currency')||main.querySelector('[itemprop="priceCurrency"]')?.getAttribute('content');
  const isProduct=meta('og:type')?.includes('product')||document.querySelector('[itemtype$="schema.org/Product"]');
  if(price&&currency&&isProduct){
    const taxLines=(main.textContent||'').split(/\n/).map(s=>s.trim()).filter(s=>s.length<180&&/\bIVA\b|impuesto|por unidad|pack de/i.test(s)).slice(0,6);
    return JSON.stringify({title:headings[0].textContent?.trim(),price,currency,singleProduct:true})+'\n'+taxLines.join('\n');
  }
  // OpenCart product detail: scope to the title/cart block, never related cards.
  if(cartContext&&sourceUrl&&new URL(sourceUrl).hostname.endsWith('.cl')){
    const prices=[...cartContext.querySelectorAll('h2')].map(n=>n.textContent?.trim()||'').filter(s=>/^\$\s*\d{1,3}(?:[.,]\d{3})*$|^\$\s*\d+$/.test(s));
    const context=cartContext.textContent||'',net=context.match(/Neto:\s*\$\s*([\d.,]+)/i);
    const integer=(s:string)=>Number(s.replace(/[^0-9]/g,''));
    if(prices.length===1&&net&&!/US\$|\bUSD\b/.test(context)){
      const gross=integer(prices[0]),netPrice=integer(net[1]);
      if(gross>0&&netPrice>0&&Math.abs(gross-netPrice*1.19)<=1.5){
        return JSON.stringify({title:heading?.textContent?.trim(),price:gross,currency:'CLP',currencyAssumed:true,priceIncludesTax:true,singleProduct:true,
          availability:/sin\s+stock|agotado/i.test(context)?'https://schema.org/OutOfStock':/stock\s+disponible/i.test(context)?'https://schema.org/InStock':null,
          priceEvidence:prices[0],netEvidence:net[0]})+'\nIVA 19% conciliado entre precio publicado y neto. CLP supuesto por ficha chilena en pesos.';
      }
    }
  }
  const text=(headings[0].textContent+'\n'+main.textContent).replace(/[ \t]+/g,' ').replace(/\n{3,}/g,'\n\n').trim();
  if(new TextEncoder().encode(text).length>20000)throw new Error('La ficha contiene demasiada informacion; no se enviara una lectura parcial.');
  return text;
}
export async function fetchPublicProduct(value:string,fetcher:typeof fetch=fetch,openMarket=false) {
  const url=openMarket?publicProductUrl(value):marketSite(value).url,signal=AbortSignal.timeout(openMarket?8000:16000);
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
  return {text:productText(html,url.href),observed_at:new Date().toISOString()};
}
