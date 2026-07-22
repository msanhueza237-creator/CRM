import { isSupabaseConfigured, supabase } from "../../lib/supabase";
import type {
  CompanyType,
  GeoComuna,
  GeoRegion,
  ProspectCandidate,
  ProspectLocation,
  ProspectingCampaign,
  ProspectingCampaignStatus,
  ProspectingEventLevel,
  ProspectingRun,
  ProspectingRunSnapshot,
  ProspectingRunStatus,
  ProspectingSource,
  ProspectingTerritory,
  ProspectingWorkspace,
  ProspectReviewStatus,
  RunEvent,
  SourceEvidence,
} from "../../types/crm";
import { createDemoProspectingWorkspace, localGeoComunas, localGeoRegions, SOURCE_DEFINITIONS } from "./prospectingData";

const STORAGE_KEY = "climactiva_prospecting_workspace_v3";

export type ProspectingDataMode = "supabase" | "demo";

export interface ProspectingLoadResult {
  workspace: ProspectingWorkspace;
  mode: ProspectingDataMode;
  reason: string;
}

export interface RunMutationResult {
  run: ProspectingRun;
  event: RunEvent;
}

type Row = Record<string, unknown>;

const campaignStatuses: ProspectingCampaignStatus[] = ["draft", "active", "archived"];
const runStatuses: ProspectingRunStatus[] = ["pending", "running", "paused", "partial", "completed", "failed", "cancel_requested", "cancelled"];
const reviewStatuses: ProspectReviewStatus[] = ["pending", "possible_duplicate", "approved", "rejected", "linked"];
const sourceIds = SOURCE_DEFINITIONS.map((source) => source.id);
export const PROSPECTING_CAMPAIGN_NAME_MAX_LENGTH = 200;
export const PROSPECTING_KEYWORD_MAX_LENGTH = 200;
export const PROSPECTING_KEYWORDS_MAX_COUNT = 50;
export const PROSPECTING_TARGET_TYPES: readonly CompanyType[] = [
  "distribuidor",
  "tienda comercial",
  "tecnico",
  "instalador grande",
  "competencia",
  "otro",
];

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function asRecord(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};
}

function asNumber(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asBoolean(value: unknown, fallback = false) {
  if (typeof value === "boolean") return value;
  if (value === "true" || value === 1 || value === "1") return true;
  if (value === "false" || value === 0 || value === "0") return false;
  return fallback;
}

function normalizeCandidateImportability(
  importEligibleValue: unknown,
  indexesValue: unknown,
  flagsValue: unknown,
  locationCount: number,
) {
  const importableLocationIndexes = Array.from(
    new Set(
      (Array.isArray(indexesValue) ? indexesValue : [])
        .map(Number)
        .filter((index) => Number.isInteger(index) && index >= 0 && index < locationCount),
    ),
  ).sort((left, right) => left - right);
  const declaredEligible = asBoolean(importEligibleValue, false);
  const reviewFlags = Array.from(new Set(arrayOfStrings(flagsValue)));

  if (importEligibleValue === undefined && !reviewFlags.includes("eligibility_not_reported")) {
    reviewFlags.push("eligibility_not_reported");
  }
  if (declaredEligible && !importableLocationIndexes.length && !reviewFlags.includes("eligibility_without_importable_locations")) {
    reviewFlags.push("eligibility_without_importable_locations");
  }

  return {
    importEligible: declaredEligible && importableLocationIndexes.length > 0,
    importableLocationIndexes,
    reviewFlags,
  };
}

function contactImportableLocationIndexes(candidateLocations: ProspectLocation[], phone: string, email: string): number[] {
  if (!phone.trim() && !email.trim()) return [];
  const indexes = candidateLocations
    .map((location, index) => (location.regionCode && location.comunaCode ? index : -1))
    .filter((index) => index >= 0);
  if (!indexes.length) return [];
  const primaryIndex = candidateLocations.findIndex((location) => location.isPrimary && location.regionCode && location.comunaCode);
  return [primaryIndex >= 0 ? primaryIndex : indexes[0]];
}

function filterCompanyTypes(value: unknown): CompanyType[] {
  return Array.from(
    new Set(
      arrayOfStrings(value).filter((item): item is CompanyType =>
        PROSPECTING_TARGET_TYPES.includes(item as CompanyType),
      ),
    ),
  );
}

function normalizeCompanyTypes(value: unknown): CompanyType[] {
  const companyTypes = filterCompanyTypes(value);
  return companyTypes.length ? companyTypes : ["otro"];
}

function validateCampaignDefinition(campaign: ProspectingCampaign) {
  const keywords = normalizeAndValidateCampaignKeywords(campaign.keywords);
  const campaignName = campaign.name.trim();
  if (!campaignName) throw new Error("Ingresa un nombre para identificar la búsqueda.");
  if (campaignName.length > PROSPECTING_CAMPAIGN_NAME_MAX_LENGTH) {
    throw new Error(`El nombre de la campaña no puede superar ${PROSPECTING_CAMPAIGN_NAME_MAX_LENGTH} caracteres.`);
  }
  if (
    campaign.targetTypes.length === 0 ||
    campaign.targetTypes.some((targetType) => !PROSPECTING_TARGET_TYPES.includes(targetType))
  ) {
    throw new Error("Selecciona al menos un tipo de empresa válido.");
  }
  if (campaign.sources.includes("brave_search") && !campaign.sources.includes("official_website")) {
    throw new Error(
      "Brave Search requiere el sitio web oficial: Brave descubre empresas y el sitio oficial valida contacto y domicilio.",
    );
  }
  return keywords;
}

function normalizeAndValidateCampaignKeywords(keywords: string[]) {
  const normalized = keywords.map((keyword) => keyword.trim());
  if (normalized.length < 1 || normalized.length > PROSPECTING_KEYWORDS_MAX_COUNT) {
    throw new Error(`Agrega entre 1 y ${PROSPECTING_KEYWORDS_MAX_COUNT} palabras clave.`);
  }
  if (normalized.some((keyword) => !keyword || keyword.length > PROSPECTING_KEYWORD_MAX_LENGTH)) {
    throw new Error(`Cada palabra clave debe tener entre 1 y ${PROSPECTING_KEYWORD_MAX_LENGTH} caracteres.`);
  }
  const casefolded = normalized.map((keyword) => keyword.toLocaleLowerCase("es-CL"));
  if (new Set(casefolded).size !== casefolded.length) {
    throw new Error("Las palabras clave no pueden estar duplicadas, aunque cambien mayúsculas o minúsculas.");
  }
  return normalized;
}

function asSource(value: unknown): ProspectingSource {
  const source = String(value ?? "official_website") as ProspectingSource;
  return sourceIds.includes(source) ? source : "official_website";
}

function cloneWorkspace(workspace: ProspectingWorkspace): ProspectingWorkspace {
  return JSON.parse(JSON.stringify(workspace)) as ProspectingWorkspace;
}

function localWorkspace(): ProspectingWorkspace {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored) {
    try {
      const parsed = JSON.parse(stored) as ProspectingWorkspace;
      if (Array.isArray(parsed.campaigns) && Array.isArray(parsed.runs) && Array.isArray(parsed.candidates)) {
        return {
          ...parsed,
          campaigns: parsed.campaigns.map((campaign) => ({
            ...campaign,
            version: campaign.version ?? 1,
            targetTypes: normalizeCompanyTypes(campaign.targetTypes),
          })),
          runs: parsed.runs.map((run) => ({
            ...run,
            snapshot: { ...run.snapshot, campaignVersion: run.snapshot.campaignVersion ?? 1 },
          })),
          candidates: parsed.candidates.map((candidate) => {
            const legacyCandidate = candidate as ProspectCandidate & { possibleDuplicateEntityId?: string };
            const importability = normalizeCandidateImportability(
              candidate.importEligible,
              candidate.importableLocationIndexes,
              candidate.reviewFlags,
              candidate.locations.length,
            );
            return {
              ...candidate,
              ...importability,
              externalCandidateId: candidate.externalCandidateId ?? candidate.id,
              possibleDuplicateExternalCandidateId:
                candidate.possibleDuplicateExternalCandidateId ?? legacyCandidate.possibleDuplicateEntityId ?? "",
            };
          }),
          regions: localGeoRegions,
          comunas: localGeoComunas,
        };
      }
    } catch {
      // Un almacenamiento corrupto no debe bloquear la validacion local.
    }
  }
  return createDemoProspectingWorkspace();
}

