import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { getWhatsAppConfig } from "./whatsapp-dispatch.ts";
import { describeMetaTemplate, whatsappDispatchId } from "./whatsapp-meta.ts";
import { metaFunctionalError, redactMeta, templateWebhookFields } from "./whatsapp-policy.ts";
import { compileTemplateDraft, validateTemplatePolicy, templateVariableFields } from "./whatsapp-template-model.ts";
// Supabase's existing ungenerated JSON rows are validated at each API boundary.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
type Env = (names: string[]) => string;
const templateFields = "id,internal_name,meta_template_name,language,category,preview_body,components,variable_bindings,description,parameter_format,draft,local_state,status,meta_template_id,waba_id,rejected_reason,last_synced_at,meta_updated_at,created_at,updated_at,revision,active";

export async function whatsappAudit(db: SupabaseClient, actor: string | null, action: string, entity: string | null, metadata: unknown, secrets: string[] = []) {
  const {error}=await db.from("activity_logs").insert({actor_id:actor,entity_type:"whatsapp",entity_id:entity,action,metadata:redactMeta(metadata,secrets)});
  if(error) throw new Error("No se pudo registrar la auditoría WhatsApp.");
}

async function policyContext(db: SupabaseClient, env: Env) {
  const config=await getWhatsAppConfig(db,env);
  const {data,error}=await db.from("whatsapp_settings").select("id,management_policy").order("updated_at",{ascending:false}).limit(1).maybeSingle();
  if(error || !data) throw new Error("Falta actualizar la configuración de plantillas.");
  return {config,settings:data,policy:validateTemplatePolicy(data.management_policy)};
}

async function metaCall(config: {token:string;version:string}, path: string, request: typeof fetch, payload?: unknown) {
  const response=await request(`https://graph.facebook.com/${config.version}/${path}`,{method:payload?"POST":"GET",headers:{Authorization:`Bearer ${config.token}`,"Content-Type":"application/json"},...(payload?{body:JSON.stringify(payload)}:{}),signal:AbortSignal.timeout(15000)});
  const value=await response.json();
  if(!response.ok) { const error=new Error(metaFunctionalError(value)) as Error & {meta?:unknown;uncertain?:boolean};error.meta=redactMeta(value,[config.token]);error.uncertain=response.status>=500 || response.status===408;throw error; }
  return value;
}

export async function readMetaTemplateRecords(config: {token:string;version:string;wabaId:string}, request:typeof fetch=fetch) {
  const all: Row[]=[]; let cursor=""; const seen=new Set<string>();
  for(let page=0;page<60;page++) {
    const query=new URLSearchParams({fields:"id,name,language,status,category,components,parameter_format,rejected_reason,last_updated_time,quality_score",limit:"100",...(cursor?{after:cursor}:{})});
    const result=await metaCall(config,`${config.wabaId}/message_templates?${query}`,request);
    if(!Array.isArray(result.data)) throw new Error("Meta devolvió una lista incompleta.");
    all.push(...result.data);
    if(!result.paging?.next) return all;
    cursor=String(result.paging?.cursors?.after || "");
    if(!cursor || seen.has(cursor)) break; seen.add(cursor);
  }
  throw new Error("No se sincronizó una lista parcial de Meta.");
}

