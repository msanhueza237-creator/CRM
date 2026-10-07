export type TemplateBinding = { key: string; field: string; example: string };
export type TemplateDraft = { internalName: string; name: string; language: string; category: string; header: string; body: string; footer: string; description: string; bindings: TemplateBinding[]; buttons: Array<{ type: string; text: string; value?: string }>; purposeConfirmed?: boolean };
export type TemplatePolicy = { revision: string; verifiedAt: string; graphVersion: string; categories: string[]; languages: string[]; limits: Record<string, number>; source: string };

// Registry keys are data bindings, never SQL expressions or arbitrary column names.
export const templateVariableFields = ["manual", "nombre_cliente", "empresa", "numero_documento", "numero_factura", "numero_cotizacion", "numero_pedido", "fecha_vencimiento", "monto", "numero_despacho", "transportista", "tracking", "nombre_vendedor", "producto"];

export function validateTemplatePolicy(value: unknown): TemplatePolicy {
  const p = value as TemplatePolicy;
  if (!p || !/^v\d+\.0$/.test(p.graphVersion) || !p.revision || !Number.isFinite(Date.parse(p.verifiedAt)) ||
    !p.source?.startsWith("https://developers.facebook.com/") || !Array.isArray(p.categories) || !p.categories.length ||
    p.categories.some(v => !/^[A-Z_]{2,40}$/.test(v)) || !Array.isArray(p.languages) || !p.languages.length || p.languages.some(v => !/^[a-z]{2,3}(_[A-Z]{2})?$/.test(v)) ||
    ["name", "body", "header", "footer", "buttonText", "buttons", "urlButtons", "phoneButtons"].some(k => !Number.isSafeInteger(p.limits?.[k]) || p.limits[k] < 1 || p.limits[k] > 10000)) throw new Error("Configuración de reglas Meta inválida.");
  return p;
}

export function compileTemplateDraft(value: unknown, policy: TemplatePolicy, submitting = false) {
  const d = value as TemplateDraft;
  if (!d || typeof d !== "object") throw new Error("Borrador no válido.");
  for (const key of ["internalName","name","language","category","header","body","footer","description"] as const) if (typeof d[key] !== "string") throw new Error(`Falta ${key}.`);
  if (!d.internalName.trim() || d.internalName.length > 200 || !/^[a-z0-9_]+$/.test(d.name) || d.name.length > policy.limits.name) throw new Error("Usa nombre interno y nombre Meta con minúsculas, números o guiones bajos.");
  if (!policy.categories.includes(d.category) || !policy.languages.includes(d.language)) throw new Error("Categoría o idioma fuera de la configuración Meta vigente.");
  if (!d.body.trim() || d.body.length > policy.limits.body || d.header.length > policy.limits.header || d.footer.length > policy.limits.footer || d.description.length > 2000) throw new Error("El contenido supera los límites de la plantilla.");
  if (d.category === "AUTHENTICATION") throw new Error("Autenticación requiere un flujo OTP verificado. No se puede presentar un texto comercial como AUTHENTICATION.");
  if (d.category !== "MARKETING" && d.category !== "UTILITY") throw new Error("Esta categoría requiere revisar su formato oficial antes de habilitarla.");
  if (submitting && d.purposeConfirmed !== true) throw new Error("Confirma la finalidad y categoría de la plantilla antes de enviarla a Meta.");
  const keys = [...new Set([...d.body.matchAll(/{{\s*(\d+)\s*}}/g)].map(m => m[1]))].sort((a,b) => +a - +b);
  if (keys.some((key,i) => key !== String(i+1)) || /[{}]/.test(d.body.replace(/{{\s*\d+\s*}}/g,"")) || /{{/.test(d.header+d.footer)) throw new Error("Las variables del cuerpo deben ser consecutivas: {{1}}, {{2}}. Encabezado y pie usan texto fijo.");
  if (keys.length && (/^\s*{{/.test(d.body) || /}}\s*$/.test(d.body) || /}}\s*{{/.test(d.body))) throw new Error("Rodea cada variable de texto descriptivo; no las dejes juntas ni al inicio o final.");
  if (!Array.isArray(d.bindings) || d.bindings.length !== keys.length || new Set(d.bindings.map(b=>b.key)).size !== keys.length || d.bindings.some(b=>!keys.includes(b.key) || !templateVariableFields.includes(b.field) || typeof b.example !== "string" || !b.example.trim() || b.example.length>1024)) throw new Error("Completa el vínculo y un ejemplo ficticio de cada variable.");
  if (!Array.isArray(d.buttons) || d.buttons.length > policy.limits.buttons) throw new Error("Revisa la cantidad de botones.");
  if (d.buttons.filter(b=>b.type==="URL").length>policy.limits.urlButtons || d.buttons.filter(b=>b.type==="PHONE_NUMBER").length>policy.limits.phoneButtons) throw new Error("Se excede el límite de botones de enlace o teléfono.");
  const groups = d.buttons.map(b=>b.type==="QUICK_REPLY"?"Q":"C").join("");
  if (/QCQ|CQC/.test(groups.replace(/Q+/g,"Q").replace(/C+/g,"C"))) throw new Error("Agrupa los botones de respuesta rápida, sin intercalarlos con enlaces.");
  const buttons = d.buttons.map(b=>{
    if (!["QUICK_REPLY","URL","PHONE_NUMBER"].includes(b.type) || !b.text?.trim() || b.text.length>policy.limits.buttonText || /[{}]/.test(b.text)) throw new Error("Botón no válido.");
    if (b.type==="URL") { let url: URL; try { url=new URL(b.value || ""); } catch { throw new Error("El enlace del botón no es válido."); } if(url.protocol!=="https:" || url.username || url.password || /[{}]/.test(b.value || "") || (b.value || "").length>2000) throw new Error("Usa un enlace HTTPS fijo sin credenciales."); return {type:b.type,text:b.text,url:url.href}; }
    if (b.type==="PHONE_NUMBER") { if(!/^\+?[1-9]\d{7,14}$/.test(b.value || "")) throw new Error("Teléfono del botón no válido."); return {type:b.type,text:b.text,phone_number:b.value}; }
    return {type:b.type,text:b.text};
  });
  const components: Record<string,unknown>[]=[];
  if(d.header) components.push({type:"HEADER",format:"TEXT",text:d.header});
  components.push({type:"BODY",text:d.body,...(keys.length?{example:{body_text:[keys.map(key=>d.bindings.find(b=>b.key===key)!.example)]}}:{})});
  if(d.footer) components.push({type:"FOOTER",text:d.footer});
  if(buttons.length) components.push({type:"BUTTONS",buttons});
  return {name:d.name,language:d.language,category:d.category,parameter_format:"POSITIONAL",components};
}

export function resolveTemplateValues(bindings: TemplateBinding[], context: Record<string,string>, supplied: unknown) {
  const values = supplied && typeof supplied === "object" && !Array.isArray(supplied) ? supplied as Record<string,unknown> : {};
  return bindings.map(binding=>{
    if (!templateVariableFields.includes(binding.field)) throw new Error("Vínculo de variable desconocido.");
    const value = ["nombre_cliente","empresa","nombre_vendedor"].includes(binding.field) ? context[binding.field] : values[binding.key];
    if(typeof value!=="string" || !value.trim() || value.length>1024 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new Error(`Completa la variable ${binding.key} (${binding.field}).`);
    return value.trim();
  });
}