export class ProspectingRepository {
  private mode: ProspectingDataMode = "demo";
  private workspace = localWorkspace();

  async load(options: { preserveOnError?: boolean } = {}): Promise<ProspectingLoadResult> {
    if (!isSupabaseConfigured || !supabase) {
      this.mode = "demo";
      this.workspace = localWorkspace();
      return {
        workspace: cloneWorkspace(this.workspace),
        mode: this.mode,
        reason: "Supabase no esta configurado. Los cambios quedan solamente en este navegador.",
      };
    }

    try {
      const [
        campaignsResult,
        runsResult,
        associationsResult,
        entitiesResult,
        locationsResult,
        evidenceResult,
        eventsResult,
        regionsResult,
        comunasResult,
      ] = await Promise.all([
        supabase.from("prospecting_campaigns").select("*").order("updated_at", { ascending: false }),
        supabase.from("prospecting_runs").select("*").order("created_at", { ascending: false }),
        supabase.from("prospecting_campaign_candidates").select("*").order("last_seen_at", { ascending: false }),
        supabase.from("prospect_entities").select("*"),
        supabase.from("prospect_locations").select("*"),
        supabase.from("active_prospect_source_records").select("*"),
        supabase.from("prospecting_events").select("*").order("created_at", { ascending: false }).limit(1000),
        supabase.from("geo_regions").select("*").eq("active", true).order("sort_order", { ascending: true }),
        supabase.from("geo_comunas").select("*").eq("active", true).order("name", { ascending: true }),
      ]);

      const error = [
        campaignsResult.error,
        runsResult.error,
        associationsResult.error,
        entitiesResult.error,
        locationsResult.error,
        evidenceResult.error,
        eventsResult.error,
        regionsResult.error,
        comunasResult.error,
      ].find(Boolean);
      if (error) throw error;

      const regions = (regionsResult.data ?? []).map(mapRegion);
      const comunas = (comunasResult.data ?? []).map(mapComuna);
      if (!regions.length || !comunas.length) throw new Error("El catalogo territorial esta vacio.");

      const campaigns = (campaignsResult.data ?? []).map((row) => mapCampaign(row, regions, comunas));
      const campaignById = new Map(campaigns.map((campaign) => [campaign.id, campaign]));
      const runs = (runsResult.data ?? []).map((row) => mapRun(row, campaignById.get(String(row.campaign_id))));
      const entities = new Map((entitiesResult.data ?? []).map((row) => [String(row.id), row as Row]));
      const locations = groupRows(locationsResult.data ?? [], "entity_id");
      // La entidad se deduplica entre ejecuciones, pero su evidencia no: cada
      // registro debe mostrarse solamente en el run que lo observo. Agrupar solo
      // por entity_id mezclaba fuentes de ejecuciones historicas en la bandeja.
      const evidenceByRunAndEntity = groupRowsBy(
        evidenceResult.data ?? [],
        (row) => runEntityKey(row.run_id, row.entity_id),
      );
      const candidates = (associationsResult.data ?? []).map((row) => {
        const entityId = String(row.entity_id ?? "");
        const runId = String(row.run_id ?? "");
        return mapCandidate(
          row,
          entities.get(entityId),
          locations.get(entityId) ?? [],
          evidenceByRunAndEntity.get(runEntityKey(runId, entityId)) ?? [],
          regions,
          comunas,
        );
      });
      const events = (eventsResult.data ?? []).map((row) => mapEvent(row, comunas));

      this.mode = "supabase";
      this.workspace = { campaigns, runs, candidates, events, regions, comunas };
      return { workspace: cloneWorkspace(this.workspace), mode: this.mode, reason: "" };
    } catch (error) {
      if (options.preserveOnError && this.mode === "supabase") throw error;
      this.mode = "demo";
      this.workspace = localWorkspace();
      const detail = error instanceof Error ? error.message : "tablas no disponibles";
      return {
        workspace: cloneWorkspace(this.workspace),
        mode: this.mode,
        reason: `Prospeccion aun no esta disponible en Supabase (${detail}). Se activo el modo demo local.`,
      };
    }
  }

