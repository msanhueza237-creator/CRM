import {metaMessage} from '../_shared/whatsapp-content.ts';
import type {SupabaseClient} from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import {currentQuoteSession} from '../_shared/whatsapp-quote-flow.ts';
import {decryptApiKey} from '../prospecting-integrations/deepseek.ts';
import {analyzeWhatsAppMedia,type MediaAnalysis} from './whatsapp-media-analysis.ts';
import {planWhatsAppAutomation,suggestWhatsAppProducts,resolveWhatsAppProductReferences,type ProductEvidence} from './whatsapp-automation-plan.ts';
type Env=(names:string[])=>string;
type Message={id:string;direction:string;body:string;type:string;status:string;occurredAt:string};
type Incoming={id:string;direction:string;phone_number:string;meta_message_id:string;raw_payload:unknown;occurred_at:string};
export async function interpretConversationImage(db:SupabaseClient,env:Env,messages:Message[],incoming:Incoming,companyId:string,phone:string,phoneId:string,products:ProductEvidence[],provider:'deepseek'|'openai',fetcher:typeof fetch=fetch):Promise<MediaAnalysis|null>{
 const session=currentQuoteSession(messages.filter(m=>Date.parse(m.occurredAt)<=Date.parse(incoming.occurred_at))) as Message[];
 const sourceIsImage=metaMessage(incoming.raw_payload,incoming.meta_message_id)?.message.type==='image';
 const image=session.filter(m=>m.direction==='inbound'&&(m.type==='image'||sourceIsImage&&m.id===incoming.id)).at(-1);
 if(!image)return null;
 const {data:photo,error}=await db.from('whatsapp_messages').select('id,direction,phone_number,meta_message_id,raw_payload,occurred_at').eq('id',image.id).eq('company_id',companyId).eq('direction','inbound').in('phone_number',[phone,`+${phone}`]).maybeSingle();
 if(error)throw Error('image_context_unavailable');
 if(!photo||planWhatsAppAutomation({incoming:photo,phoneNumberId:phoneId,products,optedOut:false,humanTakeover:false}).reason!=='visual_identification_required')return null;
 return analyzeWhatsAppMedia(photo,env,fetcher,async()=>{
  const {data:integration,error}=await db.from('prospecting_ai_integrations').select('status,models,api_key_encrypted').eq('provider','deepseek').limit(1).maybeSingle();
  if(error||integration?.status!=='verified'||!Array.isArray(integration.models)||!integration.models.includes('deepseek-flash')||!integration.api_key_encrypted)throw Error('deepseek_not_configured');
  return decryptApiKey(integration.api_key_encrypted,env(['PROSPECTING_SECRET_ENCRYPTION_KEY']));
 },provider,session.slice(-16).map(m=>({...m,body:m.type==='image'?m.id===image.id?'[Imagen analizada adjunta]':'[Otra imagen no visible en esta consulta]':m.body})));
}
export function imageCatalogRequests(analysis:MediaAnalysis,products:ProductEvidence[]){
 return (analysis.requests||[{query:analysis.text,quantity:null}]).map(request=>({ ...request,products:(resolveWhatsAppProductReferences(request.query,'',products).matches.length?resolveWhatsAppProductReferences(request.query,'',products).matches:suggestWhatsAppProducts(request.query,products))}));
}
export function visualQuoteSelection(analysis:MediaAnalysis,products:ProductEvidence[]){
 const requests=imageCatalogRequests(analysis,products),unresolved:string[]=[],lines:Array<{sku:string;name:string;quantity:number}>=[];
 for(const request of requests){if(request.products.length!==1){unresolved.push(`Confirma el modelo para ${request.query}.`);continue;}const p=request.products[0];if(lines.some(l=>l.sku===p.sku)){unresolved.push(`Confirma la cantidad total de ${p.name}.`);continue;}lines.push({sku:p.sku,name:p.name,quantity:request.quantity||1});}
 return {lines,quantityConfirmed:requests.length>0&&requests.every(r=>r.quantity!==null)&&!unresolved.length,unresolved};
}
