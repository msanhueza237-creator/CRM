import Decimal from 'decimal.js';
import { isChileMarketUrl, type NativeStudyJob, type MarketWebOffer } from '../../../supabase/functions/_shared/market-native-contract.ts';
import type { MarketFx, MarketObservation, MarketReview, StoredMarketObservation } from '../../../supabase/functions/_shared/market-study-contract';
export interface MarketProduct {
 key:string;sku:string;name:string;description?:string;brand?:string;category?:string;model?:string;sourceUrl?:string;mode:'current'|'transit';stock:number|null;stockAt:string|null;eta:string|null;
 price:number|null;priceCurrency:string|null;priceAt:string|null;cost:number|null;costCurrency:string|null;costAt:string|null;
 costStatus:'recorded'|'estimated'|'missing';costCurrencyAssumed?:boolean;relatedCurrentSku?:string|null;costSource:string;path:string;notices:string[];
}
export function marketTarget(price:number|null,cost:number|null,target:number|null,margin:number|null){
 const simulation=discountScenario(price,cost,1,0,target,margin);
 const valid=known(target)&&target>0;
 const maxCost=valid&&margin!==null?out(new Decimal(target).times(new Decimal(1).minus(new Decimal(margin).div(100)))):null;
 return {margin:valid?simulation.after.margin:null,profit:valid?simulation.after.unitProfit:null,
  gross:valid?out(new Decimal(target).times('1.19')):null,
  priceChange:valid&&known(price)?out(new Decimal(target).minus(price)):null,
  priceChangePercent:valid&&known(price)&&price>0?out(new Decimal(target).minus(price).div(price).times(100)):null,
  maxCost,costReduction:maxCost!==null&&known(cost)?out(Decimal.max(new Decimal(cost).minus(maxCost),0)):null};
}
export const MARKET_RULES={observationDays:30,financialDays:30,stockDays:2,fxDays:7,minConfidence:0.7,version:'market-opportunity-v1'};
export const known=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
export const fresh=(at:string|null,days:number,now=Date.now())=>!!at&&Number.isFinite(Date.parse(at))&&Date.parse(at)<=now&&now-Date.parse(at)<=days*86400000;
const out=(d:Decimal)=>{const n=d.toDecimalPlaces(6).toNumber();return Number.isFinite(n)&&Math.abs(n)<=1e15?n:null;};
export function toNetClp(amount:number|null,currency:string|null,basis:MarketObservation['vat_basis'],vat:number|null,fx:MarketFx|null,now=Date.now()):number|null {
 if(!known(amount)||!currency||basis==='unknown')return null;
 let value=new Decimal(amount);
 if(basis==='gross'){if(!known(vat)||vat>100)return null;value=value.div(new Decimal(1).plus(new Decimal(vat).div(100)));}
 if(basis==='exempt'&&vat!==0)return null;
 if(currency!=='CLP'){if(!fx||fx.currency!==currency||!known(fx.clp_per_unit)||fx.clp_per_unit<=0||!fx.source||!fresh(fx.observed_at,MARKET_RULES.fxDays,now))return null;value=value.times(fx.clp_per_unit);}
 return out(value);
}
export function discountScenario(price:number|null,cost:number|null,quantity:number,discount:number,target:number|null,minimumMargin:number|null){
 if(!known(quantity)||quantity<=0||quantity>1e9||!known(discount)||discount>100||target!==null&&!known(target)||minimumMargin!==null&&(!known(minimumMargin)||minimumMargin>=100))throw new Error('Cantidad, descuento, precio objetivo o margen fuera de rango.');
 const metrics=(sale:number|null)=>{
  const profit=known(sale)&&known(cost)?out(new Decimal(sale).minus(cost)):null;
  return {price:sale,unitProfit:profit,totalProfit:profit===null?null:out(new Decimal(profit).times(quantity)),margin:profit!==null&&sale!>0?out(new Decimal(profit).div(sale!).times(100)):null,markup:profit!==null&&cost!>0?out(new Decimal(profit).div(cost!).times(100)):null};
 };
 const after=target!==null?target:known(price)?out(new Decimal(price).times(new Decimal(1).minus(new Decimal(discount).div(100)))):null;
 const floor=known(cost)&&minimumMargin!==null?out(new Decimal(cost).div(new Decimal(1).minus(new Decimal(minimumMargin).div(100)))):null;
 const maximum=known(price)&&price>0&&floor!==null&&floor>0&&floor<=price?out(new Decimal(1).minus(new Decimal(floor).div(price)).times(100)):null;
 return {before:metrics(price),after:metrics(after),netPriceFloor:floor,maxDiscount:maximum,quantity,minimumMargin,policy:false,warnings:[...(!known(cost)?['Costo ausente: utilidad y margen no calculables.']:[]),...(known(cost)&&after!==null&&after<cost?['Pérdida bruta en este escenario.']:[]),...(floor!==null&&known(price)&&floor>price?['El precio actual no alcanza el margen elegido; no hay descuento admisible.']:[])]};
}
export function latestObservations(all:StoredMarketObservation[]){const map=new Map<string,StoredMarketObservation>();for(const row of all){const key=JSON.stringify([row.payload.provider,row.payload.external_id]);const prior=map.get(key);if(!prior||row.payload.revision>prior.payload.revision)map.set(key,row);}return [...map.values()];}
export function latestReview(all:MarketReview[],id:string){return all.filter(r=>r.observation_id===id).sort((a,b)=>b.created_at.localeCompare(a.created_at)||b.id.localeCompare(a.id))[0]||null;}
export interface MarketEvidenceFreshness {sourceReads?:{sku:string;url:string;observed_at:string;offer?:MarketWebOffer;internalProduct?:{name:string;description?:string;brand?:string}}[];sourceReadAvailable?:boolean}
const sameSku=(a:string,b:string)=>a.trim().toUpperCase()===b.trim().toUpperCase();
export function effectiveMarketEvidence(payload:MarketObservation,sku:string,evidence:MarketEvidenceFreshness={},currentProduct?:Pick<MarketProduct,'name'|'description'|'brand'>,reviewProduct?:{name:string;description:string;brand:string}) {
 const blocked=(status:string,reason:string,observed_at=payload.observed_at)=>({payload:{...payload,amount:null,observed_at},status,reused:false,reason});
 if(evidence.sourceReadAvailable===false)return blocked('unavailable','No se pudo verificar la vigencia de las fuentes; comparación suspendida.');
 const reads=(evidence.sourceReads||[]).filter(read=>sameSku(read.sku,sku)&&read.url===payload.source_url);
 if(reads.some(read=>!Number.isFinite(Date.parse(read.observed_at))))return blocked('unavailable','Fecha de lectura no verificable; comparación suspendida.');
 const normalize=(value:string|undefined)=>(value||'').normalize('NFKC').trim().replace(/\s+/g,' ').toLocaleLowerCase('es-CL');
 const baselineRead=reads.find(read=>Date.parse(read.observed_at)===Date.parse(payload.observed_at)&&read.offer?.technical);
 const binding=reviewProduct||baselineRead?.internalProduct;
 const newest=[...reads].sort((a,b)=>Date.parse(b.observed_at)-Date.parse(a.observed_at))[0];
 if(binding&&currentProduct&&['name','description','brand'].some(key=>normalize(binding[key as keyof typeof binding])!==normalize(currentProduct[key as keyof typeof currentProduct])))return blocked('technical_changed','La ficha interna cambió respecto del producto usado para aprobar la equivalencia; requiere revisión técnica.',newest?.observed_at);
 if(!newest||Date.parse(newest.observed_at)<=Date.parse(payload.observed_at))return {payload,status:'reviewed',reused:false,reason:null};
 const offer=newest.offer,baseline=baselineRead?.offer;
 if(!offer||offer.amount===null||offer.price_error)return blocked('commercial_unavailable','Lectura comercial no disponible. La equivalencia histórica se conserva; no se reutiliza el precio anterior.',newest.observed_at);
 if(!baseline?.technical||!offer.technical)return blocked('technical_unverified','Evidencia técnica incompleta para reutilizar la equivalencia. Verifica la ficha actual; no se afirma que el producto haya cambiado.',newest.observed_at);
 if(!binding||!currentProduct)return blocked('technical_unverified','Falta el respaldo de la ficha interna usada en la aprobación; requiere verificar la equivalencia técnica.',newest.observed_at);
 const before=baseline.technical,after=offer.technical;
 if(before.unit!==payload.unit||before.package_quantity!==payload.package_quantity)return blocked('technical_unverified','La presentación técnica de origen no coincide con la observación revisada; requiere verificar el respaldo.',newest.observed_at);
 if(before.fingerprint!==after.fingerprint||before.unit!==after.unit||before.package_quantity!==after.package_quantity)return blocked('technical_changed','La identidad o presentación técnica cambió respecto de la equivalencia aprobada; requiere revisión técnica.',newest.observed_at);
 if(offer.currency_assumed||offer.vat_assumed||offer.package_assumed||!offer.currency||offer.vat==='unknown'||offer.package_quantity!==after.package_quantity)return blocked('commercial_unverified','Equivalencia técnica conservada. Precio, moneda, IVA o presentación comercial requieren evidencia explícita; no se reutiliza el precio anterior.',newest.observed_at);
 return {payload:{...payload,amount:offer.amount,currency:offer.currency,vat_basis:offer.vat,vat_percent:offer.vat_percent,package_quantity:after.package_quantity,unit:after.unit,availability:offer.availability,observed_at:offer.observed_at},status:'reused',reused:true,reason:null};
}
// Review cards display the historical approval separately from the current commercial reading.
export function newerSourceEvidence(sku:string,url:string,observedAt:string,evidence:MarketEvidenceFreshness={}) {
 if(evidence.sourceReadAvailable===false)return 'No se pudo verificar la vigencia de las fuentes; comparación suspendida.';
 if(evidence.sourceReads?.some(read=>sameSku(read.sku,sku)&&read.url===url&&Date.parse(read.observed_at)>Date.parse(observedAt)))return 'Hay una lectura comercial posterior. La revisión técnica histórica se conserva; su reutilización depende de atributos y presentación sin cambios.';
 return null;
}
export function compareProduct(product:MarketProduct,observations:StoredMarketObservation[],reviews:MarketReview[],now=Date.now(),evidence:MarketEvidenceFreshness={}){
 const latest=latestObservations(observations);
 const associated=latest.filter(row=>sameSku(row.payload.suggested_sku||'',product.sku)||reviews.some(review=>review.observation_id===row.id&&review.payload.product_key===product.key));
 const candidates=associated.filter(row=>!associated.some(other=>other.id!==row.id&&other.payload.source_url===row.payload.source_url&&(Date.parse(other.payload.observed_at)>Date.parse(row.payload.observed_at)||(other.payload.observed_at===row.payload.observed_at&&other.created_at>=row.created_at)))).map(row=>({row,review:latestReview(reviews,row.id)})).filter(x=>x.review?.payload.product_key===product.key);
 const approved=candidates.filter(x=>x.review!.payload.decision==='approved'&&x.review!.payload.equivalence_confirmed);
 const signatures=new Set(approved.map(x=>JSON.stringify([x.review!.payload.unit,x.review!.payload.internal_quantity,x.review!.payload.internal_fx])));
 const coherent=signatures.size===1;
 const reference=coherent?approved[0]?.review?.payload:null;
 const offered=approved.map(({row,review})=>{
  const effective=effectiveMarketEvidence(row.payload,product.sku,evidence,product,review!.payload.internal_product),p=effective.payload,r=review!.payload,reasons:string[]=[];
  if(effective.reason)reasons.push(effective.reason);
  if(!coherent)reasons.push('Revisiones incompatibles de presentación o cambio interno.');
  if(r.sku!==product.sku||r.unit!==p.unit||!known(r.internal_quantity)||r.internal_quantity<=0)reasons.push('Unidad, cantidad o identidad incompatibles.');
  if(!isChileMarketUrl(p.source_url))reasons.push('Fuente fuera del alcance de dominios .cl.');
  if(p.seller_kind!=='competitor')reasons.push('Proveedor: referencia de compra, no precio competidor.');
  if(!fresh(p.observed_at,MARKET_RULES.observationDays,now))reasons.push('Oferta antigua o sin fecha válida.');
  if(p.confidence<MARKET_RULES.minConfidence)reasons.push('Confianza insuficiente.');
  if(p.availability!=='available')reasons.push('Disponibilidad no confirmada.');
  const net=toNetClp(p.amount,p.currency,p.vat_basis,p.vat_percent,p.fx,now);
  if(!known(p.package_quantity)||p.package_quantity<=0)reasons.push('Presentación sin cantidad válida.');
  if(net===null||net<=0)reasons.push('Precio, IVA, moneda o cambio incompletos.');
  const unitPrice=net!==null&&r.internal_quantity!==null&&known(p.package_quantity)&&p.package_quantity>0?out(new Decimal(net).div(p.package_quantity).times(r.internal_quantity)):null;
  return {observation:row,effectivePayload:p,evidenceStatus:effective.status,reusedTechnicalReview:effective.reused,review:review!,netPerInternalUnit:unitPrice,reasons,comparable:reasons.length===0};
 });
 // One quote per seller: duplicate research providers must not weight the median.
 const sellers=new Map<string,typeof offered[number]>();for(const o of offered.filter(x=>x.comparable)){const key=o.effectivePayload.seller.trim().toLocaleLowerCase();const previous=sellers.get(key);if(!previous||o.effectivePayload.observed_at>previous.effectivePayload.observed_at||(o.effectivePayload.observed_at===previous.effectivePayload.observed_at&&o.observation.id<previous.observation.id))sellers.set(key,o);}
 const comparable=[...sellers.values()],prices=comparable.map(o=>o.netPerInternalUnit!).sort((a,b)=>a-b);
 const median=prices.length?prices.length%2?prices[(prices.length-1)/2]:out(new Decimal(prices[prices.length/2-1]).plus(prices[prices.length/2]).div(2)):null;
 const cost=toNetClp(product.cost,product.costCurrency,'net',0,reference?.internal_fx||null,now),price=toNetClp(product.price,product.priceCurrency,'net',0,reference?.internal_fx||null,now);
 const simulation=discountScenario(price,cost,1,0,null,null),reasons=[...product.notices];
 if(!reference)reasons.push('Sin equivalencia aprobada y coherente.');
 if(product.mode==='current'&&(!reference||approved.some(x=>!x.review!.payload.cost_basis_confirmed)))reasons.push('Base del costo sin confirmar (IVA recuperable y unidad).');
 if(median===null)reasons.push('Sin ofertas comparables vigentes.');
 if(cost===null||!fresh(product.costAt,MARKET_RULES.financialDays,now))reasons.push('Costo sin respaldo reciente o moneda convertible.');
 if(price===null||price<=0||!fresh(product.priceAt,MARKET_RULES.financialDays,now))reasons.push('Precio de venta sin respaldo reciente.');
 if(product.mode==='current'&&(!known(product.stock)||product.stock<=0||!fresh(product.stockAt,MARKET_RULES.stockDays,now)))reasons.push('Stock positivo reciente no confirmado.');
 if(product.mode==='transit'&&(!product.eta||!/^\d{4}-\d{2}-\d{2}$/.test(product.eta)||!Number.isFinite(Date.parse(product.eta))||new Date(product.eta).toISOString().slice(0,10)!==product.eta||Date.parse(product.eta+'T23:59:59Z')<now))reasons.push('ETA incierta o vencida.');
 const margin=simulation.before.margin,advantage=median!==null&&median>0&&price!==null?out(new Decimal(median).minus(price).div(median).times(100)):null;
 if(margin===null||margin<=0)reasons.push('Utilidad bruta positiva no acreditada.');
 if(advantage===null||advantage<=0)reasons.push('Sin ventaja de precio frente a la mediana.');
 const confidence=comparable.length?Math.min(...comparable.map(o=>o.observation.payload.confidence)):null;
 const score=reasons.length===0&&margin!==null&&advantage!==null&&confidence!==null?out(new Decimal(Math.min(margin,advantage)).times(confidence)):null;
 return {product,candidates,offered,comparable,median,cost,price,margin,advantage,confidence,score,reasons,simulation,reference};
}
export function marketTopTen(products:MarketProduct[],observations:StoredMarketObservation[],reviews:MarketReview[],mode:'all'|'current'|'transit'='all',now=Date.now(),evidence:MarketEvidenceFreshness={}){
 const keys=new Map<string,number>();products.forEach(p=>keys.set(p.key,(keys.get(p.key)||0)+1));
 const considered=products.filter(p=>mode==='all'||p.mode===mode).map(p=>compareProduct({...p,notices:[...p.notices,...((keys.get(p.key)||0)>1?['Identidad interna duplicada.']:[])]},observations,reviews,now,evidence));
 const rows=considered.filter(r=>r.score!==null).sort((a,b)=>b.score!-a.score!||b.margin!-a.margin!||a.product.key.localeCompare(b.product.key)).slice(0,10);
 return {rows,considered,eligible:considered.filter(r=>r.score!==null).length,total:considered.length,generatedAt:new Date(now).toISOString(),criteria:MARKET_RULES};
}

