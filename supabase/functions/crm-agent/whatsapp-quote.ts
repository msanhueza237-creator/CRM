import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { messageUuid } from '../_shared/direct-message.ts';
import { quoteParty, quoteTotals, type CrmQuote, type QuoteLine } from '../_shared/crm-quote.ts';
import { readWhatsAppProductEvidence } from './whatsapp-automation-preview.ts';
import { readLiveWhatsAppProduct } from './whatsapp-tiendanube-live.ts';
type Env=(names:string[])=>string;
export async function quoteCatalog(db:SupabaseClient,env:Env,search:string) {
 const products=await readWhatsAppProductEvidence(db,env(['WHATSAPP_STORE_CURRENCY']));
 const words=search.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().match(/[a-z0-9]+/g)||[];
 if(!words.length)return {products:[]};
 const matched=products.filter(p=>words.every(w=>(p.name+' '+p.sku).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().includes(w)));
 return {products:matched.slice(0,80).map(p=>({sku:p.sku,name:p.name})),more:matched.length>80};
}
export async function prepareCrmQuote(db:SupabaseClient,env:Env,payload:Record<string,unknown>,fetcher:typeof fetch=fetch):Promise<CrmQuote> {
 const id=String(payload.id||''),companyId=String(payload.companyId||'');
 if(!messageUuid.test(id)||!messageUuid.test(companyId))throw Error('Identificador de cotización o cliente inválido.');
 const {data:company,error}=await db.from('companies').select('id').eq('id',companyId).maybeSingle();
 if(error||!company)throw Error('No se encontró la ficha del cliente.');
 const issuer=quoteParty(payload.issuer),customer=quoteParty(payload.customer);
 const validDays=Number(payload.validDays);
 if(!Number.isSafeInteger(validDays)||validDays<1||validDays>90||typeof payload.pricesIncludeVat!=='boolean')throw Error('Confirma vigencia y tratamiento del IVA.');
 const sourceMessageId=String(payload.sourceMessageId||'');
 if(sourceMessageId&&!messageUuid.test(sourceMessageId))throw Error('Mensaje de origen inválido.');
 if(sourceMessageId){const source=await db.from('whatsapp_messages').select('id').eq('id',sourceMessageId).eq('company_id',companyId).maybeSingle();if(source.error||!source.data)throw Error('El mensaje de origen no pertenece a esta ficha.');}
 const logoDataUrl=String(payload.logoDataUrl||'');
 if(logoDataUrl && (!/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(logoDataUrl)||logoDataUrl.length>250000))throw Error('El logo debe ser PNG o JPG de hasta 180 KB.');
 if(logoDataUrl){const bytes=atob(logoDataUrl.split(',')[1]);const png=bytes.startsWith('\x89PNG\r\n\x1a\n'),jpeg=bytes.charCodeAt(0)===255&&bytes.charCodeAt(1)===216&&bytes.charCodeAt(2)===255;if(!png&&!jpeg)throw Error('El logo debe ser una imagen PNG o JPG válida.');}
 const requested=Array.isArray(payload.lines)?payload.lines as Array<Record<string,unknown>>:[];
 if(!requested.length||requested.length>20)throw Error('Agrega entre 1 y 20 productos.');
 if(new Set(requested.map(p=>p.sku)).size!==requested.length)throw Error('Agrupa cantidades del mismo código en una sola línea.');
 if(env(['WHATSAPP_LIVE_CATALOG_ENABLED'])!=='true')throw Error('La lectura actual de Tiendanube no está habilitada.');
 const products=await readWhatsAppProductEvidence(db,'CLP'),lines:QuoteLine[]=[];
 // Sequential bounded reads avoid bursts against the store provider.
 for(const item of requested){
  const candidates=products.filter(p=>p.sku===item.sku),quantity=Number(item.quantity);
  if(candidates.length!==1)throw Error('Selecciona un código de producto único.');
  if(!Number.isSafeInteger(quantity)||quantity<1||quantity>9999)throw Error('Cantidad inválida.');
  const live=await readLiveWhatsAppProduct(candidates[0],env,fetcher);
  if(!live||live.price===null||!Number.isFinite(live.price)||live.currency!=='CLP')throw Error('No se pudo confirmar el precio actual del producto.');
  if(live.stock===null||!Number.isSafeInteger(live.stock)||live.stock<quantity)throw Error('No se pudo confirmar stock suficiente para la cantidad solicitada.');
  lines.push({sku:live.sku,name:live.name,quantity,unitPrice:live.price,amount:Math.round(live.price*quantity),productUrl:live.productUrl||''});
 }
 const totals=quoteTotals(lines,payload.pricesIncludeVat);
 return {kind:'crm_quote_v1',id,folio:'CRM-'+new Intl.DateTimeFormat('en-CA',{timeZone:'America/Santiago',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()).replaceAll('-','')+'-'+id.replaceAll('-','').toUpperCase(),date:new Date().toISOString(),validDays,issuer,customer,lines,pricesIncludeVat:payload.pricesIncludeVat,...totals,logoDataUrl,conditions:String(payload.conditions||'').trim().slice(0,1500),sourceMessageId,verifiedAt:new Date().toISOString()};
}
export async function registerCrmQuote(db:SupabaseClient,env:Env,userId:string,payload:Record<string,unknown>,fetcher:typeof fetch=fetch) {
 if(payload.confirm!==true)throw Error('Revisa la cotización antes de registrarla.');
 const id=String(payload.id||''),companyId=String(payload.companyId||'');
 if(!messageUuid.test(id)||!messageUuid.test(companyId))throw Error('Identificador inválido.');
 const existing=await db.from('interactions').select('company_id,result,type').eq('id',id).maybeSingle();
 if(existing.error)throw Error('No se pudo verificar el registro previo.');
 if(existing.data){if(existing.data.company_id!==companyId||existing.data.type!=='cotizacion')throw Error('Identificador ya utilizado.');return {quote:JSON.parse(existing.data.result),alreadyRegistered:true};}
 const quote=await prepareCrmQuote(db,env,payload,fetcher);
 const expected=payload.expected as CrmQuote|undefined;
 if(!expected||JSON.stringify([expected.issuer,expected.customer,expected.lines,expected.validDays,expected.pricesIncludeVat,expected.conditions,expected.logoDataUrl])!==JSON.stringify([quote.issuer,quote.customer,quote.lines,quote.validDays,quote.pricesIncludeVat,quote.conditions,quote.logoDataUrl]))throw Error('Los datos o precios cambiaron. Vuelve a preparar y revisar la cotización.');
 const {error}=await db.from('interactions').insert({id,company_id:companyId,type:'cotizacion',owner_id:userId,description:`Cotización ${quote.folio} · ${quote.customer.name} · $${quote.total.toLocaleString('es-CL')} CLP · ${quote.lines.map(l=>`${l.quantity} x ${l.name} (${l.sku})`).join('; ')}`,result:JSON.stringify(quote),occurred_at:quote.date});
 if(error)throw Error('No se pudo registrar la cotización. Reintenta con el mismo identificador.');
 return {quote,alreadyRegistered:false};
}