  get dataMode() {
    return this.mode;
  }

  async createCampaign(campaign: ProspectingCampaign): Promise<ProspectingCampaign> {
    const keywords = validateCampaignDefinition(campaign);
    campaign = { ...campaign, name: campaign.name.trim(), keywords };
    if (this.mode === "supabase" && supabase) {
      ensureOfficialTerritories(campaign);
      const { data, error } = await supabase
        .from("prospecting_campaigns")
        .insert({
          id: campaign.id,
          name: campaign.name,
          description: campaign.description || null,
          sector: campaign.sector,
          keywords: campaign.keywords,
          sources: campaign.sources,
          region_codes: campaign.territories.map((territory) => territory.regionCode),
          comuna_codes: campaign.territories.flatMap((territory) => territory.comunaCodes),
          target_types: campaign.targetTypes,
          result_limit_per_query: campaign.limits.resultsPerTask,
          candidate_limit: campaign.limits.maxCandidates,
          status: campaign.status,
          version: campaign.version,
          created_by: campaign.createdBy,
          updated_by: campaign.createdBy,
        })
        .select("*")
        .single();
      if (error) throw error;
      campaign = data ? mapCampaign(data, this.workspace.regions, this.workspace.comunas) : campaign;
    }

    this.workspace.campaigns = [campaign, ...this.workspace.campaigns];
    this.persistIfLocal();
    return campaign;
  }

  async updateCampaign(campaign: ProspectingCampaign, userId: string): Promise<ProspectingCampaign> {
    const keywords = validateCampaignDefinition(campaign);
    campaign = { ...campaign, name: campaign.name.trim(), keywords };
    const now = new Date().toISOString();
    let updated: ProspectingCampaign = {
      ...campaign,
      version: campaign.version + 1,
      updatedAt: now,
    };

    if (this.mode === "supabase" && supabase) {
      ensureOfficialTerritories(campaign);
      const { data, error } = await supabase
        .from("prospecting_campaigns")
        .update({
          name: campaign.name,
          description: campaign.description || null,
          sector: campaign.sector,
          keywords: campaign.keywords,
          sources: campaign.sources,
          region_codes: campaign.territories.map((territory) => territory.regionCode),
          comuna_codes: campaign.territories.flatMap((territory) => territory.comunaCodes),
          target_types: campaign.targetTypes,
          result_limit_per_query: campaign.limits.resultsPerTask,
          candidate_limit: campaign.limits.maxCandidates,
          status: campaign.status,
          updated_by: userId,
          updated_at: now,
        })
        .eq("id", campaign.id)
        .eq("version", campaign.version)
        .select("*")
        .maybeSingle();
      if (error) throw error;
      if (!data) throw new Error("La campaña fue modificada por otra sesión. Actualiza la vista antes de guardar nuevamente.");
      updated = mapCampaign(data, this.workspace.regions, this.workspace.comunas);
    }

    this.workspace.campaigns = this.workspace.campaigns.map((item) => (item.id === campaign.id ? updated : item));
    this.persistIfLocal();
    return updated;
  }

  async startRun(campaign: ProspectingCampaign, userId: string): Promise<RunMutationResult> {
    const keywords = validateCampaignDefinition(campaign);
    campaign = { ...campaign, name: campaign.name.trim(), keywords };
    if (this.mode === "supabase") ensureOfficialTerritories(campaign);
    const now = new Date().toISOString();
    const snapshot: ProspectingRunSnapshot = {
      schemaVersion: 1,
      campaignVersion: campaign.version,
      campaignId: campaign.id,
      campaignName: campaign.name,
      sector: "hvac",
      keywords: [...campaign.keywords],
      sources: [...campaign.sources],
      territories: campaign.territories.map((territory) => ({ ...territory, comunaCodes: [...territory.comunaCodes], comunaNames: [...territory.comunaNames] })),
      targetTypes: [...campaign.targetTypes],
      limits: { ...campaign.limits },
      requestedBy: userId,
      requestedAt: now,
    };
    const totalTasks = estimateTaskCount(campaign);
    let run: ProspectingRun = {
      id: crypto.randomUUID(),
      campaignId: campaign.id,
      status: "pending",
      snapshot,
      progress: { totalTasks, completedTasks: 0, failedTasks: 0, candidatesFound: 0 },
      requestedBy: userId,
      createdAt: now,
      startedAt: "",
      completedAt: "",
      lastError: "",
      enrichmentStatus: "not_requested",
      enrichmentTotal: 0,
      enrichmentCompleted: 0,
      enrichmentFailed: 0,
    };

    if (this.mode === "supabase" && supabase) {
      const { data, error } = await supabase.rpc("enqueue_prospecting_run", {
        p_campaign_id: campaign.id,
        p_requested_by: userId,
      });
      if (error) throw error;
      if (data) run = mapRun(asRecord(data), campaign);
    }

    const event: RunEvent = {
      id: crypto.randomUUID(),
      runId: run.id,
      taskId: "",
      createdAt: now,
      level: "info",
      stage: "planificacion",
      message: `Ejecucion encolada desde el CRM con ${totalTasks} tareas estimadas.`,
      metrics: { totalTasks },
    };
    this.workspace.runs = [run, ...this.workspace.runs];
    this.workspace.events = [event, ...this.workspace.events];
    this.workspace.campaigns = this.workspace.campaigns.map((item) =>
      item.id === campaign.id ? { ...item, status: "active", updatedAt: now } : item,
    );
    this.persistIfLocal();
    return { run, event };
  }