export async function syncWhatsAppTemplates(db: SupabaseClient,env:Env,actor:string|null,request:typeof fetch=fetch) {
  const {config}=await policyContext(db,env);
  const records=await readMetaTemplateRecords(config,request);
  const timestamp=new Date().toISOString();
  for(const record of records) {
    if(!/^\d+$/.test(String(record.id)) || !record.name || !record.language || !record.status) throw new Error("Meta devolvió una identidad de plantilla incompleta.");
    const {data:existing,error}=await db.from("whatsapp_templates").select("id,meta_template_id,draft,local_state,revision,variable_bindings").eq("waba_id",config.wabaId).eq("meta_template_name",record.name).eq("language",record.language).maybeSingle();
    if(error) throw new Error("No se pudo comparar la identidad local.");
    if(existing?.meta_template_id && existing.meta_template_id!==String(record.id)) throw new Error("Conflicto de identidad Meta. Revisa la plantilla antes de sincronizar.");
    const described=describeMetaTemplate(record);
    const patch:Row={meta_template_id:String(record.id),waba_id:config.wabaId,meta_template_name:record.name,language:record.language,category:record.category,status:record.status,
      components:record.components || [],parameter_format:record.parameter_format || "POSITIONAL",preview_body:described.body,variables:described.variables,
      rejected_reason:record.rejected_reason && record.rejected_reason!=="NONE"?record.rejected_reason:null,last_synced_at:timestamp,meta_updated_at:Number(record.last_updated_time)>0?new Date(Number(record.last_updated_time)*1000).toISOString():null,
      meta_snapshot:redactMeta(record,[config.token]),updated_at:timestamp};
    // Keep unsent edits separate from the authoritative Meta version.
    if(!existing?.draft && existing?.local_state!=="ARCHIVED") patch.local_state="SYNCED";
    if(existing?.draft && ["SUBMITTING","UNCERTAIN"].includes(existing.local_state)) {
      const expected=compileTemplateDraft(existing.draft,(await policyContext(db,env)).policy);
      const texts=(components:Row[])=>components.map(c=>({type:c.type,text:c.text,format:c.format,buttons:c.buttons}));
      if(JSON.stringify(texts(expected.components))===JSON.stringify(texts(record.components || []))) Object.assign(patch,{draft:null,local_state:"SYNCED",variable_bindings:existing.draft.bindings});
    }
    patch.revision=(existing?.revision || 0)+1;
    const result=existing?await db.from("whatsapp_templates").update(patch).eq("id",existing.id).eq("revision",existing.revision).select("id").single():await db.from("whatsapp_templates").insert({...patch,internal_name:record.name,local_state:"SYNCED",active:true});
    if(result.error) throw new Error("No se pudo guardar la sincronización. No se crearon duplicados deliberadamente.");
  }
  // A complete WABA listing can remove availability, never infer approval.
  const remoteIds=new Set(records.map(record=>String(record.id)));
  for(let offset=0;offset<10000;offset+=500) {
    const {data:local,error}=await db.from("whatsapp_templates").select("id,meta_template_id,revision,status").eq("waba_id",config.wabaId).not("meta_template_id","is",null).order("id").range(offset,offset+499);
    if(error) throw new Error("No se pudo verificar la lista local completa.");
    for(const row of local || []) if(!remoteIds.has(row.meta_template_id)) {
      const {error:writeError}=await db.from("whatsapp_templates").update({status:"UNAVAILABLE",last_synced_at:timestamp,updated_at:timestamp,revision:row.revision+1}).eq("id",row.id).eq("revision",row.revision).select("id").single();
      if(writeError) throw new Error("Una plantilla cambió durante la sincronización.");
    }
    if((local || []).length<500) break;
    if(offset===9500) throw new Error("La lista local requiere revisión; no se confirmó una sincronización parcial.");
  }
  await whatsappAudit(db,actor,"templates_synchronized",null,{wabaId:config.wabaId,count:records.length,at:timestamp});
  return {count:records.length,lastSyncedAt:timestamp};
}

