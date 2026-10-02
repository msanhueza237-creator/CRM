import Decimal from 'decimal.js';
import type { MarketFx, MarketObservation, MarketReview, StoredMarketObservation } from '../../../supabase/functions/_shared/market-study-contract';
export interface MarketProduct {
 key:string;sku:string;name:string;mode:'current'|'transit';stock:number|null;stockAt:string|null;eta:string|null;
 price:number|null;priceCurrency:string|null;priceAt:string|null;cost:number|null;costCurrency:string|null;costAt:string|null;
 costStatus:'recorded'|'estimated'|'missing';costSource:string;path:string;notices:string[];
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
export function compareProduct(product:MarketProduct,observations:StoredMarketObservation[],reviews:MarketReview[],now=Date.now()){
 const candidates=latestObservations(observations).map(row=>({row,review:latestReview(reviews,row.id)})).filter(x=>x.review?.payload.product_key===product.key);
 const approved=candidates.filter(x=>x.review!.payload.decision==='approved'&&x.review!.payload.equivalence_confirmed);
 const signatures=new Set(approved.map(x=>JSON.stringify([x.review!.payload.unit,x.review!.payload.internal_quantity,x.review!.payload.internal_fx])));
 const coherent=signatures.size===1;
 const reference=coherent?approved[0]?.review?.payload:null;
 const offered=approved.map(({row,review})=>{
  const p=row.payload,r=review!.payload,reasons:string[]=[];
  if(!coherent)reasons.push('Revisiones incompatibles de presentación o cambio interno.');
  if(r.sku!==product.sku||r.unit!==p.unit||!known(r.internal_quantity)||r.internal_quantity<=0)reasons.push('Unidad, cantidad o identidad incompatibles.');
  if(p.seller_kind!=='competitor')reasons.push('Proveedor: referencia de compra, no precio competidor.');
  if(!fresh(p.observed_at,MARKET_RULES.observationDays,now))reasons.push('Oferta antigua o sin fecha válida.');
  if(p.confidence<MARKET_RULES.minConfidence)reasons.push('Confianza insuficiente.');
  if(p.availability!=='available')reasons.push('Disponibilidad no confirmada.');
  const net=toNetClp(p.amount,p.currency,p.vat_basis,p.vat_percent,p.fx,now);
  if(!known(p.package_quantity)||p.package_quantity<=0)reasons.push('Presentación sin cantidad válida.');
  if(net===null||net<=0)reasons.push('Precio, IVA, moneda o cambio incompletos.');
  const unitPrice=net!==null&&r.internal_quantity!==null&&known(p.package_quantity)&&p.package_quantity>0?out(new Decimal(net).div(p.package_quantity).times(r.internal_quantity)):null;
  return {observation:row,review:review!,netPerInternalUnit:unitPrice,reasons,comparable:reasons.length===0};
 });
 // One quote per seller: duplicate research providers must not weight the median.
 const sellers=new Map<string,typeof offered[number]>();for(const o of offered.filter(x=>x.comparable)){const key=o.observation.payload.seller.trim().toLocaleLowerCase();const previous=sellers.get(key);if(!previous||o.observation.payload.observed_at>previous.observation.payload.observed_at||(o.observation.payload.observed_at===previous.observation.payload.observed_at&&o.observation.id<previous.observation.id))sellers.set(key,o);}
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
export function marketTopTen(products:MarketProduct[],observations:StoredMarketObservation[],reviews:MarketReview[],mode:'all'|'current'|'transit'='all',now=Date.now()){
 const keys=new Map<string,number>();products.forEach(p=>keys.set(p.key,(keys.get(p.key)||0)+1));
 const considered=products.filter(p=>mode==='all'||p.mode===mode).map(p=>compareProduct({...p,notices:[...p.notices,...((keys.get(p.key)||0)>1?['Identidad interna duplicada.']:[])]},observations,reviews,now));
 const rows=considered.filter(r=>r.score!==null).sort((a,b)=>b.score!-a.score!||b.margin!-a.margin!||a.product.key.localeCompare(b.product.key)).slice(0,10);
 return {rows,considered,eligible:considered.filter(r=>r.score!==null).length,total:considered.length,generatedAt:new Date(now).toISOString(),criteria:MARKET_RULES};
}