  async requestCancellation(runId: string, userId: string): Promise<RunMutationResult> {
    const now = new Date().toISOString();
    const current = this.workspace.runs.find((run) => run.id === runId);
    if (!current) throw new Error("No se encontro la ejecucion seleccionada.");
    let run: ProspectingRun = { ...current, status: "cancel_requested" };

    if (this.mode === "supabase" && supabase) {
      const { data, error } = await supabase.rpc("request_prospecting_run_cancel", { p_run_id: runId });
      if (error) throw error;
      if (data) {
        const response = asRecord(data);
        run = {
          ...run,
          id: String(response.id ?? run.id),
          status: runStatuses.includes(String(response.status) as ProspectingRunStatus)
            ? (String(response.status) as ProspectingRunStatus)
            : "cancel_requested",
        };
      }
    }

    const event: RunEvent = {
      id: crypto.randomUUID(),
      runId,
      taskId: "",
      createdAt: now,
      level: "warning",
      stage: "control",
      message: "Cancelacion solicitada desde el CRM. El agente debe detener nuevas consultas.",
      metrics: { requestedBy: userId },
    };
    this.workspace.runs = this.workspace.runs.map((item) => (item.id === runId ? run : item));
    this.workspace.events = [event, ...this.workspace.events];
    this.persistIfLocal();
    return { run, event };
  }

  async pauseRun(runId: string, userId: string): Promise<RunMutationResult> {
    return this.controlRun(runId, userId, "pause");
  }

  async resumeRun(runId: string, userId: string): Promise<RunMutationResult> {
    return this.controlRun(runId, userId, "resume");
  }

  private async controlRun(runId: string, userId: string, action: "pause" | "resume"): Promise<RunMutationResult> {
    const current = this.workspace.runs.find((run) => run.id === runId);
    if (!current) throw new Error("No se encontro la ejecucion seleccionada.");
    const now = new Date().toISOString();
    const fallbackStatus: ProspectingRunStatus = action === "pause" ? "paused" : "pending";
    let run: ProspectingRun = { ...current, status: fallbackStatus };
    if (this.mode === "supabase" && supabase) {
      const functionName = action === "pause" ? "pause_prospecting_run" : "resume_prospecting_run";
      const { data, error } = await supabase.rpc(functionName, { p_run_id: runId });
      if (error) throw error;
      const response = asRecord(data);
      const status = String(response.status ?? fallbackStatus) as ProspectingRunStatus;
      run = { ...run, status: runStatuses.includes(status) ? status : fallbackStatus };
    }
    const event: RunEvent = {
      id: crypto.randomUUID(), runId, taskId: "", createdAt: now, level: action === "pause" ? "warning" : "info",
      stage: action === "pause" ? "paused" : "resumed",
      message: action === "pause" ? "Ejecucion pausada desde el CRM." : "Ejecucion reanudada desde el CRM.",
      metrics: { requestedBy: userId },
    };
    this.workspace.runs = this.workspace.runs.map((item) => item.id === runId ? run : item);
    this.workspace.events = [event, ...this.workspace.events];
    this.persistIfLocal();
    return { run, event };
  }

  async enqueueEnrichment(runId: string): Promise<ProspectingRun> {
    const current = this.workspace.runs.find((run) => run.id === runId);
    if (!current) throw new Error("No se encontro la ejecucion seleccionada.");
    let run: ProspectingRun = { ...current, enrichmentStatus: "pending", enrichmentTotal: current.progress.candidatesFound, enrichmentCompleted: 0, enrichmentFailed: 0 };
    if (this.mode === "supabase" && supabase) {
      const { data, error } = await supabase.rpc("enqueue_prospect_enrichment", { p_run_id: runId });
      if (error) throw error;
      const response = asRecord(data);
      run = { ...run, enrichmentStatus: String(response.status ?? "pending") as ProspectingRun["enrichmentStatus"], enrichmentTotal: asNumber(response.total, run.enrichmentTotal) };
    }
    this.workspace.runs = this.workspace.runs.map((item) => item.id === runId ? run : item);
    this.persistIfLocal();
    return run;
  }

  async controlEnrichment(runId: string, action: "pause" | "resume"): Promise<ProspectingRun> {
    const current = this.workspace.runs.find((run) => run.id === runId);
    if (!current) throw new Error("No se encontro la ejecucion seleccionada.");
    const enrichmentStatus = action === "pause" ? "paused" : "pending";
    let run: ProspectingRun = { ...current, enrichmentStatus };
    if (this.mode === "supabase" && supabase) {
      const { error } = await supabase.rpc(action === "pause" ? "pause_prospect_enrichment" : "resume_prospect_enrichment", { p_run_id: runId });
      if (error) throw error;
    }
    this.workspace.runs = this.workspace.runs.map((item) => item.id === runId ? run : item);
    this.persistIfLocal();
    return run;
  }