export async function templateManagement(db:SupabaseClient,env:Env,actor:string,manage:boolean,operation:string,input:Row={},request:typeof fetch=fetch) {
  const {config,settings,policy}=await policyContext(db,env);
  if(operation==="list") {
    const templates:Row[]=[];
    for(let offset=0;offset<10000;offset+=500) {
      let query=db.from("whatsapp_templates").select(templateFields).eq("waba_id",config.wabaId).order("created_at",{ascending:false}).order("id");
      if(!manage) query=query.eq("status","APPROVED").eq("active",true).in("local_state",["SYNCED","DRAFT"]);
      const {data,error}=await query.range(offset,offset+499);
      if(error) throw new Error("No se pudieron leer las plantillas.");
      templates.push(...(data || []).map(row=>manage?row:{...row,draft:null,local_state:"SYNCED"}));
      if((data || []).length<500) break;
      if(offset===9500) throw new Error("La lista supera el límite de consulta; no se mostrará incompleta.");
    }
    return {templates,policy,variableFields:templateVariableFields,configuration:{wabaId:config.wabaId,phoneNumberId:config.phoneId,graphVersion:config.version,blockers:config.blockers,webhookFields:["messages",...templateWebhookFields]}};
  }
  if(!manage) throw new Error("Solo administradores activos pueden administrar plantillas y configuración.");
  if(operation==="sync") return await syncWhatsAppTemplates(db,env,actor,request);
  if(operation==="policy") {
    const next=validateTemplatePolicy(input.policy);
    await whatsappAudit(db,actor,"template_policy_changed",null,{previous:policy,next});
    const {error}=await db.from("whatsapp_settings").update({management_policy:next,updated_by:actor,updated_at:new Date().toISOString()}).eq("id",settings.id);
    if(error) throw new Error("No se pudo guardar la configuración."); return {ok:true};
  }
  let existing:Row|null=null;
  if(input.id) {
    const {data,error}=await db.from("whatsapp_templates").select("*").eq("id",input.id).eq("waba_id",config.wabaId).maybeSingle();
    if(error || !data) throw new Error("Plantilla no encontrada."); existing=data;
    if(Number(input.revision)!==data.revision) throw new Error("La plantilla cambió. Actualiza antes de continuar.");
  }
  if(operation==="save") {
    const payload=compileTemplateDraft(input.draft,policy);
    if(existing && ["SUBMITTING","UNCERTAIN"].includes(existing.local_state)) throw new Error("Sincroniza y revisa el envío anterior antes de editar.");
    if(existing?.meta_template_id && (payload.name!==existing.meta_template_name || payload.language!==existing.language)) throw new Error("Para cambiar nombre o idioma crea otro borrador.");
    const now=new Date().toISOString();
    const patch={waba_id:config.wabaId,internal_name:input.draft.internalName,meta_template_name:payload.name,language:payload.language,description:input.draft.description,
      draft:input.draft,...(!existing?.meta_template_id?{variable_bindings:input.draft.bindings}:{}),local_state:"DRAFT",updated_by:actor,updated_at:now,revision:(existing?.revision || 0)+1,
      ...(!existing?{category:payload.category,status:"DRAFT",preview_body:input.draft.body,created_by:actor}:{} )};
    const result=existing?await db.from("whatsapp_templates").update(patch).eq("id",existing.id).eq("revision",existing.revision).select("id").single():await db.from("whatsapp_templates").insert(patch).select("id").single();
    if(result.error) throw new Error("No se pudo guardar: nombre/idioma duplicado o edición concurrente.");
    await whatsappAudit(db,actor,"template_draft_saved",result.data.id,{draft:input.draft,revision:patch.revision});return {id:result.data.id};
  }
  if(!existing) throw new Error("Selecciona una plantilla.");
  if(operation==="archive") {
    if(["SUBMITTING","UNCERTAIN"].includes(existing.local_state)) throw new Error("Revisa primero el envío pendiente.");
    await whatsappAudit(db,actor,"template_archived_locally",existing.id,{metaId:existing.meta_template_id});
    const {error}=await db.from("whatsapp_templates").update({active:false,local_state:"ARCHIVED",revision:existing.revision+1,updated_at:new Date().toISOString()}).eq("id",existing.id).eq("revision",existing.revision);
    if(error) throw new Error("No se pudo archivar."); return {ok:true};
  }
  if(operation!=="submit" || input.confirmSubmit!==true || !existing.draft || existing.local_state!=="DRAFT" || !existing.active) throw new Error("Revisa y confirma el borrador antes de enviarlo a aprobación.");
  if(config.blockers.length) throw new Error(config.blockers.join(" "));
  if(policy.graphVersion!==config.version) throw new Error("La versión de reglas no coincide con META_GRAPH_API_VERSION. Revisión administrativa requerida.");
  const payload=compileTemplateDraft(existing.draft,policy,true);
  const current=await readMetaTemplateRecords(config,request);
  const remote=current.find(t=>t.name===payload.name && t.language===payload.language);
  if(!existing.meta_template_id && remote) throw new Error("Esta plantilla ya existe en Meta. Sincroniza primero; no se creará otra.");
  if(existing.meta_template_id && (!remote || String(remote.id)!==existing.meta_template_id || !["APPROVED","REJECTED"].includes(remote.status))) throw new Error("Meta no permite editar esta plantilla en su estado actual. Sincroniza primero.");
  const submission=crypto.randomUUID();
  const {data:locked,error:lockError}=await db.from("whatsapp_templates").update({local_state:"SUBMITTING",submission_id:submission,revision:existing.revision+1}).eq("id",existing.id).eq("revision",existing.revision).eq("local_state","DRAFT").select("id").maybeSingle();
  if(lockError || !locked) throw new Error("Otro usuario modificó o está enviando esta plantilla.");
  try { await whatsappAudit(db,actor,"template_submission_requested",existing.id,{submission,payload,graphVersion:config.version}); }
  catch(error) { await db.from("whatsapp_templates").update({local_state:"DRAFT"}).eq("id",existing.id).eq("submission_id",submission); throw error; }
  try {
    const result=await metaCall(config,existing.meta_template_id || `${config.wabaId}/message_templates`,request,existing.meta_template_id?{category:payload.category,components:payload.components,parameter_format:payload.parameter_format}:payload);
    if(!existing.meta_template_id && !/^\d+$/.test(String(result.id))) throw new Error("Respuesta Meta incierta.");
    const {error}=await db.from("whatsapp_templates").update({meta_template_id:existing.meta_template_id || String(result.id),status:result.status || "PENDING",category:result.category || payload.category,
      components:payload.components,variable_bindings:existing.draft.bindings,preview_body:existing.draft.body,draft:null,local_state:"SYNCED",last_synced_at:new Date().toISOString(),meta_snapshot:redactMeta(result,[config.token]),rejected_reason:null}).eq("id",existing.id).eq("submission_id",submission);
    if(error) throw new Error("Meta respondió pero el registro local requiere sincronización.");
    await whatsappAudit(db,actor,"template_submitted",existing.id,{submission,response:result},[config.token]);return {ok:true,status:result.status || "PENDING"};
  } catch(error) {
    const failure=error as Error & {meta?:unknown;uncertain?:boolean}; const uncertain=!failure.meta || failure.uncertain;
    await db.from("whatsapp_templates").update({local_state:uncertain?"UNCERTAIN":"DRAFT"}).eq("id",existing.id).eq("submission_id",submission);
    await whatsappAudit(db,actor,"template_submission_failed",existing.id,{submission,uncertain,error:failure.meta || failure.message},[config.token]);
    throw new Error(uncertain?"Resultado incierto. No repitas el envío; sincroniza y revisa Meta.":failure.message);
  }
}

