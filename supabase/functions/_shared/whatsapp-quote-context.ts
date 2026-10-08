type Product={sku:string;name:string};
type Message={direction:string;body:string;status:string;occurredAt:string};
const normal=(s:string)=>s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const family=(name:string)=>{const n=normal(name);return /\bsoporte\b/.test(n)?/\bmuro\b/.test(n)?'muro':/\btecho\b/.test(n)?'techo':'':'';};
export function deriveQuoteLines(messages:Message[],products:Product[]) {
 const selected=new Map<string,{sku:string;name:string;quantity:number}>();let pendingSku='',offer='';
 const lookup=(sku:string)=>{const matches=products.filter(p=>p.sku===sku);return matches.length===1?matches[0]:null;};
 const pick=(sku:string,quantity=1)=>{const p=lookup(sku);if(!p)return;const key=family(p.name)||sku;selected.set(key,{sku:p.sku,name:p.name,quantity});pendingSku=sku;};
 let latestRequest='';
 for(const m of [...messages].sort((a,b)=>Date.parse(a.occurredAt)-Date.parse(b.occurredAt))){
  if(m.direction==='outbound'){
   if(!['accepted','sent','delivered','read'].includes(m.status))continue;
   offer=m.body;
   const ack=m.body.match(/^Elegiste .+ \(código ([^\n]+)\)\. ¿Cuántas unidades quieres\?$/);if(ack)pick(ack[1]);
   continue;
  }
  if(m.direction!=='inbound')continue;
  const text=normal(m.body);if(/\b(cotizacion|cotizar|presupuesto)\b/.test(text))latestRequest=m.body;
  if(/\b(olvida|cancelar|cancela)\b|no quiero|no me interesa/.test(text)){selected.clear();pendingSku='';continue;}
  const option=text.match(/\b(?:numero|opcion|modelo|producto)\s*(\d{1,2})\b/)||text.match(/^\s*(\d{1,2})[.!?\s]*$/);
  if(option&&offer.startsWith('Encontré estos modelos en el catálogo:')){
   const entries=[...offer.matchAll(/(?:^|\n)(\d+)\. [^\n]+\nCódigo: ([^\n]+)/g)].filter(p=>Number(p[1])===Number(option[1]));if(entries.length===1)pick(entries[0][2].trim());
  }else if(pendingSku&&/¿Cuántas unidades quieres\?/.test(offer)){
   const qty=text.match(/^(?:(?:quiero|necesito|dame)\s+)?([1-9]\d{0,3})(?:\s+(?:unidades?|piezas?))?[.!?\s]*$/);
   if(qty)pick(pendingSku,Number(qty[1]));
  }
 }
 const unresolved:string[]=[];
 for(const m of normal(latestRequest).matchAll(/([1-9]\d{0,3})\s+soportes?\s+(?:de\s+)?(muro|techo)/g)){
  const key=m[2],quantity=Number(m[1]),chosen=selected.get(key);
  if(chosen){selected.set(key,{...chosen,quantity});continue;}
  const options=products.filter(p=>family(p.name)===key);
  if(options.length===1)selected.set(key,{sku:options[0].sku,name:options[0].name,quantity});else unresolved.push(`${quantity} soporte(s) de ${key}: falta confirmar el modelo exacto.`);
 }
 const requestedFamilies=[...normal(latestRequest).matchAll(/soportes?\s+(?:de\s+)?(muro|techo)/g)].map(m=>m[1]);
 return {lines:[...selected.values()].filter(p=>!requestedFamilies.length||requestedFamilies.includes(family(p.name))),unresolved};
}