  async reviewCandidate(
    candidateId: string,
    status: ProspectReviewStatus,
    userId: string,
    companyId = "",
    notes = "",
  ): Promise<ProspectCandidate> {
    const current = this.workspace.candidates.find((candidate) => candidate.id === candidateId);
    if (!current) throw new Error("No se encontro el candidato seleccionado.");
    if ((status === "approved" || status === "linked") && !current.importEligible) {
      throw new Error("El candidato no tiene evidencia permanente suficiente para aprobarlo o vincularlo.");
    }
    const now = new Date().toISOString();
    let candidate: ProspectCandidate = {
      ...current,
      reviewStatus: status,
      linkedCompanyId: companyId,
      reviewNotes: notes || current.reviewNotes,
      lastSeenAt: now,
    };

    if (this.mode === "supabase" && supabase) {
      const action = status === "linked" ? "link" : status === "rejected" ? "reject" : status === "approved" ? "approve" : "";
      if (!action) throw new Error("La accion de revision no es valida.");
      const rpcName =
        action !== "reject" && current.reviewFlags.includes("contact_only_import")
          ? "review_contact_prospect_candidate"
          : "review_prospect_candidate";
      const { data, error } = await supabase.rpc(rpcName, {
        p_candidate_id: candidateId,
        p_action: action,
        p_company_id: companyId || null,
        p_notes: candidate.reviewNotes || null,
      });
      if (error) throw error;
      if (data) {
        const response = asRecord(data);
        candidate = {
          ...candidate,
          reviewStatus: reviewStatuses.includes(String(response.review_status) as ProspectReviewStatus)
            ? (String(response.review_status) as ProspectReviewStatus)
            : status,
          linkedCompanyId: String(response.company_id ?? companyId),
        };
      }
    }

    this.workspace.candidates = this.workspace.candidates.map((item) => (item.id === candidateId ? candidate : item));
    this.persistIfLocal();
    return candidate;
  }

  async confirmCandidateEvidence(candidateId: string): Promise<ProspectCandidate> {
    const current = this.workspace.candidates.find((candidate) => candidate.id === candidateId);
    if (!current) throw new Error("No se encontro el candidato seleccionado.");
    if (!current.website) throw new Error("El candidato no tiene un sitio oficial que puedas verificar.");
    if (!current.locations.length) throw new Error("El candidato no tiene una ubicacion canonica para confirmar.");

    let importableLocationIndexes = [
      Math.max(0, current.locations.findIndex((location) => location.isPrimary)),
    ];
    if (this.mode === "supabase" && supabase) {
      const { data, error } = await supabase.rpc("confirm_prospect_candidate_evidence", {
        p_candidate_id: candidateId,
      });
      if (error) throw error;
      const response = asRecord(data);
      const reportedIndexes = Array.isArray(response.importable_location_indexes)
        ? response.importable_location_indexes.map((value) => Number(value)).filter(Number.isInteger)
        : [];
      if (reportedIndexes.length) importableLocationIndexes = reportedIndexes;
    }

    const candidate: ProspectCandidate = {
      ...current,
      importEligible: true,
      importableLocationIndexes,
      reviewFlags: current.reviewFlags.filter((flag) => ![
        "insufficient_permanent_evidence",
        "location_0_temporary_evidence",
        "eligibility_not_reported",
        "eligibility_without_importable_locations",
      ].includes(flag)),
      lastSeenAt: new Date().toISOString(),
    };
    this.workspace.candidates = this.workspace.candidates.map((item) => item.id === candidateId ? candidate : item);
    this.persistIfLocal();
    return candidate;
  }

  private persistIfLocal() {
    if (this.mode === "demo") localStorage.setItem(STORAGE_KEY, JSON.stringify(this.workspace));
  }
}

function mapRegion(row: Row): GeoRegion {
  return { code: String(row.code ?? row.region_code ?? ""), name: String(row.name ?? row.region_name ?? "") };
}

function mapComuna(row: Row): GeoComuna {
  return {
    code: String(row.code ?? row.comuna_code ?? ""),
    regionCode: String(row.region_code ?? ""),
    name: String(row.name ?? row.comuna_name ?? ""),
  };
}

function mapCampaign(row: Row, regions: GeoRegion[], comunas: GeoComuna[]): ProspectingCampaign {
  const regionCodes = arrayOfStrings(row.region_codes);
  const comunaCodes = arrayOfStrings(row.comuna_codes);
  const territories = regionCodes.map((regionCode) => territoryFromCodes(regionCode, comunaCodes, regions, comunas));
  const statusValue = String(row.status ?? "draft") as ProspectingCampaignStatus;
  return {
    id: String(row.id),
    version: Math.max(1, asNumber(row.version, 1)),
    name: String(row.name ?? "Campana sin nombre"),
    description: String(row.description ?? ""),
    sector: "hvac",
    status: campaignStatuses.includes(statusValue) ? statusValue : "draft",
    keywords: arrayOfStrings(row.keywords),
    sources: arrayOfStrings(row.sources).map(asSource),
    territories,
    targetTypes: normalizeCompanyTypes(row.target_types),
    limits: {
      resultsPerTask: asNumber(row.result_limit_per_query, 20),
      maxCandidates: asNumber(row.candidate_limit, 1000),
    },
    createdBy: String(row.created_by ?? ""),
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? row.created_at ?? ""),
  };
}