export async function processTemplateWebhook(db:SupabaseClient,env:Env,payload:Row,request:typeof fetch=fetch) {
  if (!(payload.entry || []).some((entry:Row)=>(entry.changes || []).some((change:Row)=>templateWebhookFields.includes(change.field)))) return;
  const {config}=await policyContext(db,env);
  for(const entry of payload.entry || []) for(const change of entry.changes || []) {
    if(!templateWebhookFields.includes(change.field)) continue;
    if(String(entry.id)!==config.wabaId) throw new Error("WABA no coincide.");
    const key=await whatsappDispatchId("template-webhook",JSON.stringify({waba:entry.id,time:entry.time,field:change.field,value:change.value}));
    const {data:previous}=await db.from("whatsapp_webhook_events").select("processed").eq("event_key",key).maybeSingle();
    if(previous?.processed) continue;
    if(!previous) { const {error}=await db.from("whatsapp_webhook_events").insert({event_key:key,event_type:change.field,payload:redactMeta({entry:[entry]}),processed:false});if(error && error.code!=="23505") throw new Error("No se pudo guardar el evento Meta."); }
    // Fetch authoritative state; webhook delivery order is not guaranteed.
    await syncWhatsAppTemplates(db,env,null,request);
    const {error}=await db.from("whatsapp_webhook_events").update({processed:true,processing_error:null}).eq("event_key",key);
    if(error) throw new Error("No se pudo confirmar el evento de plantilla.");
  }
}