// Reuse the reviewed comparison pipeline. A saved observation supersedes the
// unreviewed search snapshot, including pending/rejected or newer revisions.
export function marketTargetReferences(product:MarketProduct,job:NativeStudyJob|null,observations:StoredMarketObservation[],reviews:MarketReview[],now=Date.now(),evidence:MarketEvidenceFreshness={}) {
 const sourceReads=[...(evidence.sourceReads||[]),...(job?.state==='completed'&&job.sku===product.sku?job.result.offers||[]:[]).map(o=>({sku:product.sku,url:o.url,observed_at:o.observed_at,offer:o,internalProduct:job?.result.product_title?{name:job.result.product_title,...job.result.product_profile}:undefined}))];
 const reviewed=compareProduct(product,observations,reviews,now,{...evidence,sourceReads});
 const latest=latestObservations(observations);
 const approved=reviewed.comparable.map(o=>({url:o.effectivePayload.source_url,seller:o.effectivePayload.seller,observed_at:o.effectivePayload.observed_at,reviewed_at:o.review.created_at,reviewed_observed_at:o.observation.payload.observed_at,reused:o.reusedTechnicalReview,net:o.netPerInternalUnit!,reviewed:true}));
 const offers=job?.state==='completed'&&job.sku===product.sku?job.result.offers||[]:[];
 const provisional=offers.filter(o=>!latest.some(r=>r.payload.source_url===o.url&&(r.payload.suggested_sku===product.sku||reviews.some(v=>v.observation_id===r.id&&v.payload.product_key===product.key))))
  .filter(o=>isChileMarketUrl(o.url)&&o.identity==='model_match'&&o.package_quantity===1&&o.availability!=='unavailable'&&fresh(o.observed_at,MARKET_RULES.observationDays,now))
  .map(o=>({...o,net:toNetClp(o.amount,o.currency,o.vat,o.vat_percent,null,now),reviewed:false}))
  .filter((o):o is typeof o & {net:number}=>o.net!==null&&o.net>0);
 // Prefer reviewed evidence when it exists; do not dilute it with candidates.
 const candidates=approved;
 const bySeller=new Map<string,typeof candidates[number]>();
 for(const o of candidates){const key=o.seller.trim().toLowerCase().replace(/^www\./,'');const previous=bySeller.get(key);if(!previous||o.observed_at>previous.observed_at)bySeller.set(key,o);}
 const references=[...bySeller.values()].sort((a,b)=>a.net-b.net);
 return {references,reviewed,provisional,usesReviewed:approved.length>0};
}

// Channel assumptions are explicit user inputs; a public offer is never a wholesale price.
export function channelScenario(price:number|null,cost:number|null,expensePerUnit:number|null,commissionPercent:number|null){
 const reasons:string[]=[];
 if(!known(price)||price<=0)reasons.push('Ingresa un precio neto positivo para este canal.');
 if(!known(cost))reasons.push('Falta costo por unidad con moneda y base verificables.');
 if(!known(expensePerUnit))reasons.push('Ingresa gastos por unidad; cero debe ser explícito.');
 if(!known(commissionPercent)||commissionPercent>=100)reasons.push('Ingresa comisión entre 0 y menos de 100%.');
 if(reasons.length)return {contribution:null,margin:null,totalCost:null,reasons};
 const totalCost=out(new Decimal(cost!).plus(expensePerUnit!).plus(new Decimal(price!).times(commissionPercent!).div(100)));
 const contribution=totalCost===null?null:out(new Decimal(price!).minus(totalCost));
 const margin=contribution===null?null:out(new Decimal(contribution).div(price!).times(100));
 return {contribution,margin,totalCost,reasons:contribution!==null&&contribution<0?['Pérdida en este escenario.']:[]};
}
