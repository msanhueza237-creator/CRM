import { decryptApiKey } from '../prospecting-integrations/deepseek.ts';
import { analyzeWhatsAppMedia, mediaAsText, type MediaAnalysis } from './whatsapp-media-analysis.ts';
import { currentQuoteSession, customerFromQuoteMessages, quoteCustomerMissing, wantsFormalQuote } from '../_shared/whatsapp-quote-flow.ts';
import { deriveQuoteLines, explicitSelectedProducts, selectedQuantity } from '../_shared/whatsapp-quote-context.ts';
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { messageUuid } from "../_shared/direct-message.ts";
import { metaMessage, whatsappPhone } from "../_shared/whatsapp-content.ts";
import { getWhatsAppConfig } from "./whatsapp-dispatch.ts";
import { getWhatsAppConversation } from "./whatsapp-conversation.ts";
import { planWhatsAppAutomation, resolveWhatsAppProductReferences, suggestWhatsAppProducts, purchaseQuantityContext, type ProductEvidence } from "./whatsapp-automation-plan.ts";

import { readLiveWhatsAppProduct } from "./whatsapp-tiendanube-live.ts";

type Env = (names: string[]) => string;
type Row = Record<string, unknown>;
const number = (v: unknown): number | null => {
  if ((typeof v !== "number" && typeof v !== "string") || String(v).trim() === "") return null;
  const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : null;
};

// Reads only the existing synchronized catalog. Missing currency is not guessed.
export async function readWhatsAppProductEvidence(db: SupabaseClient, currency: string): Promise<ProductEvidence[]> {
  const products: ProductEvidence[] = [];
  for (let offset = 0; offset < 10000; offset += 500) {
    const { data, error } = await db.from("content_products")
      .select("name,description_text,category,brand,external_id,product_url,variants,last_synced_at,source_updated_at")
      .eq("source_provider", "tiendanube").eq("source_status", "active").eq("paused", false)
      .eq("sync_status", "synced").order("id").range(offset, offset + 499);
    if (error) throw new Error("No se pudo consultar el catálogo sincronizado de Tiendanube.");
    for (const row of data || []) {
      const variants: Row[] = Array.isArray(row.variants) ? row.variants.filter((v: unknown) => v && typeof v === "object" && !Array.isArray(v)) : [];
      // Product-level minimum price/aggregate stock cannot represent a variant.
      for (const variant of variants) {
        const sku = typeof variant.sku === "string" ? variant.sku.trim() : "";
        if (!sku) continue;
        products.push({ productId: typeof row.external_id === "string" ? row.external_id : "", productUrl: typeof row.product_url === "string" ? row.product_url : "",
          variantId: typeof variant.id === "string" || typeof variant.id === "number" ? String(variant.id) : "", source: "tiendanube", sku, name: String(row.name || ""), description:String(row.description_text||''), category:String(row.category||''), brand:String(row.brand||''), currency,
          price: variant.promotional_price != null && variant.promotional_price !== "" ? number(variant.promotional_price) : number(variant.price),
          stock: variant.stock_management === false ? null : number(variant.stock), published: true,
          verifiedAt: typeof row.last_synced_at === "string" && typeof row.source_updated_at === "string"
            && Number.isFinite(Date.parse(row.last_synced_at)) && Number.isFinite(Date.parse(row.source_updated_at))
            ? (Date.parse(row.source_updated_at) < Date.parse(row.last_synced_at) ? row.source_updated_at : row.last_synced_at) : "" });
      }
    }
    if ((data?.length || 0) < 500) return products;
  }
  throw new Error("El catálogo excede el límite de revisión; no se seleccionará un producto de una lista incompleta.");
}

