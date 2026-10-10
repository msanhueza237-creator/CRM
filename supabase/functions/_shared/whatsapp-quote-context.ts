import { currentQuoteSession, isQuoteRequest } from './whatsapp-quote-flow.ts';
type Product={sku:string;name:string};
type Message={direction:string;body:string;status:string;occurredAt:string};
const words=(value:string):string[]=>normal(value).match(/[a-z]+/g)||[];
const normal=(s:string)=>s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const family=(name:string)=>{const n=normal(name);return /\bsoporte\b/.test(n)?/\bmuro\b/.test(n)?'muro':/\btecho\b/.test(n)?'techo':'':'';};
export function selectedQuantity(text:string,sku='') {
 const clean=normal(text).split(/\b(?:rut|\d{1,2}\.?\d{3}\.?\d{3}-[\dk])\b/)[0].split(normal(sku)||'\0').join(' ');
 const unit=clean.match(/\b([1-9]\d{0,3})\s*(?:unidades?|unidad|piezas?)\b/);
 if(unit&&[...clean.matchAll(/\d+/g)].length===1)return Number(unit[1]);
 const matches=[...clean.matchAll(/(?:\b(?:cotizame|cotizar|cotiza|cotices|cotice|coticen|cotizas|quiero|necesito|dame|llevo)\s+(?:esas?\s+|las?\s+|los?\s+)?|^\s*)([1-9]\d{0,3})(?=\b)/g)];
 if(matches.length!==1||[...clean.matchAll(/\b\d+\b/g)].length!==1)return null;
 return Number(matches[0][1]);
}
export function explicitSelectedProducts<T extends Product>(text:string,products:T[]) {
 const n=normal(text);
 return products.filter(p=>{const sku=normal(p.sku);let at=n.indexOf(sku);while(at>=0){if((at===0||!/[a-z0-9-]/.test(n[at-1]))&&(at+sku.length===n.length||!/[a-z0-9-]/.test(n[at+sku.length])))return true;at=n.indexOf(sku,at+1);}return false;});
}
export function deriveQuoteLines(messages:Message[],products:Product[]) {
 const selected=new Map<string,{sku:string;name:string;quantity:number;confirmed:boolean}>();let pendingSku='',offer='',catalogOffer='',singleOfferedSku='';
 const lookup=(sku:string)=>{const matches=products.filter(p=>p.sku===sku);return matches.length===1?matches[0]:null;};
 const pick=(sku:string,quantity=1,confirmed=false)=>{const p=lookup(sku);if(!p)return;const key=family(p.name)||sku;selected.set(key,{sku:p.sku,name:p.name,quantity,confirmed});pendingSku=sku;};
 let latestRequest='';
 for(const m of currentQuoteSession(messages)){
  if(m.direction==='outbound'){
   if(!['accepted','sent','delivered','read'].includes(m.status))continue;
   offer=m.body;const mentioned=products.filter(p=>m.body.includes(p.name)&&m.body.includes(p.sku));singleOfferedSku=mentioned.length===1?mentioned[0].sku:'';if(m.body.startsWith('Encontré estos modelos en el catálogo:'))catalogOffer=m.body;
   const ack=m.body.match(/^Elegiste .+ \(código ([^\n]+)\)\. ¿Cuántas unidades quieres\?$/);if(ack)pick(ack[1]);
   continue;
  }
  if(m.direction!=='inbound')continue;
  const text=normal(m.body);if(isQuoteRequest(text))latestRequest=m.body;
  if(/\b(olvida|cancelar|cancela)\b|no quiero|no me interesa/.test(text)){selected.clear();pendingSku='';continue;}
  const direct=explicitSelectedProducts(text,products);
  if(!direct.length){const names=products.filter(p=>normal(p.name).trim()===text.trim());if(names.length===1)direct.push(names[0]);}
  if(direct.length===1){const qty=selectedQuantity(text,direct[0].sku);const previous=[...selected.values()].find(p=>p.sku===direct[0].sku);pick(direct[0].sku,qty??previous?.quantity??1,qty!==null||Boolean(previous?.confirmed));continue;}
  const reference=/\b(?:mismas?|mismos?|estas?|estos?|esas?|esos?)\b/.test(text);
  if(reference&&singleOfferedSku){const qty=selectedQuantity(text,singleOfferedSku);const previous=[...selected.values()].find(p=>p.sku===singleOfferedSku);pick(singleOfferedSku,qty??previous?.quantity??1,qty!==null||Boolean(previous?.confirmed));}
  const requestedQuantity=selectedQuantity(text);
  if(selected.size===1&&requestedQuantity!==null&&/(?:unidades?|unidad|piezas?)\b/.test(text)){pick([...selected.values()][0].sku,requestedQuantity,true);continue;}
  const option=text.match(/\b(?:numero|opcion|modelo|producto)\s*(\d{1,2})\b/)||text.match(/\b(?:prefiero|elijo|quiero)\s+(?:la|el)\s+(\d{1,2})\b/)||text.match(/^\s*(\d{1,2})[.!?\s]*$/);
  if(option&&catalogOffer.startsWith('Encontré estos modelos en el catálogo:')){
   const entries=[...catalogOffer.matchAll(/(?:^|\n)(\d+)\. [^\n]+\nCódigo: ([^\n]+)/g)].filter(p=>Number(p[1])===Number(option[1]));if(entries.length===1){const rest=text.replace(option[0],'');const q=rest.match(/\b(?:las|los|esas|esos)\s+([1-9]\d{0,3})\s+unidades?\b/);pick(entries[0][2].trim(),q?Number(q[1]):1,Boolean(q));}
  }else if(catalogOffer.startsWith('Encontré estos modelos en el catálogo:')&&[...catalogOffer.matchAll(/(?:^|\n)(\d+)\. [^\n]+\nCódigo: ([^\n]+)/g)].some(entry=>normal(entry[2].trim())===text.trim())){
   pick(m.body.trim());
  }else if(pendingSku&&/¿Cuántas unidades quieres\?/.test(offer)){
   const qty=selectedQuantity(text);
   if(qty)pick(pendingSku,qty,true);
  }
 }
 const unresolved:string[]=[];
 for(const m of normal(latestRequest).matchAll(/([1-9]\d{0,3})\s+soportes?\s+(?:de\s+)?(muro|techo)/g)){
  const key=m[2],quantity=Number(m[1]),chosen=selected.get(key);
  if(chosen){selected.set(key,{...chosen,quantity,confirmed:true});continue;}
  const options=products.filter(p=>family(p.name)===key);
  if(options.length===1)selected.set(key,{sku:options[0].sku,name:options[0].name,quantity,confirmed:true});else unresolved.push(`${quantity} soporte(s) de ${key}: falta confirmar el modelo exacto.`);
 }
 const requestedFamilies=[...normal(latestRequest).matchAll(/soportes?\s+(?:de\s+)?(muro|techo)/g)].map(m=>m[1]);
 const requestWords=(normal(latestRequest).split(/\b(?:rut|\d{1,2}\.?\d{3}\.?\d{3}-[\dk])\b/)[0].match(/[a-z]+/g)||[]).filter(w=>!new Set('quiero necesito puedes hacer hacerme una cotizacion formal cotizar cotizame cotiza cotices cotice coticen cotizas por para de el la los las y un con pdf presupuesto que me estas estos esas esos misma mismo mismas mismos aca te dejo datos'.split(' ')).has(w));
 const namedWords=requestWords.map(w=>w.endsWith('s')&&products.some(p=>words(p.name).includes(w.slice(0,-1)))?w.slice(0,-1):w);
 const knownWords=namedWords.filter(w=>products.some(p=>words(p.name).includes(w)));
 const chosen=[...selected.values()].filter(p=>!requestedFamilies.length||requestedFamilies.includes(family(p.name))).filter(p=>requestedFamilies.length||!knownWords.length||knownWords.every(w=>words(p.name).includes(w)));
 return {lines:chosen.map(({confirmed,...line})=>line),quantityConfirmed:chosen.length>0&&chosen.every(p=>p.confirmed),unresolved};
}