function territoryFromCodes(regionCode: string, selectedComunaCodes: string[], regions: GeoRegion[], comunas: GeoComuna[]): ProspectingTerritory {
  const region = regions.find((item) => item.code === regionCode);
  const regionComunas = comunas.filter((item) => item.regionCode === regionCode);
  // En el contrato SQL, comuna_codes=[] significa "todas las comunas de las
  // regiones seleccionadas". Rehidratar esa convencion evita que una campana
  // valida reaparezca como territorio vacio al recargar el CRM.
  const selectsWholeRegion = selectedComunaCodes.length === 0;
  const selected = selectsWholeRegion
    ? regionComunas
    : regionComunas.filter((item) => selectedComunaCodes.includes(item.code));
  return {
    regionCode,
    regionName: region?.name ?? regionCode,
    allCommunes: selectsWholeRegion || (regionComunas.length > 0 && selected.length === regionComunas.length),
    comunaCodes: selected.map((item) => item.code),
    comunaNames: selected.map((item) => item.name),
  };
}

function mapRun(row: Row, campaign?: ProspectingCampaign): ProspectingRun {
  const statusValue = String(row.status ?? "pending") as ProspectingRunStatus;
  const snapshot = mapSnapshot(row.snapshot, campaign, row);
  const rawProgress = asRecord(row.progress);
  return {
    id: String(row.id),
    campaignId: String(row.campaign_id ?? snapshot.campaignId),
    status: runStatuses.includes(statusValue) ? statusValue : "pending",
    snapshot,
    progress: {
      totalTasks: asNumber(row.total_tasks ?? rawProgress.totalTasks ?? rawProgress.total_tasks),
      completedTasks: asNumber(row.completed_tasks ?? rawProgress.completedTasks ?? rawProgress.completed_tasks),
      failedTasks: asNumber(row.failed_tasks ?? rawProgress.failedTasks ?? rawProgress.failed_tasks),
      candidatesFound: asNumber(row.candidates_found ?? rawProgress.candidatesFound ?? rawProgress.candidates_found),
    },
    requestedBy: String(row.requested_by ?? snapshot.requestedBy),
    createdAt: String(row.created_at ?? snapshot.requestedAt),
    startedAt: String(row.started_at ?? ""),
    completedAt: String(row.completed_at ?? ""),
    lastError: String(row.last_error ?? ""),
    enrichmentStatus: String(row.enrichment_status ?? "not_requested") as ProspectingRun["enrichmentStatus"],
    enrichmentTotal: asNumber(row.enrichment_total),
    enrichmentCompleted: asNumber(row.enrichment_completed),
    enrichmentFailed: asNumber(row.enrichment_failed),
  };
}

function mapSnapshot(value: unknown, campaign: ProspectingCampaign | undefined, row: Row): ProspectingRunSnapshot {
  const raw = asRecord(value);
  const rawCampaign = asRecord(raw.campaign);
  const rawLimits = asRecord(raw.limits);
  const rawTerritories = Array.isArray(raw.territories) ? (raw.territories as ProspectingTerritory[]) : [];
  const canonicalTerritories = mapCanonicalSnapshotTerritories(rawCampaign.territories);
  const snapshotKeywords = arrayOfStrings(raw.keywords).length ? arrayOfStrings(raw.keywords) : arrayOfStrings(rawCampaign.keywords);
  const snapshotSources = arrayOfStrings(raw.sources).length ? arrayOfStrings(raw.sources) : arrayOfStrings(rawCampaign.sources);
  const snapshotTargetTypes = arrayOfStrings(raw.targetTypes ?? raw.target_types).length
    ? arrayOfStrings(raw.targetTypes ?? raw.target_types)
    : arrayOfStrings(rawCampaign.target_types ?? rawCampaign.targetTypes);
  const validSnapshotTargetTypes = filterCompanyTypes(snapshotTargetTypes);
  return {
    schemaVersion: 1,
    campaignVersion: Math.max(1, asNumber(raw.campaignVersion ?? raw.campaign_version ?? rawCampaign.version, campaign?.version ?? 1)),
    campaignId: String(
      raw.campaignId ?? raw.campaign_id ?? rawCampaign.crm_campaign_id ?? rawCampaign.id ?? row.campaign_id ?? campaign?.id ?? "",
    ),
    campaignName: String(raw.campaignName ?? raw.campaign_name ?? rawCampaign.name ?? campaign?.name ?? "Campana"),
    sector: "hvac",
    keywords: snapshotKeywords.length ? snapshotKeywords : campaign?.keywords ?? [],
    sources: (snapshotSources.length ? snapshotSources.map(asSource) : campaign?.sources) ?? [],
    territories: canonicalTerritories.length ? canonicalTerritories : rawTerritories.length ? rawTerritories : campaign?.territories ?? [],
    targetTypes: validSnapshotTargetTypes.length
      ? validSnapshotTargetTypes
      : campaign?.targetTypes.length
        ? campaign.targetTypes
        : ["otro"],
    limits: {
      resultsPerTask: asNumber(
        rawCampaign.max_results_per_task ??
          rawLimits.resultsPerTask ??
          rawLimits.results_per_task ??
          rawLimits.results_per_query ??
          rawCampaign.result_limit_per_query,
        campaign?.limits.resultsPerTask ?? 20,
      ),
      maxCandidates: asNumber(
        rawCampaign.max_candidates ??
          rawLimits.maxCandidates ??
          rawLimits.max_candidates ??
          rawLimits.candidate_limit ??
          rawCampaign.candidate_limit,
        campaign?.limits.maxCandidates ?? 1000,
      ),
    },
    requestedBy: String(raw.requestedBy ?? raw.requested_by ?? row.requested_by ?? ""),
    requestedAt: String(raw.requestedAt ?? raw.requested_at ?? row.created_at ?? ""),
  };
}

