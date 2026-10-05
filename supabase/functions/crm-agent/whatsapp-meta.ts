type Row = Record<string, unknown>;

export interface MetaTemplate {
  id: string;
  name: string;
  language: string;
  status: string;
  category: string;
  body: string;
  header: string;
  footer: string;
  variables: string[];
  named: boolean;
  catalogIndexes: number[];
  blockedReason: string | null;
}

function row(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}

export function describeMetaTemplate(value: unknown): MetaTemplate {
  const source = row(value);
  const components = Array.isArray(source.components) ? source.components.map(row) : [];
  const body = String(components.find((c) => c.type === "BODY")?.text || "");
  const variables = [...new Set([...body.matchAll(/{{\s*([^{}]+?)\s*}}/g)].map((m) => m[1]))];
  const named = source.parameter_format === "NAMED";
  if (!named) variables.sort((a, b) => Number(a) - Number(b));
  let blockedReason: string | null = null;
  const catalogIndexes: number[] = [];
  for (const component of components) {
    if (component.type === "BODY") continue;
    if (component.type === "HEADER" && component.format === "TEXT" && !String(component.text).includes("{{")) continue;
    if (component.type === "FOOTER" && !String(component.text).includes("{{")) continue;
    if (component.type === "BUTTONS" && Array.isArray(component.buttons)) {
      for (const [index, value] of component.buttons.entries()) {
        const button = row(value);
        if (button.type === "CATALOG") catalogIndexes.push(index);
        else if (!["URL", "PHONE_NUMBER"].includes(String(button.type)) || String(button.url || "").includes("{{")) {
          blockedReason = "Esta plantilla requiere configurar botones adicionales.";
        }
      }
    } else blockedReason = "Esta plantilla requiere configurar encabezados, medios o componentes adicionales.";
  }
  if (!body || !source.id || !source.name || !source.language) blockedReason = "Plantilla incompleta en Meta.";
  if (source.category === "AUTHENTICATION") blockedReason = "Las plantillas de autenticacion no se usan en campanas comerciales.";
  if (variables.some((v, i) => named ? !/^[a-z][a-z0-9_]*$/.test(v) : v !== String(i + 1))) {
    blockedReason = "Las variables de esta plantilla requieren revision.";
  }
  return {
    id: String(source.id || ""), name: String(source.name || ""), language: String(source.language || ""),
    status: String(source.status || "UNKNOWN"), category: String(source.category || ""), body,
    header: String(components.find((c) => c.type === "HEADER")?.text || ""),
    footer: String(components.find((c) => c.type === "FOOTER")?.text || ""),
    variables, named, catalogIndexes, blockedReason,
  };
}

export async function listMetaTemplates(config: { token: string; wabaId: string; version: string }, request: typeof fetch = fetch) {
  const templates: MetaTemplate[] = [];
  let after = "";
  const cursors = new Set<string>();
  for (let page = 0; page < 60; page += 1) {
    const url = new URL(`https://graph.facebook.com/${config.version}/${encodeURIComponent(config.wabaId)}/message_templates`);
    url.searchParams.set("fields", "id,name,language,status,category,components,parameter_format");
    url.searchParams.set("limit", "100");
    if (after) url.searchParams.set("after", after);
    const response = await request(url, {
      headers: { Authorization: `Bearer ${config.token}` }, signal: AbortSignal.timeout(10_000),
    });
    const payload = row(await response.json());
    if (!response.ok) {
      const code = row(payload.error).code;
      throw new Error(`No se pudieron consultar las plantillas en Meta${code ? ` (codigo ${code})` : ""}. Revisa token y permisos.`);
    }
    if (!Array.isArray(payload.data)) throw new Error("Meta devolvio una lista de plantillas incompleta.");
    templates.push(...payload.data.map(describeMetaTemplate));
    const paging = row(payload.paging);
    if (!paging.next) return templates;
    after = String(row(paging.cursors).after || "");
    // Rebuild the Graph URL instead of following a next URL that may contain a token.
    if (!after || cursors.has(after)) throw new Error("La paginacion de plantillas de Meta no pudo completarse.");
    cursors.add(after);
  }
  throw new Error("La lista de plantillas supera el limite de lectura. No se usara una lista parcial.");
}

export function buildMetaTemplateMessage(template: MetaTemplate, phone: string, parameters: unknown, thumbnail = "") {
  if (template.status !== "APPROVED") throw new Error("La plantilla no esta aprobada por Meta.");
  if (template.blockedReason) throw new Error(template.blockedReason);
  if (!/^[1-9]\d{7,14}$/.test(phone)) throw new Error("Numero internacional invalido.");
  if (!Array.isArray(parameters) || parameters.length !== template.variables.length || parameters.some((p) => typeof p !== "string" || !p.trim() || p.length > 1024)) {
    throw new Error("Completa exactamente las variables requeridas por la plantilla de Meta.");
  }
  const components: Row[] = [];
  if (parameters.length) components.push({
    type: "body", parameters: parameters.map((text, index) => ({
      type: "text", text, ...(template.named ? { parameter_name: template.variables[index] } : {}),
    })),
  });
  for (const index of template.catalogIndexes) components.push({
    type: "button", sub_type: "CATALOG", index,
    ...(thumbnail ? { parameters: [{ type: "action", action: { thumbnail_product_retailer_id: thumbnail } }] } : {}),
  });
  return { messaging_product: "whatsapp", recipient_type: "individual", to: phone, type: "template", template: {
    name: template.name, language: { code: template.language }, ...(components.length ? { components } : {}),
  } };
}

export function validateWhatsAppRecipient(company: Row | undefined, phone: string) {
  if (!company) throw new Error("Empresa no encontrada.");
  if (company.whatsapp_opt_in !== true || (company.whatsapp_status && company.whatsapp_status !== "opt_in")) {
    throw new Error("El destinatario no tiene consentimiento WhatsApp vigente.");
  }
  const registered = [company.whatsapp_number, company.whatsapp, company.phone].map((p) => String(p || "").replace(/\D/g, ""));
  if (!phone || !registered.includes(phone)) throw new Error("El numero no coincide con la ficha de la empresa.");
}

export async function whatsappDispatchId(campaignId: string, phone: string) {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`whatsapp:${campaignId}:${phone}`)));
  hash[6] = (hash[6] & 15) | 80;
  hash[8] = (hash[8] & 63) | 128;
  const hex = [...hash.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