export async function previewWhatsAppAutomation(db: SupabaseClient, env: Env, query: URLSearchParams, fetcher: typeof fetch = fetch) {
  const companyId = query.get("companyId") || "", contactId = query.get("contactId") || "";
  const phone = whatsappPhone(query.get("phone"));
  if (!messageUuid.test(companyId) || (contactId && !messageUuid.test(contactId)) || !/^[1-9]\d{7,14}$/.test(phone))
    throw new Error("Selecciona una conversación vinculada válida.");
  const conversation = await getWhatsAppConversation(db, env, companyId, phone, 0, contactId);
  if (!conversation.canReply) return { messageId: null, plan: { action: "ignore", reason: "conversation_blocked", text: null, requires: "none", source: null, canSend: false } };
  let { data: incoming, error } = await db.from("whatsapp_messages")
    .select("id,direction,phone_number,meta_message_id,raw_payload,occurred_at")
    .eq("company_id", companyId).eq("direction", "inbound").in("phone_number", [phone, `+${phone}`])
    .order("occurred_at", { ascending: false }).order("id", { ascending: false }).limit(1).maybeSingle();
  if (error || !incoming) throw new Error("No se pudo leer el último mensaje entrante.");
  if (conversation.lastOutboundAt && Date.parse(conversation.lastOutboundAt) >= Date.parse(incoming.occurred_at))
    return { messageId: incoming.id, plan: { action: "ignore", reason: "already_answered", text: null, requires: "none", source: null, canSend: false } };
  const currency = env(["WHATSAPP_STORE_CURRENCY"]).trim().toUpperCase();
  const { phoneId: configPhone } = await getWhatsAppConfig(db, env);
  const products = await readWhatsAppProductEvidence(db, currency);
  const imageProvider=query.get("imageProvider")||"deepseek";
  if(!["deepseek","openai"].includes(imageProvider))throw Error("Proveedor de imágenes no disponible.");
  let mediaAnalysis:MediaAnalysis|null=null;
  const initial=planWhatsAppAutomation({incoming,phoneNumberId:configPhone,products,optedOut:false,humanTakeover:false});
  if(['transcription_required','visual_identification_required'].includes(initial.reason)){
    try{mediaAnalysis=await analyzeWhatsAppMedia(incoming,env,fetcher,async()=>{
      const {data:integration,error}=await db.from("prospecting_ai_integrations").select("status,models,api_key_encrypted").eq("provider","deepseek").limit(1).maybeSingle();
      if(error||integration?.status!=="verified"||!Array.isArray(integration.models)||!integration.models.includes("deepseek-flash")||!integration.api_key_encrypted)throw Error("deepseek_not_configured");
      return decryptApiKey(integration.api_key_encrypted,env(["PROSPECTING_SECRET_ENCRYPTION_KEY"]));
    },imageProvider as "deepseek"|"openai");if(!mediaAnalysis||mediaAnalysis.needsClarification)return {messageId:incoming.id,plan:{action:'clarify',reason:'media_clarification_required',text:'No puedo identificar con seguridad el producto de la imagen. ¿Puedes indicar su nombre, modelo o enviar una foto de la etiqueta?',requires:'vision',source:null,canSend:false},mediaAnalysis};
      incoming={...incoming,...mediaAsText(incoming,mediaAnalysis.text)};
    }catch{return {messageId:incoming.id,plan:{action:'handoff',reason:'media_analysis_unavailable',text:'No pude interpretar el archivo. Indica el producto por texto o envía un archivo más claro.',requires:initial.requires,source:null,canSend:false}};}
  }
  // Keep the last catalogue across clarification messages, within this customer session.
  const offerSession=currentQuoteSession(conversation.messages.filter(m=>Date.parse(m.occurredAt)<Date.parse(incoming.occurred_at)));
  const sent=offerSession.filter(m=>m.direction==='outbound'&&['accepted','sent','delivered','read'].includes(String(m.status)));
  const previous=sent.at(-1);
  const latestBody=String(metaMessage(incoming.raw_payload,incoming.meta_message_id)?.message.text?.body||'');
  const latestNormal=latestBody.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();
  const catalogue=[...sent].reverse().find(m=>m.body.startsWith('Encontré estos modelos en el catálogo:'));
  const choiceReply=/\b(?:numero|opcion|modelo|producto)\s*(?:n[°º.]?\s*)?\d{1,2}\b/.test(latestNormal)||/^\d{1,2}[.!?\s]*$/.test(latestNormal)||Boolean(catalogue&&[...catalogue.body.matchAll(/\nCódigo: ([^\n]+)/g)].some(m=>m[1].trim().toLowerCase()===latestNormal));
  const quantityPrompt=previous&&/^Elegiste .+ \(código [^\n]+\)\. ¿Cuántas unidades quieres\?$/.test(previous.body);
  const directProducts=explicitSelectedProducts(latestBody,products).filter(p=>p.published&&p.source==='tiendanube');
  const directQuantity=directProducts.length===1?selectedQuantity(latestBody,directProducts[0].sku):null;
  const previousOffer=directProducts.length===1&&directQuantity!==null?`Elegiste ${directProducts[0].name} (código ${directProducts[0].sku}). ¿Cuántas unidades quieres?`:directProducts.length===1?`Encontré estos modelos en el catálogo:\n\n1. ${directProducts[0].name}\nCódigo: ${directProducts[0].sku}`:String((choiceReply&&!(quantityPrompt&&/^\d{1,2}[.!?\s]*$/.test(latestNormal))&&catalogue?catalogue:previous)?.body||'').slice(0,4096);
  const input = { previousOffer, incoming, phoneNumberId: configPhone, products, optedOut: false, humanTakeover: false };
  let plan = planWhatsAppAutomation(input);
  if(['purchase_quantity_required','selection_stock_required','selection_no_stock'].includes(plan.reason)){
    const body=String(metaMessage(incoming.raw_payload,incoming.meta_message_id)?.message.text?.body||'');
    const option=body.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().match(/(?:numero|opcion|modelo|producto)\s*(\d{1,2})|^\s*(\d{1,2})[.!?\s]*$/);
    const entry=[...previousOffer.matchAll(/(?:^|\n)(\d+)\. [^\n]+\nCódigo: ([^\n]+)/g)].find(m=>option?Number(m[1])===Number(option?.[1]||option?.[2]):body.toLowerCase().trim().replace(/[.!?]+$/,'').trim().replace(/^(?:quiero|elijo|me interesa|modelo|producto)\s+/,'')===m[2].trim().toLowerCase());
    const selected=entry?products.filter(p=>p.sku===entry[2].trim()):[];
    if(selected.length===1&&env(['WHATSAPP_LIVE_CATALOG_ENABLED'])==='true'){
      try{const live=await readLiveWhatsAppProduct(selected[0],env,fetcher);plan=live?planWhatsAppAutomation({...input,products:[live]}):{action:'handoff',reason:'live_catalog_unavailable',text:null,requires:'product',source:null,canSend:false};}
      catch{plan={action:'handoff',reason:'live_catalog_unavailable',text:null,requires:'product',source:null,canSend:false};}
    }
  }
  const quantityMessage = metaMessage(incoming.raw_payload, incoming.meta_message_id)?.message;
  const purchase = purchaseQuantityContext(String(quantityMessage?.text?.body || ""), previousOffer);
  if (purchase && ["purchase_data_required", "purchase_summary", "purchase_insufficient_stock"].includes(plan.reason)) {
    const candidates = products.filter(p => p.sku === purchase.sku);
    try {
      if (candidates.length !== 1 || env(["WHATSAPP_LIVE_CATALOG_ENABLED"]) !== "true") throw new Error("live_required");
      const live = await readLiveWhatsAppProduct(candidates[0], env, fetcher);
      plan = live ? planWhatsAppAutomation({ ...input, products: [live] }) :
        { action: "handoff", reason: "product_no_longer_available", text: null, requires: "product", source: null, canSend: false };
    } catch {
      plan = { action: "handoff", reason: "live_catalog_unavailable", text: null, requires: "product", source: null, canSend: false };
    }
  }
  if (env(["WHATSAPP_LIVE_CATALOG_ENABLED"]) === "true" &&
      (plan.reason === "verified_product_answer" || plan.reason === "stale_product_evidence" || plan.reason === "incomplete_product_evidence")) {
    const message = metaMessage(incoming.raw_payload, incoming.meta_message_id)?.message;
    const candidates = resolveWhatsAppProductReferences(String(message?.text?.body || ""),
      String(message?.context?.referred_product?.product_retailer_id || ""), products).matches;
    if (candidates.length === 1) {
      try {
        const live = await readLiveWhatsAppProduct(candidates[0], env, fetcher);
        plan = live ? planWhatsAppAutomation({ ...input, products: [live] }) :
          { action: "handoff", reason: "product_no_longer_available", text: null, requires: "product", source: null, canSend: false };
      } catch {
        plan = { action: "handoff", reason: "live_catalog_unavailable", text: null, requires: "product", source: null, canSend: false };
      }
    }
  }
  if (plan.action === "clarify" && ["ambiguous_product", "product_reference_needed"].includes(plan.reason)) {
    const message = metaMessage(incoming.raw_payload, incoming.meta_message_id)?.message;
    const text = String(message?.text?.body || "");
    const matches = resolveWhatsAppProductReferences(text,
      String(message?.context?.referred_product?.product_retailer_id || ""), products).matches;
    const candidates = (matches.length ? matches : suggestWhatsAppProducts(text, products)).slice(0, 6);
    if (candidates.length && env(["WHATSAPP_LIVE_CATALOG_ENABLED"]) === "true") {
      try {
        const live = (await Promise.all(candidates.map(p => readLiveWhatsAppProduct(p, env, fetcher))))
          .filter((p): p is ProductEvidence => p !== null);
        plan = planWhatsAppAutomation({ ...input, products: live });
      } catch {
        plan = { action: "handoff", reason: "live_catalog_unavailable", text: null, requires: "product", source: null, canSend: false };
      }
    } else if (candidates.length) {
      plan = planWhatsAppAutomation({ ...input, products: products.map(p => ({ ...p, productUrl: "" })) });
    }
  }
  const session=currentQuoteSession(conversation.messages.filter(m=>Date.parse(m.occurredAt)<=Date.parse(incoming.occurred_at)));
  const formalRequested=session.some(m=>m.direction==='inbound'&&wantsFormalQuote(m.body));
  const selectionInSession=deriveQuoteLines(session,products);
  const latestText=String(metaMessage(incoming.raw_payload,incoming.meta_message_id)?.message.text?.body||'');
  const typedCode=latestText.match(/\b[A-Za-z]{1,8}-\d{3,8}\b/)?.[0];
  const codeMismatch=Boolean(typedCode&&!products.some(p=>p.sku.toLowerCase()===typedCode.toLowerCase()));
  if(codeMismatch){
    const chosen=selectionInSession.lines;
    plan={action:'clarify',reason:'unknown_product_code',text:chosen.length===1?`El código ${typedCode} no aparece en el catálogo. La opción que elegiste es ${chosen[0].name}, código ${chosen[0].sku}, por ${chosen[0].quantity} unidad(es). ¿Confirmas ese modelo y cantidad?`: `El código ${typedCode} no aparece en el catálogo. Confirma el código tal como aparece en la lista para consultar su stock y precio.`,requires:'product',source:'tiendanube',canSend:false};
  }
  if(!codeMismatch&&formalRequested&&(['formal_quote_required','complex_question','purchase_summary'].includes(plan.reason)||(wantsFormalQuote(latestText)&&selectionInSession.lines.length>0&&['product_reference_needed','ambiguous_product','verified_product_answer'].includes(plan.reason)))){
    const selected=selectionInSession,customer=customerFromQuoteMessages(session),missing=quoteCustomerMissing(customer);
    const response=(!selected.lines.length||selected.unresolved.length)?{reason:'quote_selection_required',text:'Para preparar la cotización formal, primero elige el modelo de la lista o envíame su código. Después confirmaremos la cantidad y el stock.'}
      :!selected.quantityConfirmed?{reason:'quote_quantity_required',text:'¿Cuántas unidades del modelo elegido necesitas para la cotización formal?'}
      :missing.length?{reason:'quote_customer_data_required',text:`Para preparar tu cotización formal, envíame ${missing.join(', ')}. Puedes enviarlos así:\nRUT:\nNombre o razón social:\nDirección:\nComuna:`}
      :{reason:'formal_quote_ready',text:'¡Perfecto! Ya tenemos los modelos, cantidades y tus datos. Podemos preparar tu cotización formal en PDF; revisaremos nuevamente los precios y el stock antes de guardarla.'};
    plan={action:'draft',...response,requires:'facto_quote',source:null,canSend:false};
    if(response.reason==='formal_quote_ready'){
      if(env(['WHATSAPP_LIVE_CATALOG_ENABLED'])!=='true')plan={action:'handoff',reason:'live_catalog_unavailable',text:null,requires:'product',source:null,canSend:false};
      else try{
        for(const line of selected.lines){
          const evidence=products.filter(p=>p.sku===line.sku);
          const live=evidence.length===1?await readLiveWhatsAppProduct(evidence[0],env,fetcher):null;
          if(!live||live.currency!=='CLP'||live.price===null||live.stock===null||!Number.isSafeInteger(live.stock)){plan={action:'handoff',reason:'live_catalog_unavailable',text:null,requires:'product',source:null,canSend:false};break;}
          if(live.stock===0){plan={action:'clarify',reason:'quote_stock_unavailable',text:`${line.name} (${line.sku}) está sin stock. No podemos cotizar unidades disponibles de este modelo.`,requires:'product',source:'tiendanube',canSend:false};break;}
          if(live.stock<line.quantity)plan={action:'draft',reason:'formal_quote_ready',text:`Solicitaste ${line.quantity} unidades de ${line.name} (${line.sku}), pero hay ${live.stock} disponibles. Preparamos la cotización formal por las ${live.stock} unidades en stock.`,requires:'facto_quote',source:'tiendanube',canSend:false};
        }
      }catch{plan={action:'handoff',reason:'live_catalog_unavailable',text:null,requires:'product',source:null,canSend:false};}
    }
  }
  return { messageId: incoming.id, plan, mediaAnalysis };
}