function mapCanonicalSnapshotTerritories(value: unknown): ProspectingTerritory[] {
  if (!Array.isArray(value)) return [];
  const grouped = new Map<string, ProspectingTerritory>();
  value.forEach((item) => {
    const row = asRecord(item);
    const regionCode = String(row.region_code ?? row.regionCode ?? "");
    const comunaCode = String(row.comuna_code ?? row.comunaCode ?? "");
    if (!regionCode || !comunaCode) return;
    const current = grouped.get(regionCode) ?? {
      regionCode,
      regionName: String(row.region_name ?? row.regionName ?? regionCode),
      allCommunes: false,
      comunaCodes: [],
      comunaNames: [],
    };
    if (!current.comunaCodes.includes(comunaCode)) {
      current.comunaCodes.push(comunaCode);
      current.comunaNames.push(String(row.comuna_name ?? row.comunaName ?? comunaCode));
    }
    grouped.set(regionCode, current);
  });
  return Array.from(grouped.values());
}

function mapCandidate(
  association: Row,
  entity: Row | undefined,
  locationRows: Row[],
  evidenceRows: Row[],
  regions: GeoRegion[],
  comunas: GeoComuna[],
): ProspectCandidate {
  const safeEntity = entity ?? {};
  const snapshot = asRecord(association.candidate_snapshot);
  const isSnapshotBacked = Object.keys(snapshot).length > 0;
  const statusValue = String(association.review_status ?? "pending") as ProspectReviewStatus;
  const snapshotLocations = isSnapshotBacked ? mapCandidateSnapshotLocations(snapshot, association, regions, comunas) : [];
  const candidateLocations = isSnapshotBacked ? snapshotLocations : locationRows.map((row) => mapLocation(row, regions, comunas));
  let importability = normalizeCandidateImportability(
    isSnapshotBacked ? snapshot.import_eligible : undefined,
    isSnapshotBacked ? snapshot.importable_location_indexes : undefined,
    isSnapshotBacked ? snapshot.review_flags : undefined,
    candidateLocations.length,
  );
  const candidatePhone = String(isSnapshotBacked ? snapshot.phone ?? "" : safeEntity.phone ?? "");
  const candidateEmail = String(isSnapshotBacked ? snapshot.email ?? "" : safeEntity.email ?? "");
  const contactOnlyIndexes = contactImportableLocationIndexes(candidateLocations, candidatePhone, candidateEmail);
  if (!importability.importEligible && contactOnlyIndexes.length) {
    importability = {
      importEligible: true,
      importableLocationIndexes: contactOnlyIndexes,
      reviewFlags: importability.reviewFlags
        .filter((flag) => !flag.startsWith("location_") && flag !== "insufficient_permanent_evidence")
        .concat(importability.reviewFlags.includes("contact_only_import") ? [] : ["contact_only_import"]),
    };
  }
  return {
    id: String(association.id),
    entityId: String(association.entity_id ?? safeEntity.id ?? ""),
    externalCandidateId: String(association.external_candidate_id ?? snapshot.candidate_id ?? ""),
    campaignId: String(association.campaign_id ?? ""),
    runId: String(association.run_id ?? ""),
    name: String(isSnapshotBacked ? snapshot.name ?? "Empresa sin nombre" : safeEntity.name ?? "Empresa sin nombre"),
    legalName: String(isSnapshotBacked ? snapshot.trade_name ?? "" : safeEntity.legal_name ?? ""),
    rut: String(isSnapshotBacked ? snapshot.rut ?? "" : safeEntity.rut ?? ""),
    businessLine: String(
      isSnapshotBacked
        ? snapshot.description ?? snapshot.business_line ?? snapshot.category ?? ""
        : safeEntity.business_line ?? safeEntity.description ?? "",
    ),
    companySummary: String(isSnapshotBacked ? snapshot.company_summary ?? "" : safeEntity.company_summary ?? ""),
    companyType: asCompanyType(isSnapshotBacked ? snapshot.category ?? snapshot.company_type : safeEntity.company_type),
    website: String(isSnapshotBacked ? snapshot.website ?? "" : safeEntity.website ?? ""),
    phone: candidatePhone,
    email: candidateEmail,
    socialMedia: asRecord(isSnapshotBacked ? snapshot.social_media : safeEntity.social_media) as Record<string, string>,
    specialties: arrayOfStrings(isSnapshotBacked ? snapshot.specialties : safeEntity.specialties),
    brands: arrayOfStrings(isSnapshotBacked ? snapshot.brands : safeEntity.brands),
    enrichmentStatus: String(association.enrichment_status ?? "not_requested") as ProspectCandidate["enrichmentStatus"],
    enrichmentSummary: asRecord(association.enrichment_summary) as Record<string, number | string | boolean>,
    enrichmentError: String(association.enrichment_error ?? ""),
    enrichedAt: String(association.enriched_at ?? safeEntity.enriched_at ?? ""),
    score: isSnapshotBacked
      ? asNumber(snapshot.score, asNumber(association.score))
      : asNumber(association.score ?? safeEntity.relevance_score),
    marketScore: isSnapshotBacked ? asNumber(snapshot.market_score) : 0,
    marketSignals: asRecord(isSnapshotBacked ? snapshot.market_signals : {}) as Record<string, number | string | boolean>,
    reviewStatus: reviewStatuses.includes(statusValue) ? statusValue : "pending",
    locations: candidateLocations,
    evidence: evidenceRows.map(mapEvidence),
    ...importability,
    possibleDuplicateExternalCandidateId: String(association.possible_duplicate_of ?? ""),
    possibleDuplicateCompanyId: String(association.possible_duplicate_company_id ?? ""),
    linkedCompanyId: String(association.company_id ?? ""),
    reviewNotes: String(association.review_notes ?? ""),
    firstSeenAt: String(association.first_seen_at ?? safeEntity.created_at ?? ""),
    lastSeenAt: String(association.last_seen_at ?? safeEntity.updated_at ?? ""),
  };
}

