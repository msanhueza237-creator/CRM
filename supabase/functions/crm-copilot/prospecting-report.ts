import { CopilotDataError, matches, object, tableResult, type Row } from "./contracts.ts";
import type { CopilotSources } from "./sources.ts";

const fields = (...pairs: string[]) => pairs.map(pair => { const [key, label] = pair.split(":"); return { key, label }; });
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export async function prospectingReport(source: CopilotSources, args: Row) {
  for (const key of ["campaign_id", "run_id"]) {
    if (args[key] && !uuid.test(String(args[key]))) throw new CopilotDataError("Identificador de prospeccion invalido.", "INVALID_ARGUMENTS");
  }
  const warnings = [
    "Lectura de registros del modulo Prospeccion, no una nueva busqueda en internet. No ejecuta campañas ni consume DeepSeek.",
    "DeepSeek Web descubre sitios; solo el rastreo oficial verifica contactos y domicilios. Sitios descubiertos no equivale a candidatos aprobados ni a cobertura exhaustiva. Una clave conectada no acredita uso en una ejecucion.",
    "Los candidatos no son clientes ni autorizan envios. No apruebes candidatos solo por una puntuacion o una respuesta de IA.",
  ];
  if (args.view === "candidates") {
    if (!args.run_id) throw new CopilotDataError("Primero consulta las ejecuciones y selecciona run_id para revisar sus candidatos y evidencia.", "INVALID_ARGUMENTS");
    const runFilter = `run_id=eq.${args.run_id}`;
    const runs = await source.all(`prospecting_runs?select=id,campaign_id&id=eq.${args.run_id}&order=id.asc`);
    if (!runs.length || (args.campaign_id && runs[0].campaign_id !== args.campaign_id)) throw new CopilotDataError("La ejecucion no pertenece a la campaña solicitada o no existe.", "INVALID_ARGUMENTS");
    const candidates = await source.all(`prospecting_campaign_candidates?select=id,entity_id,review_status,score,last_seen_at&${runFilter}&order=id.asc`);
    const evidence = await source.all(`active_prospect_source_records?select=id,entity_id,run_id,provider,source_url,field_name,observed_at&${runFilter}&order=id.asc`);
    // Names/categories come from CRM entities, never from model-generated lists.
    const entities = candidates.length ? await source.all("prospect_entities?select=id,name,business_line,company_type&order=id.asc") : [];
    const byId = new Map(entities.map(entity => [entity.id, entity]));
    const data = candidates.map(candidate => {
      const entity = byId.get(candidate.entity_id) ?? {};
      const records = evidence.filter(e => e.entity_id === candidate.entity_id);
      const official = records.filter(e => e.provider === "official_website");
      return { id: candidate.id, name: entity.name ?? "Identidad no disponible", category: entity.company_type ?? null,
        business_line: entity.business_line ?? null, review_status: candidate.review_status, score: candidate.score,
        evidence_count: records.length, official_evidence_count: official.length,
        sources: [...new Set(records.map(e => e.provider))].join(", "),
        source_urls: [...new Set(official.map(e => e.source_url).filter(url => typeof url === "string" && /^https?:\/\//i.test(url)))].slice(0, 8).join("\n"),
        updated_at: candidate.last_seen_at };
    }).filter(item => matches(args.query, item.name, item.category, item.business_line));
    return tableResult("get_prospecting_report", "customers", "Candidatos y evidencia de la ejecucion", data,
      fields("name:Empresa", "category:Categoria", "review_status:Revision", "score:Puntuacion CRM", "evidence_count:Evidencias activas", "official_evidence_count:Evidencias oficiales", "source_urls:Sitios oficiales", "updated_at:Ultima observacion"),
      `/prospeccion?view=candidates&run=${args.run_id}`, args,
      [...warnings, "Solo evidencia activa de esta ejecucion. Tener un sitio oficial no implica cumplir todos los requisitos de importacion."]);
  }
  const campaigns = await source.all(`prospecting_campaigns?select=id,name,status,keywords,sources,deepseek_enabled,updated_at${args.campaign_id ? `&id=eq.${args.campaign_id}` : ""}&order=id.asc`);
  const runs = await source.all(`prospecting_runs?select=id,campaign_id,status,snapshot,total_tasks,completed_tasks,failed_tasks,candidates_found,search_assistance,created_at,completed_at${args.run_id ? `&id=eq.${args.run_id}` : ""}${args.campaign_id ? `&campaign_id=eq.${args.campaign_id}` : ""}&order=id.asc`);
  const data: Row[] = [];
  for (const campaign of campaigns) {
    if (!matches(args.query, campaign.name, ...(Array.isArray(campaign.keywords) ? campaign.keywords : []))) continue;
    const related = runs.filter(run => run.campaign_id === campaign.id);
    if (!related.length && !args.run_id) data.push({ campaign_id: campaign.id, campaign: campaign.name, run_id: null,
      status: "Sin ejecutar", deepseek: campaign.deepseek_enabled ? "Solicitado para futuras ejecuciones" : "Desactivado", candidates: null, updated_at: campaign.updated_at });
    for (const run of related) {
      const assistance = object(run.search_assistance), snapshot = object(run.snapshot), definition = object(snapshot.campaign);
      const status = String(assistance.status || (snapshot.deepseek_enabled ? "pending" : "disabled"));
      const labels: Record<string, string> = { applied: assistance.mode === "web_discovery_v1" ? "Busqueda web realizada con DeepSeek" : "Preparacion de terminos (version anterior)", fallback: "DeepSeek no disponible; otras fuentes continuan", pending: "Pendiente de worker compatible", preparing: "Buscando empresas", disabled: "DeepSeek desactivado" };
      data.push({ campaign_id: campaign.id, campaign: campaign.name, run_id: run.id, status: run.status,
        deepseek: labels[status] ?? "Sin verificar", mode: assistance.mode ?? null, model: assistance.model ?? null,
        assistance_reason: assistance.reason_code ?? null, queries: assistance.queries ?? [],
        discovered_websites: assistance.discovered_websites ?? null, web_requests: assistance.web_requests ?? null,
        discoveries_unverified: assistance.discoveries ?? [],
        sources: definition.sources ?? [], territories: definition.territories ?? [],
        tasks: run.total_tasks, completed: run.completed_tasks, failed: run.failed_tasks, candidates: run.candidates_found,
        updated_at: assistance.completed_at ?? run.completed_at ?? run.created_at,
        path: `/prospeccion?view=operation&run=${run.id}` });
    }
  }
  data.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  return tableResult("get_prospecting_report", "customers", "Campañas y ejecuciones de prospeccion", data,
    fields("campaign:Campaña", "run_id:Ejecucion", "status:Estado", "deepseek:Busqueda real", "discovered_websites:Sitios DeepSeek sin validar", "web_requests:Consultas web", "completed:Tareas completas", "tasks:Tareas totales", "failed:Con error", "candidates:Candidatos totales", "updated_at:Fecha del registro"),
    args.run_id ? `/prospeccion?view=operation&run=${args.run_id}` : "/prospeccion", args, warnings);
}