function asCompanyType(value: unknown): CompanyType {
  const companyType = String(value ?? "otro") as CompanyType;
  return PROSPECTING_TARGET_TYPES.includes(companyType) ? companyType : "otro";
}

function mapCandidateSnapshotLocations(
  snapshot: Row,
  association: Row,
  regions: GeoRegion[],
  comunas: GeoComuna[],
): ProspectLocation[] {
  const rawLocations = Array.isArray(snapshot.locations)
    ? snapshot.locations
    : Object.keys(asRecord(snapshot.location)).length
      ? [snapshot.location]
      : [];

  return rawLocations.map((value, index) => {
    const row = asRecord(value);
    const regionCode = String(row.region_code ?? row.regionCode ?? "");
    const comunaCode = String(row.comuna_code ?? row.comunaCode ?? "");
    return {
      id: `${String(association.id)}:snapshot-location:${index}`,
      kind: row.kind === "headquarters" || row.kind === "casa_matriz" ? "casa_matriz" : "sucursal",
      regionCode,
      regionName: String(
        row.region_name ?? row.regionName ?? regions.find((region) => region.code === regionCode)?.name ?? regionCode,
      ),
      comunaCode,
      comunaName: String(
        row.comuna_name ?? row.comunaName ?? comunas.find((comuna) => comuna.code === comunaCode)?.name ?? comunaCode,
      ),
      address: String(row.address ?? ""),
      isPrimary: row.is_primary === undefined ? index === 0 : Boolean(row.is_primary),
    };
  });
}

function mapLocation(row: Row, regions: GeoRegion[], comunas: GeoComuna[]): ProspectLocation {
  const regionCode = String(row.region_code ?? "");
  const comunaCode = String(row.comuna_code ?? "");
  return {
    id: String(row.id),
    kind: row.kind === "sucursal" || row.kind === "branch" ? "sucursal" : "casa_matriz",
    regionCode,
    regionName: String(row.region_name ?? regions.find((item) => item.code === regionCode)?.name ?? regionCode),
    comunaCode,
    comunaName: String(row.comuna_name ?? comunas.find((item) => item.code === comunaCode)?.name ?? comunaCode),
    address: String(row.address ?? ""),
    isPrimary: Boolean(row.is_primary),
  };
}

function mapEvidence(row: Row): SourceEvidence {
  return {
    id: String(row.id),
    source: asSource(row.provider ?? row.source),
    url: String(row.source_url ?? row.url ?? ""),
    externalId: String(row.provider_record_id ?? row.external_id ?? ""),
    field: String(row.field_name ?? row.field ?? "name"),
    value: String(row.field_value ?? row.value ?? ""),
    confidence: asNumber(row.confidence),
    observedAt: String(row.observed_at ?? row.created_at ?? ""),
    retentionAllowed: row.retention_allowed === undefined
      ? !row.retention_until || new Date(String(row.retention_until)).getTime() > Date.now()
      : Boolean(row.retention_allowed),
  };
}

function mapEvent(row: Row, comunas: GeoComuna[]): RunEvent {
  const level = String(row.level ?? "info") as ProspectingEventLevel;
  const comunaCode = String(row.comuna_code ?? "");
  return {
    id: String(row.id),
    runId: String(row.run_id ?? ""),
    taskId: String(row.task_id ?? ""),
    createdAt: String(row.created_at ?? ""),
    level: ["debug", "info", "warning", "error"].includes(level) ? level : "info",
    stage: String(row.stage ?? "actividad"),
    source: row.source ? asSource(row.source) : undefined,
    keyword: row.keyword ? String(row.keyword) : undefined,
    comunaCode: comunaCode || undefined,
    comunaName: comunaCode ? comunas.find((item) => item.code === comunaCode)?.name : undefined,
    message: String(row.message ?? ""),
    metrics: asRecord(row.metrics) as Record<string, number | string | boolean>,
  };
}

function groupRows(rows: Row[], key: string) {
  return groupRowsBy(rows, (row) => String(row[key] ?? ""));
}

function groupRowsBy(rows: Row[], keyFor: (row: Row) => string) {
  const grouped = new Map<string, Row[]>();
  rows.forEach((row) => {
    const value = keyFor(row);
    grouped.set(value, [...(grouped.get(value) ?? []), row]);
  });
  return grouped;
}

function runEntityKey(runId: unknown, entityId: unknown) {
  return `${String(runId ?? "")}::${String(entityId ?? "")}`;
}

function estimateTaskCount(campaign: ProspectingCampaign) {
  const discoverySources = campaign.sources.filter((source) => SOURCE_DEFINITIONS.find((definition) => definition.id === source)?.discovery).length;
  const comunaCount = campaign.territories.reduce((total, territory) => total + territory.comunaCodes.length, 0);
  return discoverySources * campaign.keywords.length * comunaCount;
}

function ensureOfficialTerritories(campaign: ProspectingCampaign) {
  const localCode = campaign.territories.flatMap((territory) => territory.comunaCodes).find((code) => code.startsWith("local-"));
  if (localCode) throw new Error("No se puede encolar una busqueda sin codigos CUT oficiales.");
}
