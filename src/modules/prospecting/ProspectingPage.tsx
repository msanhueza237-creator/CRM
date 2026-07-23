import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Ban,
  Building2,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  Clock3,
  Database,
  ExternalLink,
  Eye,
  Filter,
  Globe2,
  Link2,
  ListChecks,
  MapPin,
  PauseCircle,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  X,
  XCircle,
} from "lucide-react";
import { normalizeString } from "../../data/chileData";
import type {
  Company,
  CompanyType,
  GeoComuna,
  GeoRegion,
  ProspectCandidate,
  ProspectingCampaign,
  ProspectingRun,
  ProspectingSource,
  ProspectingTerritory,
  ProspectingWorkspace,
  ProspectReviewStatus,
} from "../../types/crm";
import { useAuth } from "../auth/AuthContext";
import { useCompanyStore } from "../companies/CompanyStore";
import { DEFAULT_PROSPECTING_KEYWORDS, SOURCE_DEFINITIONS } from "./prospectingData";
import {
  PROSPECTING_CAMPAIGN_NAME_MAX_LENGTH,
  PROSPECTING_KEYWORD_MAX_LENGTH,
  PROSPECTING_KEYWORDS_MAX_COUNT,
  PROSPECTING_TARGET_TYPES,
  ProspectingRepository,
  type ProspectingDataMode,
} from "./prospectingRepository";
import { HistoricalBaseView } from "./HistoricalBaseView";

type ViewTab = "campaigns" | "operation" | "candidates" | "historical";
type Notice = { type: "info" | "success" | "error"; text: string } | null;
type CandidateStatusFilter = ProspectReviewStatus | "all" | "active";

const runLabels: Record<ProspectingRun["status"], string> = {
  pending: "Pendiente",
  running: "En proceso",
  paused: "Pausada",
  partial: "Parcial",
  completed: "Completada",
  failed: "Fallida",
  cancel_requested: "Cancelación solicitada",
  cancelled: "Cancelada",
};

const reviewLabels: Record<ProspectReviewStatus, string> = {
  pending: "Pendiente",
  possible_duplicate: "Posible duplicado",
  approved: "Aprobado",
  rejected: "Rechazado",
  linked: "Vinculado",
};

const campaignLabels: Record<ProspectingCampaign["status"], string> = {
  draft: "Borrador",
  active: "Activa",
  archived: "Archivada",
};

const IDENTITY_CONFLICT_FLAGS = new Set([
  "conflicting_exact_identifiers",
  "conflicting_exact_company_identifiers",
]);

function hasIdentityConflict(candidate: ProspectCandidate) {
  return candidate.reviewFlags.some((flag) => IDENTITY_CONFLICT_FLAGS.has(flag));
}

const targetTypeLabels: Array<{ id: CompanyType; label: string }> = [
  { id: "distribuidor", label: "Distribuidores" },
  { id: "tienda comercial", label: "Tiendas comerciales" },
  { id: "tecnico", label: "Técnicos" },
  { id: "instalador grande", label: "Instaladores grandes" },
  { id: "competencia", label: "Competencia" },
  { id: "otro", label: "Otro" },
];

export function ProspectingPage() {
  const { user } = useAuth();
  const { companies, createCompany } = useCompanyStore();
  const repository = useMemo(() => new ProspectingRepository(), []);
  const [workspace, setWorkspace] = useState<ProspectingWorkspace | null>(null);
  const [dataMode, setDataMode] = useState<ProspectingDataMode>("demo");
  const [modeReason, setModeReason] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefreshedAt, setLastRefreshedAt] = useState("");
  const [notice, setNotice] = useState<Notice>(null);
  const [busyAction, setBusyAction] = useState("");
  const [tab, setTab] = useState<ViewTab>("campaigns");
  const [showForm, setShowForm] = useState(false);
  const [editingCampaignId, setEditingCampaignId] = useState("");
  const [selectedCampaignId, setSelectedCampaignId] = useState("");
  const [selectedRunId, setSelectedRunId] = useState("");
  const [selectedCandidateId, setSelectedCandidateId] = useState("");
  const [candidateQuery, setCandidateQuery] = useState("");
  const [candidateStatus, setCandidateStatus] = useState<CandidateStatusFilter>("active");
  const [candidateSource, setCandidateSource] = useState<ProspectingSource | "all">("all");
  const [candidateComuna, setCandidateComuna] = useState("all");
  const [companyToLink, setCompanyToLink] = useState("");
  const refreshInFlight = useRef(false);

  const role = user?.role ?? "visualizador";
  const canDraft = role === "administrador" || role === "vendedor";
  const canReview = canDraft;
  const canExecute = role === "administrador";
  const canConfigure = role === "administrador";
  const formOpen = showForm && tab === "campaigns";

  const refreshWorkspace = useCallback(
    async (manual = false) => {
      if (refreshInFlight.current || document.hidden) return;
      refreshInFlight.current = true;
      setRefreshing(true);
      try {
        const result = await repository.load({ preserveOnError: true });
        setWorkspace(result.workspace);
        setDataMode(result.mode);
        setModeReason(result.reason);
        setLastRefreshedAt(new Date().toISOString());
        if (manual) setNotice({ type: "success", text: "Datos de prospección actualizados." });
      } catch (error) {
        if (manual) setNotice({ type: "error", text: errorMessage(error) });
      } finally {
        refreshInFlight.current = false;
        setRefreshing(false);
      }
    },
    [repository],
  );

  useEffect(() => {
    let active = true;
    repository
      .load()
      .then((result) => {
        if (!active) return;
        setWorkspace(result.workspace);
        setDataMode(result.mode);
        setModeReason(result.reason);
        setLastRefreshedAt(new Date().toISOString());
        const campaign = result.workspace.campaigns[0];
        const run = campaign ? result.workspace.runs.find((item) => item.campaignId === campaign.id) : undefined;
        const candidate = run
          ? result.workspace.candidates.find((item) => item.campaignId === campaign?.id && item.runId === run.id)
          : undefined;
        setSelectedCampaignId(campaign?.id ?? "");
        setSelectedRunId(run?.id ?? "");
        setSelectedCandidateId(candidate?.id ?? "");
      })
      .catch((error) => {
        if (active) setNotice({ type: "error", text: error instanceof Error ? error.message : "No fue posible cargar prospección." });
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [repository]);

  const hasLiveRuns = Boolean(
    workspace?.runs.some((run) => ["pending", "running", "cancel_requested"].includes(run.status) || ["pending", "running"].includes(run.enrichmentStatus)),
  );

  useEffect(() => {
    if (!hasLiveRuns) return;
    const refreshIfVisible = () => {
      if (!document.hidden && !busyAction) void refreshWorkspace(false);
    };
    const intervalId = window.setInterval(refreshIfVisible, 12_000);
    document.addEventListener("visibilitychange", refreshIfVisible);
    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", refreshIfVisible);
    };
  }, [busyAction, hasLiveRuns, refreshWorkspace]);

  const selectedCampaign = workspace?.campaigns.find((campaign) => campaign.id === selectedCampaignId);
  const campaignRuns = useMemo(
    () =>
      (workspace?.runs ?? [])
        .filter((run) => run.campaignId === selectedCampaignId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [selectedCampaignId, workspace?.runs],
  );
  const selectedRun = campaignRuns.find((run) => run.id === selectedRunId) ?? campaignRuns[0];
  const campaignCandidates = useMemo(
    () =>
      (workspace?.candidates ?? []).filter(
        (candidate) => candidate.campaignId === selectedCampaignId && candidate.runId === selectedRun?.id,
      ),
    [selectedCampaignId, selectedRun?.id, workspace?.candidates],
  );
  const candidateComunas = useMemo(
    () =>
      Array.from(
        new Set(campaignCandidates.flatMap((candidate) => candidate.locations.map((location) => location.comunaName)).filter(Boolean)),
      ).sort(),
    [campaignCandidates],
  );
  const filteredCandidates = useMemo(() => {
    const query = normalizeString(candidateQuery);
    return campaignCandidates
      .filter((candidate) =>
        candidateStatus === "all"
        || (candidateStatus === "active" && ["pending", "possible_duplicate"].includes(candidate.reviewStatus))
        || candidate.reviewStatus === candidateStatus,
      )
      .filter(
        (candidate) =>
          candidateSource === "all" || candidate.evidence.some((evidence) => evidence.source === candidateSource),
      )
      .filter(
        (candidate) =>
          candidateComuna === "all" || candidate.locations.some((location) => location.comunaName === candidateComuna),
      )
      .filter((candidate) => {
        if (!query) return true;
        return normalizeString(
          [candidate.name, candidate.legalName, candidate.rut, candidate.phone, candidate.email, candidate.businessLine, candidate.companySummary]
            .concat(candidate.locations.map((location) => `${location.comunaName} ${location.address}`))
            .join(" "),
        ).includes(query);
      })
      .sort((a, b) => (b.marketScore || b.score) - (a.marketScore || a.score));
  }, [campaignCandidates, candidateComuna, candidateQuery, candidateSource, candidateStatus]);
  const selectedCandidate =
    filteredCandidates.find((candidate) => candidate.id === selectedCandidateId) ?? filteredCandidates[0];

  useEffect(() => {
    if (!workspace?.campaigns.length) {
      setSelectedCampaignId("");
      return;
    }
    if (!workspace.campaigns.some((campaign) => campaign.id === selectedCampaignId)) {
      setSelectedCampaignId(workspace.campaigns[0].id);
    }
  }, [selectedCampaignId, workspace?.campaigns]);

  useEffect(() => {
    if (!campaignRuns.length) {
      setSelectedRunId("");
      return;
    }
    if (!campaignRuns.some((run) => run.id === selectedRunId)) setSelectedRunId(campaignRuns[0].id);
  }, [campaignRuns, selectedRunId]);

  useEffect(() => {
    if (!campaignCandidates.length) {
      setSelectedCandidateId("");
      return;
    }
    if (!campaignCandidates.some((candidate) => candidate.id === selectedCandidateId)) {
      setSelectedCandidateId(campaignCandidates[0].id);
    }
  }, [campaignCandidates, selectedCandidateId]);

  if (loading || !workspace) {
    return (
      <section className="page-stack prospecting-loading">
        <RefreshCw className="spin" size={28} />
        <strong>Preparando el centro de prospección…</strong>
      </section>
    );
  }

  async function saveCampaign(campaign: ProspectingCampaign) {
    const editing = Boolean(editingCampaignId);
    if (editing && !user) return;
    setBusyAction(editing ? `edit:${campaign.id}` : "create");
    setNotice(null);
    try {
      const saved = editing
        ? await repository.updateCampaign(campaign, user!.id)
        : await repository.createCampaign(campaign);
      setWorkspace((current) => {
        if (!current) return current;
        return {
          ...current,
          campaigns: editing
            ? current.campaigns.map((item) => (item.id === saved.id ? saved : item))
            : [saved, ...current.campaigns],
        };
      });
      setSelectedCampaignId(saved.id);
      setShowForm(false);
      setEditingCampaignId("");
      setNotice({
        type: "success",
        text: editing
          ? `Campaña actualizada a la versión ${saved.version}. Las ejecuciones anteriores conservan su snapshot.`
          : "Campaña de prospección guardada como borrador.",
      });
    } catch (error) {
      setNotice({ type: "error", text: errorMessage(error) });
    } finally {
      setBusyAction("");
    }
  }

  function editCampaign(campaign: ProspectingCampaign) {
    selectCampaign(campaign);
    setEditingCampaignId(campaign.id);
    setShowForm(true);
    setTab("campaigns");
  }

  async function startRun(campaign: ProspectingCampaign) {
    if (!user || !canExecute) return;
    if (requiresOfficialWebsite(campaign.sources)) {
      setNotice({
        type: "error",
        text: "No se puede iniciar: Brave descubre empresas, pero el sitio oficial debe validar contacto y domicilio.",
      });
      return;
    }
    setBusyAction(`run:${campaign.id}`);
    setNotice(null);
    try {
      const result = await repository.startRun(campaign, user.id);
      setWorkspace((current) =>
        current
          ? {
              ...current,
              campaigns: current.campaigns.map((item) =>
                item.id === campaign.id ? { ...item, status: "active", updatedAt: result.run.createdAt } : item,
              ),
              runs: [result.run, ...current.runs],
              events: [result.event, ...current.events],
            }
          : current,
      );
      setSelectedRunId(result.run.id);
      setTab("operation");
      setNotice({ type: "success", text: "Nueva ejecución encolada. El agente podrá tomarla cuando esté conectado." });
    } catch (error) {
      setNotice({ type: "error", text: errorMessage(error) });
    } finally {
      setBusyAction("");
    }
  }

  async function cancelRun(run: ProspectingRun) {
    if (!user || !canExecute) return;
    setBusyAction(`cancel:${run.id}`);
    setNotice(null);
    try {
      const result = await repository.requestCancellation(run.id, user.id);
      setWorkspace((current) =>
        current
          ? {
              ...current,
              runs: current.runs.map((item) => (item.id === run.id ? result.run : item)),
              events: [result.event, ...current.events],
            }
          : current,
      );
      setNotice({ type: "success", text: "Cancelación solicitada. Se conservarán los candidatos ya encontrados." });
    } catch (error) {
      setNotice({ type: "error", text: errorMessage(error) });
    } finally {
      setBusyAction("");
    }
  }

  async function controlRun(run: ProspectingRun, action: "pause" | "resume") {
    if (!user || !canExecute) return;
    setBusyAction(`${action}:${run.id}`);
    setNotice(null);
    try {
      const result = action === "pause" ? await repository.pauseRun(run.id, user.id) : await repository.resumeRun(run.id, user.id);
      setWorkspace((current) => current ? { ...current, runs: current.runs.map((item) => item.id === run.id ? result.run : item), events: [result.event, ...current.events] } : current);
      setNotice({ type: "success", text: action === "pause" ? "EjecuciÃ³n pausada. Los resultados obtenidos se conservan." : "EjecuciÃ³n reanudada y disponible para el agente." });
    } catch (error) { setNotice({ type: "error", text: errorMessage(error) }); }
    finally { setBusyAction(""); }
  }

  async function startEnrichment(run: ProspectingRun) {
    if (!canExecute) return;
    setBusyAction(`enrich:${run.id}`); setNotice(null);
    try {
      const updated = await repository.enqueueEnrichment(run.id);
      setWorkspace((current) => current ? { ...current, runs: current.runs.map((item) => item.id === run.id ? updated : item) } : current);
      setNotice({ type: "success", text: `${updated.enrichmentTotal} candidatos quedaron en cola para investigaciÃ³n web.` });
    } catch (error) { setNotice({ type: "error", text: errorMessage(error) }); }
    finally { setBusyAction(""); }
  }

  async function controlEnrichment(run: ProspectingRun, action: "pause" | "resume") {
    if (!canExecute) return;
    setBusyAction(`enrichment-${action}:${run.id}`); setNotice(null);
    try {
      const updated = await repository.controlEnrichment(run.id, action);
      setWorkspace((current) => current ? { ...current, runs: current.runs.map((item) => item.id === run.id ? updated : item) } : current);
      setNotice({ type: "success", text: action === "pause" ? "InvestigaciÃ³n pausada." : "InvestigaciÃ³n reanudada." });
    } catch (error) { setNotice({ type: "error", text: errorMessage(error) }); }
    finally { setBusyAction(""); }
  }

  function updateCandidate(candidate: ProspectCandidate) {
    setWorkspace((current) =>
      current
        ? { ...current, candidates: current.candidates.map((item) => (item.id === candidate.id ? candidate : item)) }
        : current,
    );
  }

  async function confirmCandidateEvidence(candidate: ProspectCandidate) {
    if (!user || !canReview) return;
    setBusyAction(`verify:${candidate.id}`);
    setNotice(null);
    try {
      const verified = await repository.confirmCandidateEvidence(candidate.id);
      updateCandidate(verified);
      setNotice({ type: "success", text: "Verificacion registrada. Ya puedes aprobar o vincular este prospecto." });
    } catch (error) {
      setNotice({ type: "error", text: errorMessage(error) });
    } finally {
      setBusyAction("");
    }
  }

  async function approveCandidate(candidate: ProspectCandidate) {
    if (!user || !canReview) return;
    if (hasIdentityConflict(candidate)) {
      setNotice({ type: "error", text: "Los identificadores son contradictorios. Vincula una empresa explícitamente o rechaza el candidato." });
      return;
    }
    if (!candidate.importEligible) {
      setNotice({ type: "error", text: "Este candidato no tiene evidencia permanente suficiente para aprobarlo." });
      return;
    }
    setBusyAction(`review:${candidate.id}`);
    setNotice(null);
    try {
      let localCompanyId = "";
      if (repository.dataMode === "demo") {
        const importableLocations = candidate.importableLocationIndexes
          .map((index) => candidate.locations[index])
          .filter((location): location is ProspectCandidate["locations"][number] => Boolean(location));
        const primary = importableLocations.find((location) => location.isPrimary) ?? importableLocations[0];
        const created = createCompany(
          candidateToCompany(candidate, primary?.regionName ?? "", primary?.comunaName ?? "", primary?.address ?? ""),
          { localOnly: true },
        );
        localCompanyId = created.id;
      }
      const reviewed = await repository.reviewCandidate(
        candidate.id,
        "approved",
        user.id,
        localCompanyId,
        "Aprobado manualmente desde la bandeja de prospección.",
      );
      updateCandidate(reviewed);
      setNotice({ type: "success", text: `${candidate.name} fue aprobado y agregado como prospecto.` });
    } catch (error) {
      setNotice({ type: "error", text: errorMessage(error) });
    } finally {
      setBusyAction("");
    }
  }

  async function rejectCandidate(candidate: ProspectCandidate) {
    if (!user || !canReview) return;
    setBusyAction(`review:${candidate.id}`);
    setNotice(null);
    try {
      const reviewed = await repository.reviewCandidate(
        candidate.id,
        "rejected",
        user.id,
        "",
        "Descartado durante la revisión comercial.",
      );
      updateCandidate(reviewed);
      setNotice({ type: "success", text: `${candidate.name} fue rechazado y no se agregó a Empresas.` });
    } catch (error) {
      setNotice({ type: "error", text: errorMessage(error) });
    } finally {
      setBusyAction("");
    }
  }

  async function linkCandidate(candidate: ProspectCandidate) {
    if (!user || !canReview || !companyToLink) return;
    if (!candidate.importEligible) {
      setNotice({ type: "error", text: "Este candidato no tiene evidencia permanente suficiente para vincularlo." });
      return;
    }
    const company = companies.find((item) => item.id === companyToLink);
    if (!company) return;
    setBusyAction(`review:${candidate.id}`);
    setNotice(null);
    try {
      const reviewed = await repository.reviewCandidate(
        candidate.id,
        "linked",
        user.id,
        company.id,
        `Vinculado manualmente a ${company.name}.`,
      );
      updateCandidate(reviewed);
      setCompanyToLink("");
      setNotice({ type: "success", text: `${candidate.name} quedó vinculado a ${company.name}.` });
    } catch (error) {
      setNotice({ type: "error", text: errorMessage(error) });
    } finally {
      setBusyAction("");
    }
  }

  function selectCampaign(campaign: ProspectingCampaign) {
    if (!workspace) return;
    setSelectedCampaignId(campaign.id);
    const run = workspace.runs
      .filter((item) => item.campaignId === campaign.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    const candidate = run
      ? workspace.candidates.find((item) => item.campaignId === campaign.id && item.runId === run.id)
      : undefined;
    setSelectedRunId(run?.id ?? "");
    setSelectedCandidateId(candidate?.id ?? "");
  }

  const pendingCandidates = campaignCandidates.filter((candidate) =>
    ["pending", "possible_duplicate"].includes(candidate.reviewStatus),
  ).length;
  const editingCampaign = workspace.campaigns.find((campaign) => campaign.id === editingCampaignId);
  const canEditCampaign = (campaign: ProspectingCampaign) =>
    role === "administrador" || (role === "vendedor" && campaign.status === "draft");
  return (
    <section className="page-stack prospecting-page">
      <div className="page-heading prospecting-heading">
        <div>
          <p>Búsqueda territorial controlada desde el CRM</p>
          <h1>Prospección</h1>
          <span className="prospecting-subtitle">Encuentra empresas HVAC, revisa evidencia y aprueba antes de crear prospectos.</span>
        </div>
        <div className="prospecting-heading-actions">
          <span className={`data-mode-badge ${dataMode}`}>
            <Database size={15} /> {dataMode === "supabase" ? "Datos CRM" : "Demo local"}
          </span>
          <button
            className="ghost-button prospecting-refresh-button"
            type="button"
            disabled={refreshing || Boolean(busyAction)}
            onClick={() => void refreshWorkspace(true)}
            title={lastRefreshedAt ? `Última actualización: ${formatDateTime(lastRefreshedAt)}` : "Actualizar datos"}
          >
            <RefreshCw className={refreshing ? "spin" : undefined} size={17} />
            {refreshing ? "Actualizando…" : hasLiveRuns ? "Actualizar · auto 12 s" : "Actualizar"}
          </button>
          {canDraft ? (
            <button
              className="primary-button"
              type="button"
              onClick={() => {
                if (tab !== "campaigns") {
                  setTab("campaigns");
                  setEditingCampaignId("");
                  setShowForm(true);
                } else {
                  if (formOpen) {
                    setShowForm(false);
                    setEditingCampaignId("");
                  } else {
                    setEditingCampaignId("");
                    setShowForm(true);
                  }
                }
              }}
            >
              {formOpen ? <X size={18} /> : <Plus size={18} />}
              {formOpen ? "Cerrar formulario" : "Nueva búsqueda"}
            </button>
          ) : null}
        </div>
      </div>

      {modeReason ? (
        <div className="prospecting-mode-notice">
          <ShieldCheck size={20} />
          <div>
            <strong>Entorno seguro de validación</strong>
            <span>{modeReason}</span>
          </div>
        </div>
      ) : null}
      {notice ? <div className={`prospecting-notice ${notice.type}`}>{notice.text}</div> : null}

      <div className="prospecting-tabs" role="tablist" aria-label="Vistas de prospección">
        <TabButton active={tab === "campaigns"} onClick={() => setTab("campaigns")} icon={<ListChecks size={17} />}>
          Campañas
        </TabButton>
        <TabButton active={tab === "operation"} onClick={() => setTab("operation")} icon={<Globe2 size={17} />}>
          Operación
        </TabButton>
        <TabButton active={tab === "candidates"} onClick={() => setTab("candidates")} icon={<Building2 size={17} />}>
          Candidatos <span className="tab-count">{pendingCandidates}</span>
        </TabButton>
        <TabButton active={tab === "historical"} onClick={() => setTab("historical")} icon={<Database size={17} />}>
          Base histórica
        </TabButton>
      </div>

      {formOpen && canDraft ? (
        <CampaignForm
          key={editingCampaign?.id ?? "new-campaign"}
          regions={workspace.regions}
          comunas={workspace.comunas}
          userId={user?.id ?? ""}
          canConfigure={canConfigure}
          initialCampaign={editingCampaign}
          saving={busyAction === "create" || busyAction === `edit:${editingCampaign?.id}`}
          onSave={saveCampaign}
        />
      ) : null}

      {tab === "campaigns" ? (
        <CampaignsView
          campaigns={workspace.campaigns}
          runs={workspace.runs}
          candidates={workspace.candidates}
          selectedCampaignId={selectedCampaignId}
          onSelect={selectCampaign}
          onStart={(campaign) => void startRun(campaign)}
          onEdit={editCampaign}
          canEdit={canEditCampaign}
          canExecute={canExecute}
          busyAction={busyAction}
          onOpenRun={(run) => {
            setSelectedCampaignId(run.campaignId);
            setSelectedRunId(run.id);
            setTab("operation");
          }}
        />
      ) : null}

      {tab === "operation" ? (
        <OperationView
          campaign={selectedCampaign}
          runs={campaignRuns}
          selectedRun={selectedRun}
          events={workspace.events.filter((event) => event.runId === selectedRun?.id)}
          canExecute={canExecute}
          busyAction={busyAction}
          onSelectRun={setSelectedRunId}
          onStart={() => selectedCampaign && void startRun(selectedCampaign)}
          onCancel={(run) => void cancelRun(run)}
          onControlRun={(run, action) => void controlRun(run, action)}
          onStartEnrichment={(run) => void startEnrichment(run)}
          onControlEnrichment={(run, action) => void controlEnrichment(run, action)}
        />
      ) : null}

      {tab === "candidates" ? (
        <CandidatesView
          campaign={selectedCampaign}
          runs={campaignRuns}
          selectedRun={selectedRun}
          candidates={filteredCandidates}
          allCandidates={workspace.candidates}
          totalCandidates={campaignCandidates.length}
          selectedCandidate={selectedCandidate}
          companies={companies}
          canReview={canReview}
          busyAction={busyAction}
          query={candidateQuery}
          status={candidateStatus}
          source={candidateSource}
          comuna={candidateComuna}
          comunas={candidateComunas}
          companyToLink={companyToLink}
          onSelectRun={setSelectedRunId}
          onQuery={setCandidateQuery}
          onStatus={setCandidateStatus}
          onSource={setCandidateSource}
          onComuna={setCandidateComuna}
          onSelect={setSelectedCandidateId}
          onCompanyToLink={setCompanyToLink}
          onApprove={(candidate) => void approveCandidate(candidate)}
          onConfirmEvidence={(candidate) => void confirmCandidateEvidence(candidate)}
          onReject={(candidate) => void rejectCandidate(candidate)}
          onLink={(candidate) => void linkCandidate(candidate)}
        />
      ) : null}

      {tab === "historical" ? <HistoricalBaseView role={role} onNotice={setNotice} /> : null}

      <div className="prospecting-role-note">
        <ShieldCheck size={16} />
        {role === "administrador"
          ? "Administrador: puedes configurar, iniciar, cancelar y revisar búsquedas."
          : role === "vendedor"
            ? "Vendedor: puedes crear borradores y revisar candidatos; un administrador inicia las ejecuciones."
            : "Visualizador: acceso de solo lectura."}
      </div>
    </section>
  );
}

function CampaignForm({
  regions,
  comunas,
  userId,
  canConfigure,
  initialCampaign,
  saving,
  onSave,
}: {
  regions: GeoRegion[];
  comunas: GeoComuna[];
  userId: string;
  canConfigure: boolean;
  initialCampaign?: ProspectingCampaign;
  saving: boolean;
  onSave: (campaign: ProspectingCampaign) => Promise<void>;
}) {
  const defaultRegion = regions.find((region) => region.code === "13")?.code ?? regions[0]?.code ?? "";
  const [name, setName] = useState(initialCampaign?.name ?? "");
  const [description, setDescription] = useState(initialCampaign?.description ?? "");
  const [keywords, setKeywords] = useState(initialCampaign?.keywords ?? DEFAULT_PROSPECTING_KEYWORDS.slice(0, 3));
  const [keywordDraft, setKeywordDraft] = useState("");
  const [sources, setSources] = useState<ProspectingSource[]>(
    initialCampaign?.sources ?? ["google_places", "brave_search", "official_website"],
  );
  const [targetTypes, setTargetTypes] = useState<CompanyType[]>(
    initialCampaign?.targetTypes ?? ["tecnico", "instalador grande"],
  );
  const initialRadar = Boolean(initialCampaign)
    && initialCampaign!.targetTypes.some((type) => ["distribuidor", "tienda comercial", "competencia"].includes(type))
    && !initialCampaign!.targetTypes.some((type) => ["tecnico", "instalador grande"].includes(type));
  const [searchMode, setSearchMode] = useState<"territorial" | "market_radar">(initialRadar ? "market_radar" : "territorial");
  const [activeRegionCode, setActiveRegionCode] = useState(initialCampaign?.territories[0]?.regionCode ?? defaultRegion);
  const [selection, setSelection] = useState<Record<string, string[]>>(() =>
    Object.fromEntries((initialCampaign?.territories ?? []).map((territory) => [territory.regionCode, territory.comunaCodes])),
  );
  const [resultsPerTask, setResultsPerTask] = useState(initialCampaign?.limits.resultsPerTask ?? 20);
  const [maxCandidates, setMaxCandidates] = useState(initialCampaign?.limits.maxCandidates ?? 1000);
  const [formError, setFormError] = useState("");

  const activeComunas = comunas.filter((comuna) => comuna.regionCode === activeRegionCode);
  const activeSelection = selection[activeRegionCode] ?? [];
  const selectedTerritories = useMemo(
    () =>
      regions
        .map((region) => {
          const codes = selection[region.code] ?? [];
          if (!codes.length) return null;
          const selected = comunas.filter((comuna) => comuna.regionCode === region.code && codes.includes(comuna.code));
          const allRegionComunas = comunas.filter((comuna) => comuna.regionCode === region.code);
          return {
            regionCode: region.code,
            regionName: region.name,
            allCommunes: selected.length === allRegionComunas.length,
            comunaCodes: selected.map((comuna) => comuna.code),
            comunaNames: selected.map((comuna) => comuna.name),
          } satisfies ProspectingTerritory;
        })
        .filter((territory): territory is ProspectingTerritory => Boolean(territory)),
    [comunas, regions, selection],
  );
  const selectedComunaCount = selectedTerritories.reduce((total, territory) => total + territory.comunaCodes.length, 0);
  const discoverySourceCount = sources.filter(
    (source) => SOURCE_DEFINITIONS.find((definition) => definition.id === source)?.discovery,
  ).length;
  const estimatedTasks = selectedComunaCount * keywords.length * discoverySourceCount;
  const estimatedCandidates = Math.min(maxCandidates, estimatedTasks * resultsPerTask);
  const braveNeedsOfficialWebsite = requiresOfficialWebsite(sources);
  const googleOnlyDiscovery =
    sources.includes("google_places") && !sources.includes("brave_search") && !sources.includes("official_website");

  function toggleComuna(code: string) {
    setSelection((current) => {
      const selected = current[activeRegionCode] ?? [];
      return {
        ...current,
        [activeRegionCode]: selected.includes(code) ? selected.filter((item) => item !== code) : [...selected, code],
      };
    });
  }

  function toggleAllActiveRegion() {
    setSelection((current) => ({
      ...current,
      [activeRegionCode]: activeSelection.length === activeComunas.length ? [] : activeComunas.map((comuna) => comuna.code),
    }));
  }

  function addKeyword() {
    const clean = keywordDraft.trim();
    if (!clean) return;
    if (clean.length > PROSPECTING_KEYWORD_MAX_LENGTH) {
      setFormError(`Cada palabra clave puede tener hasta ${PROSPECTING_KEYWORD_MAX_LENGTH} caracteres.`);
      return;
    }
    if (keywords.length >= PROSPECTING_KEYWORDS_MAX_COUNT) {
      setFormError(`Puedes agregar como máximo ${PROSPECTING_KEYWORDS_MAX_COUNT} palabras clave.`);
      return;
    }
    const casefolded = clean.toLocaleLowerCase("es-CL");
    if (keywords.some((keyword) => keyword.trim().toLocaleLowerCase("es-CL") === casefolded)) {
      setFormError("La palabra clave ya fue agregada.");
      return;
    }
    setKeywords((current) => [...current, clean]);
    setKeywordDraft("");
    setFormError("");
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    setFormError("");
    if (!name.trim()) return setFormError("Ingresa un nombre para identificar la búsqueda.");
    if (name.trim().length > PROSPECTING_CAMPAIGN_NAME_MAX_LENGTH) {
      return setFormError(`El nombre de la campaña no puede superar ${PROSPECTING_CAMPAIGN_NAME_MAX_LENGTH} caracteres.`);
    }
    if (!selectedTerritories.length) return setFormError("Selecciona al menos una comuna.");
    const normalizedKeywords = keywords.map((keyword) => keyword.trim());
    if (!normalizedKeywords.length || normalizedKeywords.length > PROSPECTING_KEYWORDS_MAX_COUNT) {
      return setFormError(`Agrega entre 1 y ${PROSPECTING_KEYWORDS_MAX_COUNT} palabras clave.`);
    }
    if (normalizedKeywords.some((keyword) => !keyword || keyword.length > PROSPECTING_KEYWORD_MAX_LENGTH)) {
      return setFormError(`Cada palabra clave debe tener entre 1 y ${PROSPECTING_KEYWORD_MAX_LENGTH} caracteres.`);
    }
    const normalizedCasefolded = normalizedKeywords.map((keyword) => keyword.toLocaleLowerCase("es-CL"));
    if (new Set(normalizedCasefolded).size !== normalizedCasefolded.length) {
      return setFormError("Las palabras clave no pueden estar duplicadas.");
    }
    if (!sources.some((source) => source !== "official_website")) return setFormError("Selecciona una fuente de descubrimiento.");
    if (braveNeedsOfficialWebsite) {
      return setFormError("Brave Search requiere el sitio oficial para validar contacto y domicilio antes de importar.");
    }
    if (!targetTypes.length) return setFormError("Selecciona al menos un tipo de empresa.");
    if (targetTypes.some((targetType) => !PROSPECTING_TARGET_TYPES.includes(targetType))) {
      return setFormError("La campaña contiene un tipo de empresa no permitido.");
    }
    const now = new Date().toISOString();
    void onSave({
      id: initialCampaign?.id ?? crypto.randomUUID(),
      version: initialCampaign?.version ?? 1,
      name: name.trim(),
      description: description.trim(),
      sector: "hvac",
      status: initialCampaign?.status ?? "draft",
      keywords: normalizedKeywords,
      sources: sources.filter((source) => source !== "amarillas"),
      territories: selectedTerritories,
      targetTypes,
      limits: {
        resultsPerTask: Math.min(20, Math.max(1, resultsPerTask)),
        maxCandidates: Math.min(1000, Math.max(1, maxCandidates)),
      },
      createdBy: initialCampaign?.createdBy ?? userId,
      createdAt: initialCampaign?.createdAt ?? now,
      updatedAt: now,
    });
  }

  return (
    <form className="panel prospecting-form" onSubmit={submit}>
      <div className="panel-heading prospecting-form-heading">
        <div>
          <h2>{initialCampaign ? `Editar campaña · versión ${initialCampaign.version}` : "Configurar búsqueda"}</h2>
          <span>
            {initialCampaign
              ? "Guardar crea una nueva versión de la definición; los runs anteriores no cambian."
              : "Se guardará como borrador. El inicio siempre es manual."}
          </span>
        </div>
        <span className="sector-lock"><SnowflakeMark /> Sector HVAC fijo</span>
      </div>

      <div className="prospecting-form-grid">
        <label>
          Nombre de la campaña
          <input
            value={name}
            maxLength={PROSPECTING_CAMPAIGN_NAME_MAX_LENGTH}
            onChange={(event) => setName(event.target.value)}
            placeholder="Ej. Instaladores HVAC Región del Maule"
          />
          <span
            className={`field-counter ${name.length >= PROSPECTING_CAMPAIGN_NAME_MAX_LENGTH ? "at-limit" : ""}`}
            aria-live="polite"
          >
            {name.length}/{PROSPECTING_CAMPAIGN_NAME_MAX_LENGTH}
          </span>
        </label>
        <label>
          Descripción operativa
          <input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Objetivo y perfil que debe encontrar el agente" />
        </label>
      </div>

      <div className="prospecting-form-section">
        <div className="prospecting-section-heading"><div><strong>Modalidad de búsqueda</strong><span>El Radar prioriza cobertura e importancia comercial; la búsqueda territorial prioriza empresas por comuna.</span></div></div>
        <div className="target-type-grid">
          <label className="checkbox-card">
            <input type="radio" name="search-mode" checked={searchMode === "territorial"} onChange={() => setSearchMode("territorial")} />
            Búsqueda territorial
          </label>
          <label className="checkbox-card">
            <input type="radio" name="search-mode" checked={searchMode === "market_radar"} onChange={() => {
              setSearchMode("market_radar");
              setTargetTypes(["distribuidor", "tienda comercial", "competencia"]);
              setSources(["google_places", "brave_search", "official_website"]);
            }} />
            Radar de mercado
          </label>
        </div>
        {searchMode === "market_radar" ? <div className="source-contract-message info" role="status"><Sparkles size={17} /><span><strong>Descubrimiento amplio activado</strong>Brave buscará distribuidores, mayoristas, importadores, tiendas, catálogos y marcas a nivel regional y nacional. Google Places validará ubicación y el sitio oficial completará la investigación.</span></div> : null}
      </div>

      <div className="prospecting-form-section">
        <div className="prospecting-section-heading">
          <div>
            <strong>1. Regiones y comunas</strong>
            <span>La ejecución usa cada comuna seleccionada como alcance canónico.</span>
          </div>
          <span className="selection-counter">{selectedComunaCount} comunas</span>
        </div>
        <div className="territory-picker">
          <div className="territory-region-list">
            <label>
              Región a configurar
              <select value={activeRegionCode} onChange={(event) => setActiveRegionCode(event.target.value)}>
                {regions.map((region) => (
                  <option key={region.code} value={region.code}>{region.name}</option>
                ))}
              </select>
            </label>
            <div className="territory-summary-list">
              {selectedTerritories.length ? (
                selectedTerritories.map((territory) => (
                  <button key={territory.regionCode} type="button" onClick={() => setActiveRegionCode(territory.regionCode)}>
                    <MapPin size={15} />
                    <span><strong>{territory.regionName}</strong><small>{territory.allCommunes ? "Toda la región" : `${territory.comunaCodes.length} comunas`}</small></span>
                    <ChevronRight size={15} />
                  </button>
                ))
              ) : (
                <p>Selecciona comunas para construir el alcance.</p>
              )}
            </div>
          </div>
          <div className="territory-comunas">
            <div className="territory-comunas-heading">
              <strong>{regions.find((region) => region.code === activeRegionCode)?.name}</strong>
              <button className="ghost-button compact-button" type="button" onClick={toggleAllActiveRegion}>
                <Check size={15} />
                {activeSelection.length === activeComunas.length ? "Quitar región completa" : "Toda la región"}
              </button>
            </div>
            <div className="comuna-grid">
              {activeComunas.map((comuna) => (
                <label key={comuna.code} className="comuna-option">
                  <input type="checkbox" checked={activeSelection.includes(comuna.code)} onChange={() => toggleComuna(comuna.code)} />
                  <span>{comuna.name}</span>
                </label>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="prospecting-form-section">
        <div className="prospecting-section-heading">
          <div>
            <strong>2. Palabras clave HVAC</strong>
            <span>Combina términos que describan servicios, tiendas e instaladores.</span>
          </div>
        </div>
        <div className="keyword-editor">
          <div className="keyword-input-row">
            <input
              value={keywordDraft}
              maxLength={PROSPECTING_KEYWORD_MAX_LENGTH}
              onChange={(event) => setKeywordDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addKeyword();
                }
              }}
              placeholder="Agregar palabra clave"
            />
            <button className="ghost-button" type="button" onClick={addKeyword}><Plus size={16} /> Agregar</button>
          </div>
          <div className="prospecting-chip-row">
            {keywords.map((keyword) => (
              <span key={keyword}>{keyword}<button type="button" onClick={() => setKeywords((current) => current.filter((item) => item !== keyword))} aria-label={`Quitar ${keyword}`}><X size={13} /></button></span>
            ))}
          </div>
        </div>
      </div>

      <div className="prospecting-form-section">
        <div className="prospecting-section-heading">
          <div>
            <strong>3. Fuentes autorizadas</strong>
            <span>Brave descubre empresas; el sitio oficial valida contacto y domicilio antes de importar.</span>
          </div>
        </div>
        <div className="source-grid">
          {SOURCE_DEFINITIONS.map((source) => {
            const checked = sources.includes(source.id);
            return (
              <label key={source.id} className={`source-option ${checked ? "selected" : ""} ${source.disabled ? "disabled" : ""}`}>
                <input
                  type="checkbox"
                  disabled={source.disabled}
                  checked={checked}
                  onChange={() =>
                    setSources((current) =>
                      current.includes(source.id) ? current.filter((item) => item !== source.id) : [...current, source.id],
                    )
                  }
                />
                <span className="source-icon">{source.id === "official_website" ? <Globe2 size={18} /> : source.disabled ? <Ban size={18} /> : <Search size={18} />}</span>
                <span><strong>{source.name}</strong><small>{source.description}</small></span>
                {source.disabled ? <em>No disponible</em> : checked ? <CheckCircle2 size={18} /> : null}
              </label>
            );
          })}
        </div>
        {braveNeedsOfficialWebsite ? (
          <div className="source-contract-message error" role="alert">
            <AlertTriangle size={17} />
            <span><strong>Configuración incompleta</strong>Activa “Sitio web oficial”. Brave Search descubre resultados, pero no reemplaza la validación permanente de contacto y domicilio.</span>
          </div>
        ) : googleOnlyDiscovery ? (
          <div className="source-contract-message info" role="status">
            <ShieldCheck size={17} />
            <span><strong>Búsqueda permitida, importación bloqueada</strong>Google Places puede descubrir candidatos, pero por sí solo no aporta evidencia permanente para aprobarlos o vincularlos.</span>
          </div>
        ) : null}
      </div>

      <div className="prospecting-form-split">
        <div className="prospecting-form-section compact-section">
          <div className="prospecting-section-heading"><strong>4. Tipos de empresa</strong></div>
          <div className="target-type-grid">
            {targetTypeLabels.map((type) => (
              <label key={type.id} className="checkbox-card">
                <input
                  type="checkbox"
                  checked={targetTypes.includes(type.id)}
                  onChange={() =>
                    setTargetTypes((current) =>
                      current.includes(type.id) ? current.filter((item) => item !== type.id) : [...current, type.id],
                    )
                  }
                />
                {type.label}
              </label>
            ))}
          </div>
        </div>
        <div className="prospecting-form-section compact-section">
          <div className="prospecting-section-heading">
            <strong>5. Límites de seguridad</strong>
            {!canConfigure ? <span>Solo un administrador puede modificarlos.</span> : null}
          </div>
          <div className="limit-grid">
            <label>Resultados por tarea<input type="number" min={1} max={20} disabled={!canConfigure} value={resultsPerTask} onChange={(event) => setResultsPerTask(Number(event.target.value))} /></label>
            <label>Máximo por ejecución<input type="number" min={1} max={1000} disabled={!canConfigure} value={maxCandidates} onChange={(event) => setMaxCandidates(Number(event.target.value))} /></label>
          </div>
        </div>
      </div>

      <div className="prospecting-estimate">
        <Sparkles size={20} />
        <div><strong>Estimación antes de iniciar</strong><span>{estimatedTasks.toLocaleString("es-CL")} tareas de descubrimiento · hasta {estimatedCandidates.toLocaleString("es-CL")} resultados brutos · tope final {maxCandidates.toLocaleString("es-CL")} candidatos</span></div>
        <div className="estimate-providers">
          {sources.filter((source) => SOURCE_DEFINITIONS.find((definition) => definition.id === source)?.discovery).map((source) => (
            <span key={source}>{sourceName(source)}: {selectedComunaCount * keywords.length} consultas</span>
          ))}
          {sources.includes("official_website") ? <span>Sitio oficial: validación posterior</span> : null}
          <small>Costo monetario no estimable hasta configurar el plan/API de cada proveedor.</small>
        </div>
      </div>

      {formError ? <p className="form-error">{formError}</p> : null}
      <div className="form-actions">
        <span className="form-safety-note"><ShieldCheck size={15} /> Guardar no inicia consultas ni crea empresas.</span>
        <button className="primary-button" type="submit" disabled={saving || braveNeedsOfficialWebsite}>
          {saving ? "Guardando…" : initialCampaign ? "Guardar nueva versión" : "Guardar borrador"}
        </button>
      </div>
    </form>
  );
}

function CampaignsView({
  campaigns,
  runs,
  candidates,
  selectedCampaignId,
  onSelect,
  onStart,
  onEdit,
  onOpenRun,
  canEdit,
  canExecute,
  busyAction,
}: {
  campaigns: ProspectingCampaign[];
  runs: ProspectingRun[];
  candidates: ProspectCandidate[];
  selectedCampaignId: string;
  onSelect: (campaign: ProspectingCampaign) => void;
  onStart: (campaign: ProspectingCampaign) => void;
  onEdit: (campaign: ProspectingCampaign) => void;
  onOpenRun: (run: ProspectingRun) => void;
  canEdit: (campaign: ProspectingCampaign) => boolean;
  canExecute: boolean;
  busyAction: string;
}) {
  const selectedCampaign = campaigns.find((campaign) => campaign.id === selectedCampaignId);
  const selectedRuns = runs.filter((run) => run.campaignId === selectedCampaignId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const selectedCandidates = candidates.filter((candidate) => candidate.campaignId === selectedCampaignId);
  const selectedCampaignNeedsOfficialWebsite = selectedCampaign
    ? requiresOfficialWebsite(selectedCampaign.sources)
    : false;

  return (
    <>
      <div className="prospecting-overview-grid">
        <MetricCard icon={<ListChecks size={20} />} label="Campañas" value={campaigns.length} detail="Definiciones reutilizables" />
        <MetricCard icon={<Clock3 size={20} />} label="Ejecuciones activas" value={runs.filter((run) => ["pending", "running", "cancel_requested"].includes(run.status)).length} detail="Pendientes o en proceso" />
        <MetricCard icon={<Building2 size={20} />} label="Por revisar" value={candidates.filter((candidate) => ["pending", "possible_duplicate"].includes(candidate.reviewStatus)).length} detail="No están aún en Empresas" />
        <MetricCard icon={<CheckCircle2 size={20} />} label="Aprobados" value={candidates.filter((candidate) => ["approved", "linked"].includes(candidate.reviewStatus)).length} detail="Creados o vinculados" />
      </div>

      <div className="panel">
        <div className="panel-heading">
          <div><h2>Campañas de búsqueda</h2><span>Separadas de las campañas de email y WhatsApp</span></div>
          <span>{campaigns.length} configuradas</span>
        </div>
        {campaigns.length ? (
          <div className="prospecting-campaign-grid">
            {campaigns.map((campaign) => {
              const campaignRuns = runs.filter((run) => run.campaignId === campaign.id);
              const latest = campaignRuns.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
              const candidateCount = candidates.filter((candidate) => candidate.campaignId === campaign.id).length;
              return (
                <article key={campaign.id} className={`prospecting-campaign-card ${campaign.id === selectedCampaignId ? "selected" : ""}`}>
                  <div className="campaign-card-top">
                    <span className={`status-badge prospecting-status ${campaign.status}`}>{campaignLabels[campaign.status]}</span>
                    <span>v{campaign.version} · {formatDate(campaign.updatedAt)}</span>
                  </div>
                  <div><p>HVAC · Chile</p><h3>{campaign.name}</h3><span className="campaign-description">{campaign.description || "Sin descripción operativa"}</span></div>
                  <div className="campaign-scope-summary"><MapPin size={16} /><span>{territorySummary(campaign.territories)}</span></div>
                  <div className="prospecting-chip-row compact">
                    {campaign.keywords.slice(0, 3).map((keyword) => <span key={keyword}>{keyword}</span>)}
                    {campaign.keywords.length > 3 ? <span>+{campaign.keywords.length - 3}</span> : null}
                  </div>
                  <dl>
                    <div><dt>Ejecuciones</dt><dd>{campaignRuns.length}</dd></div>
                    <div><dt>Candidatos</dt><dd>{candidateCount}</dd></div>
                    <div><dt>Último estado</dt><dd>{latest ? runLabels[latest.status] : "Sin iniciar"}</dd></div>
                  </dl>
                  <button className="ghost-button" type="button" onClick={() => onSelect(campaign)}><Eye size={16} /> Revisar campaña</button>
                </article>
              );
            })}
          </div>
        ) : (
          <EmptyState icon={<Search size={28} />} title="Aún no hay campañas" text="Crea un borrador para definir comunas, fuentes y palabras clave." />
        )}
      </div>

      {selectedCampaign ? (
        <div className="panel selected-campaign-panel">
          <div className="panel-heading">
            <div><h2>{selectedCampaign.name}</h2><span>Definición v{selectedCampaign.version} · {territorySummary(selectedCampaign.territories)} · {selectedCampaign.keywords.length} palabras clave</span></div>
            <div className="campaign-definition-actions">
              {canEdit(selectedCampaign) ? (
                <button className="ghost-button" type="button" onClick={() => onEdit(selectedCampaign)}>
                  <Pencil size={16} /> Editar definición
                </button>
              ) : null}
              {canExecute ? (
                <button
                  className="primary-button"
                  type="button"
                  disabled={busyAction === `run:${selectedCampaign.id}` || selectedCampaignNeedsOfficialWebsite}
                  title={selectedCampaignNeedsOfficialWebsite ? "Agrega el sitio oficial antes de iniciar una campaña con Brave Search" : undefined}
                  onClick={() => onStart(selectedCampaign)}
                >
                  <Play size={17} /> {selectedRuns.length ? "Nueva ejecución" : "Iniciar búsqueda"}
                </button>
              ) : <span className="read-only-hint"><ShieldCheck size={15} /> Requiere administrador para iniciar</span>}
            </div>
          </div>
          {selectedCampaignNeedsOfficialWebsite ? (
            <div className="source-contract-message error campaign-source-warning" role="alert">
              <AlertTriangle size={17} />
              <span><strong>No se puede iniciar esta definición</strong>Edita las fuentes y agrega “Sitio web oficial” para validar los resultados descubiertos por Brave Search.</span>
            </div>
          ) : null}
          <div className="campaign-detail-strip">
            <div><span>Fuentes</span><strong>{selectedCampaign.sources.map(sourceName).join(", ")}</strong></div>
            <div><span>Por tarea</span><strong>{selectedCampaign.limits.resultsPerTask} resultados</strong></div>
            <div><span>Tope por run</span><strong>{selectedCampaign.limits.maxCandidates.toLocaleString("es-CL")}</strong></div>
            <div><span>Revisión pendiente</span><strong>{selectedCandidates.filter((candidate) => ["pending", "possible_duplicate"].includes(candidate.reviewStatus)).length}</strong></div>
          </div>
          <div className="table-wrap">
            <table className="prospecting-runs-table">
              <thead><tr><th>Ejecución</th><th>Estado</th><th>Progreso</th><th>Candidatos</th><th>Inicio</th><th></th></tr></thead>
              <tbody>
                {selectedRuns.map((run, index) => (
                  <tr key={run.id}>
                    <td><strong>Run #{selectedRuns.length - index}</strong><small>{run.id.slice(0, 8)}</small></td>
                    <td><span className={`status-badge prospecting-status ${run.status}`}>{runLabels[run.status]}</span></td>
                    <td>{run.progress.completedTasks}/{run.progress.totalTasks} tareas<small>{run.progress.failedTasks} con error</small></td>
                    <td>{run.progress.candidatesFound}</td>
                    <td>{formatDateTime(run.startedAt || run.createdAt)}</td>
                    <td><button className="mini-toggle" type="button" onClick={() => onOpenRun(run)}>Ver actividad</button></td>
                  </tr>
                ))}
                {!selectedRuns.length ? <tr><td colSpan={6}><span className="empty-table-message">Esta campaña todavía no tiene ejecuciones.</span></td></tr> : null}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </>
  );
}

function OperationView({
  campaign,
  runs,
  selectedRun,
  events,
  canExecute,
  busyAction,
  onSelectRun,
  onStart,
  onCancel,
  onControlRun,
  onStartEnrichment,
  onControlEnrichment,
}: {
  campaign?: ProspectingCampaign;
  runs: ProspectingRun[];
  selectedRun?: ProspectingRun;
  events: ProspectingWorkspace["events"];
  canExecute: boolean;
  busyAction: string;
  onSelectRun: (id: string) => void;
  onStart: () => void;
  onCancel: (run: ProspectingRun) => void;
  onControlRun: (run: ProspectingRun, action: "pause" | "resume") => void;
  onStartEnrichment: (run: ProspectingRun) => void;
  onControlEnrichment: (run: ProspectingRun, action: "pause" | "resume") => void;
}) {
  if (!campaign) return <EmptyState icon={<Globe2 size={28} />} title="Selecciona una campaña" text="Elige una campaña para consultar su operación." />;
  const campaignNeedsOfficialWebsite = requiresOfficialWebsite(campaign.sources);
  if (!selectedRun) {
    return (
      <div className="panel">
        <EmptyState icon={<Play size={28} />} title="Sin ejecuciones" text="La definición está lista, pero aún no existe un run inmutable." />
        {campaignNeedsOfficialWebsite ? (
          <div className="source-contract-message error campaign-source-warning" role="alert">
            <AlertTriangle size={17} />
            <span><strong>Configuración incompleta</strong>Agrega “Sitio web oficial” antes de iniciar una búsqueda con Brave Search.</span>
          </div>
        ) : null}
        {canExecute ? <div className="center-action"><button className="primary-button" type="button" disabled={campaignNeedsOfficialWebsite} onClick={onStart}><Play size={17} /> Iniciar búsqueda</button></div> : null}
      </div>
    );
  }
  const processedTasks = selectedRun.progress.completedTasks + selectedRun.progress.failedTasks;
  const progressPercent = selectedRun.progress.totalTasks
    ? Math.min(100, Math.round((processedTasks / selectedRun.progress.totalTasks) * 100))
    : 0;
  const successPercent = selectedRun.progress.totalTasks
    ? Math.min(100, Math.round((selectedRun.progress.completedTasks / selectedRun.progress.totalTasks) * 100))
    : 0;
  const canCancel = ["pending", "running"].includes(selectedRun.status);
  const enrichmentActive = ["pending", "running"].includes(selectedRun.enrichmentStatus);
  const enrichmentPercent = selectedRun.enrichmentTotal
    ? Math.round(((selectedRun.enrichmentCompleted + selectedRun.enrichmentFailed) / selectedRun.enrichmentTotal) * 100)
    : 0;

  return (
    <>
      <div className="panel operation-header">
        <div className="operation-title-row">
          <div>
            <p>Monitor tipo browser-agent</p>
            <h2>{campaign.name}</h2>
            <span>Snapshot inmutable creado {formatDateTime(selectedRun.createdAt)}</span>
          </div>
          <div className="operation-controls">
            <label>Run<select value={selectedRun.id} onChange={(event) => onSelectRun(event.target.value)}>{runs.map((run, index) => <option key={run.id} value={run.id}>#{runs.length - index} · {runLabels[run.status]}</option>)}</select></label>
            {canExecute ? <button className="ghost-button" type="button" disabled={campaignNeedsOfficialWebsite} title={campaignNeedsOfficialWebsite ? "Agrega el sitio oficial antes de repetir" : undefined} onClick={onStart}><RefreshCw size={16} /> Repetir</button> : null}
            {canExecute && canCancel ? <button className="ghost-button" disabled={busyAction === `pause:${selectedRun.id}`} type="button" onClick={() => onControlRun(selectedRun, "pause")}><PauseCircle size={16} /> Pausar</button> : null}
            {canExecute && selectedRun.status === "paused" ? <button className="ghost-button" disabled={busyAction === `resume:${selectedRun.id}`} type="button" onClick={() => onControlRun(selectedRun, "resume")}><Play size={16} /> Reanudar</button> : null}
            {canExecute && canCancel ? <button className="ghost-button danger" disabled={busyAction === `cancel:${selectedRun.id}`} type="button" onClick={() => onCancel(selectedRun)}><Ban size={16} /> Cancelar</button> : null}
          </div>
        </div>
        {campaignNeedsOfficialWebsite ? (
          <div className="source-contract-message error campaign-source-warning" role="alert">
            <AlertTriangle size={17} />
            <span><strong>No se puede repetir esta definición</strong>Brave Search requiere el sitio oficial para validar contacto y domicilio.</span>
          </div>
        ) : null}
        <div className="operation-progress-row">
          <span className={`status-badge prospecting-status ${selectedRun.status}`}>{runLabels[selectedRun.status]}</span>
          <div className="run-progress"><div><span style={{ width: `${progressPercent}%` }} /></div><strong>{progressPercent}%</strong></div>
          <span>{selectedRun.progress.completedTasks} exitosas · {selectedRun.progress.failedTasks} con error · {processedTasks} de {selectedRun.progress.totalTasks} procesadas</span>
        </div>
        {selectedRun.lastError ? <div className="run-error"><AlertTriangle size={17} /><span><strong>Última incidencia</strong>{selectedRun.lastError}</span></div> : null}
      </div>

      <div className="panel operation-header">
        <div className="operation-title-row">
          <div><p>Investigación posterior</p><h2>Investigación del sitio oficial</h2><span>Profundiza cada candidato sin nuevas búsquedas Brave. Valida contacto, actividad y ubicación publicada.</span></div>
          <div className="operation-controls">
            {canExecute && selectedRun.enrichmentStatus === "not_requested" ? <button className="primary-button" type="button" disabled={busyAction === `enrich:${selectedRun.id}` || selectedRun.progress.candidatesFound === 0} onClick={() => onStartEnrichment(selectedRun)}><Sparkles size={16} /> Investigar {selectedRun.progress.candidatesFound} empresas</button> : null}
            {canExecute && enrichmentActive ? <button className="ghost-button" type="button" disabled={busyAction === `enrichment-pause:${selectedRun.id}`} onClick={() => onControlEnrichment(selectedRun, "pause")}><PauseCircle size={16} /> Pausar investigación</button> : null}
            {canExecute && selectedRun.enrichmentStatus === "paused" ? <button className="ghost-button" type="button" disabled={busyAction === `enrichment-resume:${selectedRun.id}`} onClick={() => onControlEnrichment(selectedRun, "resume")}><Play size={16} /> Reanudar investigación</button> : null}
            {canExecute && ["completed", "partial"].includes(selectedRun.enrichmentStatus) ? <button className="ghost-button" type="button" disabled={busyAction === `enrich:${selectedRun.id}`} onClick={() => onStartEnrichment(selectedRun)}><RefreshCw size={16} /> Investigar nuevamente</button> : null}
          </div>
        </div>
        <div className="operation-progress-row">
          <span className={`status-badge prospecting-status ${selectedRun.enrichmentStatus}`}>{selectedRun.enrichmentStatus === "not_requested" ? "Sin iniciar" : selectedRun.enrichmentStatus === "pending" ? "Pendiente" : selectedRun.enrichmentStatus === "running" ? "Investigando" : selectedRun.enrichmentStatus === "paused" ? "Pausada" : selectedRun.enrichmentStatus === "partial" ? "Parcial" : "Completada"}</span>
          <div className="run-progress"><div><span style={{ width: `${enrichmentPercent}%` }} /></div><strong>{enrichmentPercent}%</strong></div>
          <span>{selectedRun.enrichmentCompleted} completadas · {selectedRun.enrichmentFailed} con error · {selectedRun.enrichmentTotal} total</span>
        </div>
      </div>

      <div className="prospecting-overview-grid">
        <MetricCard icon={<ListChecks size={20} />} label="Tareas totales" value={selectedRun.progress.totalTasks} detail="Fuente × keyword × comuna" />
        <MetricCard icon={<CheckCircle2 size={20} />} label="Completadas" value={selectedRun.progress.completedTasks} detail={`${successPercent}% exitosas`} />
        <MetricCard icon={<AlertTriangle size={20} />} label="Con error" value={selectedRun.progress.failedTasks} detail="Con reintento o incidencia" />
        <MetricCard icon={<Building2 size={20} />} label="Candidatos" value={selectedRun.progress.candidatesFound} detail="Antes de revisión humana" />
      </div>

      <div className="two-column operation-columns">
        <div className="panel run-snapshot-panel">
          <div className="panel-heading"><h2>Alcance de esta ejecución</h2><span>Definición v{selectedRun.snapshot.campaignVersion} · contrato v{selectedRun.snapshot.schemaVersion}</span></div>
          <dl className="run-snapshot-grid">
            <div><dt>Territorio</dt><dd>{territorySummary(selectedRun.snapshot.territories)}</dd></div>
            <div><dt>Fuentes</dt><dd>{selectedRun.snapshot.sources.map(sourceName).join(", ")}</dd></div>
            <div><dt>Palabras clave</dt><dd>{selectedRun.snapshot.keywords.join(", ")}</dd></div>
            <div><dt>Límites</dt><dd>{selectedRun.snapshot.limits.resultsPerTask}/tarea · {selectedRun.snapshot.limits.maxCandidates}/run</dd></div>
          </dl>
        </div>
        <div className="panel agent-health-panel">
          <div className="panel-heading"><h2>Control operacional</h2><span><CircleDot size={14} /> Registro auditable</span></div>
          <div className="agent-health-list">
            <div><ShieldCheck size={18} /><span><strong>Sin envíos comerciales</strong><small>Este módulo sólo recopila y valida información.</small></span></div>
            <div><Database size={18} /><span><strong>Resultados persistentes</strong><small>Los reintentos no deben duplicar candidatos.</small></span></div>
            <div><Clock3 size={18} /><span><strong>Último evento</strong><small>{events[0] ? formatDateTime(events[0].createdAt) : "Esperando actividad del agente"}</small></span></div>
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-heading"><div><h2>Cronología del agente</h2><span>Consultas, filtros, reintentos y validaciones</span></div><span>{events.length} eventos</span></div>
        {events.length ? (
          <div className="agent-timeline">
            {[...events].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((event) => (
              <article key={event.id} className={event.level}>
                <div className="event-marker">{event.level === "error" ? <XCircle size={16} /> : event.level === "warning" ? <AlertTriangle size={16} /> : <Check size={16} />}</div>
                <div className="event-content">
                  <div><strong>{event.stage}</strong><time>{formatDateTime(event.createdAt)}</time></div>
                  <p>{event.message}</p>
                  <div className="event-context">
                    {event.source ? <span>{sourceName(event.source)}</span> : null}
                    {event.comunaName ? <span><MapPin size={12} /> {event.comunaName}</span> : null}
                    {event.keyword ? <span>“{event.keyword}”</span> : null}
                    {Object.entries(event.metrics).map(([key, value]) => <span key={key}>{humanize(key)}: {String(value)}</span>)}
                  </div>
                </div>
              </article>
            ))}
          </div>
        ) : <EmptyState icon={<Clock3 size={28} />} title="Esperando al agente" text="La actividad aparecerá aquí cuando el worker tome la ejecución." />}
      </div>
    </>
  );
}

function CandidatesView({
  campaign,
  runs,
  selectedRun,
  candidates,
  allCandidates,
  totalCandidates,
  selectedCandidate,
  companies,
  canReview,
  busyAction,
  query,
  status,
  source,
  comuna,
  comunas,
  companyToLink,
  onSelectRun,
  onQuery,
  onStatus,
  onSource,
  onComuna,
  onSelect,
  onCompanyToLink,
  onApprove,
  onConfirmEvidence,
  onReject,
  onLink,
}: {
  campaign?: ProspectingCampaign;
  runs: ProspectingRun[];
  selectedRun?: ProspectingRun;
  candidates: ProspectCandidate[];
  allCandidates: ProspectCandidate[];
  totalCandidates: number;
  selectedCandidate?: ProspectCandidate;
  companies: Company[];
  canReview: boolean;
  busyAction: string;
  query: string;
  status: CandidateStatusFilter;
  source: ProspectingSource | "all";
  comuna: string;
  comunas: string[];
  companyToLink: string;
  onSelectRun: (id: string) => void;
  onQuery: (value: string) => void;
  onStatus: (value: CandidateStatusFilter) => void;
  onSource: (value: ProspectingSource | "all") => void;
  onComuna: (value: string) => void;
  onSelect: (id: string) => void;
  onCompanyToLink: (id: string) => void;
  onApprove: (candidate: ProspectCandidate) => void;
  onConfirmEvidence: (candidate: ProspectCandidate) => void;
  onReject: (candidate: ProspectCandidate) => void;
  onLink: (candidate: ProspectCandidate) => void;
}) {
  if (!campaign) return <EmptyState icon={<Building2 size={28} />} title="Selecciona una campaña" text="Los candidatos siempre conservan su relación con la campaña y el run de origen." />;
  if (!selectedRun) return <EmptyState icon={<Play size={28} />} title="Sin ejecuciones" text="Inicia una ejecución para recibir candidatos en su bandeja independiente." />;

  return (
    <>
      <div className="panel candidate-filters">
        <label className="search-field"><Search size={18} /><input value={query} onChange={(event) => onQuery(event.target.value)} placeholder="Empresa, RUT, contacto o actividad" /></label>
        <label className="select-field">Ejecución<select value={selectedRun.id} onChange={(event) => onSelectRun(event.target.value)}>{runs.map((run, index) => <option key={run.id} value={run.id}>Run #{runs.length - index} · {runLabels[run.status]}</option>)}</select></label>
        <label className="select-field">Estado<select value={status} onChange={(event) => onStatus(event.target.value as CandidateStatusFilter)}><option value="active">Por revisar</option><option value="all">Todos (incluye descartados)</option>{Object.entries(reviewLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label className="select-field">Fuente<select value={source} onChange={(event) => onSource(event.target.value as ProspectingSource | "all")}><option value="all">Todas</option>{SOURCE_DEFINITIONS.filter((item) => !item.disabled).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label className="select-field">Comuna<select value={comuna} onChange={(event) => onComuna(event.target.value)}><option value="all">Todas</option>{comunas.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
        <span className="filter-result"><Filter size={16} /> {candidates.length} de {totalCandidates}</span>
      </div>

      <div className="candidate-workbench">
        <div className="panel candidate-list-panel">
          <div className="panel-heading"><div><h2>Bandeja de revisión</h2><span>Run del {formatDateTime(selectedRun.createdAt)} · sin mezclar ejecuciones históricas</span></div></div>
          <div className="candidate-list">
            {candidates.map((candidate) => {
              const primary = candidate.locations.find((location) => location.isPrimary) ?? candidate.locations[0];
              return (
                <button key={candidate.id} type="button" className={`candidate-row ${candidate.id === selectedCandidate?.id ? "selected" : ""}`} onClick={() => onSelect(candidate.id)}>
                  <span className="candidate-score">{Math.round(candidate.marketScore || candidate.score)}<small>{candidate.marketScore ? "mercado" : "score"}</small></span>
                  <span className="candidate-row-main"><strong>{candidate.name}</strong><small><MapPin size={12} /> {primary?.comunaName || "Sin comuna"} · {candidate.companyType}</small><em>{candidate.phone || candidate.email || candidate.website}</em></span>
                  <span className={`status-badge prospecting-status ${candidate.reviewStatus}`}>{reviewLabels[candidate.reviewStatus]}</span>
                  <ChevronRight size={17} />
                </button>
              );
            })}
            {!candidates.length ? <EmptyState icon={<Search size={24} />} title="Sin coincidencias" text="Prueba quitando uno de los filtros." /> : null}
          </div>
        </div>

        <div className="panel candidate-detail-panel">
          {selectedCandidate ? (
            <CandidateDetail
              candidate={selectedCandidate}
              duplicateProspect={allCandidates.find(
                (candidate) =>
                  candidate.runId === selectedCandidate.runId &&
                  candidate.externalCandidateId === selectedCandidate.possibleDuplicateExternalCandidateId,
              )}
              companies={companies}
              canReview={canReview}
              busy={busyAction === `review:${selectedCandidate.id}` || busyAction === `verify:${selectedCandidate.id}`}
              companyToLink={companyToLink}
              onCompanyToLink={onCompanyToLink}
              onApprove={() => onApprove(selectedCandidate)}
              onConfirmEvidence={() => onConfirmEvidence(selectedCandidate)}
              onReject={() => onReject(selectedCandidate)}
              onLink={() => onLink(selectedCandidate)}
            />
          ) : <EmptyState icon={<Building2 size={28} />} title="Selecciona un candidato" text="Aquí podrás contrastar contacto, ubicación y evidencia." />}
        </div>
      </div>
    </>
  );
}

function CandidateDetail({
  candidate,
  duplicateProspect,
  companies,
  canReview,
  busy,
  companyToLink,
  onCompanyToLink,
  onApprove,
  onConfirmEvidence,
  onReject,
  onLink,
}: {
  candidate: ProspectCandidate;
  duplicateProspect?: ProspectCandidate;
  companies: Company[];
  canReview: boolean;
  busy: boolean;
  companyToLink: string;
  onCompanyToLink: (id: string) => void;
  onApprove: () => void;
  onConfirmEvidence: () => void;
  onReject: () => void;
  onLink: () => void;
}) {
  const primary = candidate.locations.find((location) => location.isPrimary) ?? candidate.locations[0];
  const duplicate = companies.find((company) => company.id === candidate.possibleDuplicateCompanyId);
  const duplicateProspectLocation = duplicateProspect?.locations.find((location) => location.isPrimary)
    ?? duplicateProspect?.locations[0];
  const linked = companies.find((company) => company.id === candidate.linkedCompanyId);
  const reviewable = ["pending", "possible_duplicate"].includes(candidate.reviewStatus);
  const identityConflict = hasIdentityConflict(candidate);
  const website = safeExternalUrl(candidate.website);
  const importableLocationCount = candidate.importableLocationIndexes.length;
  const partialImport = candidate.importEligible && importableLocationCount < candidate.locations.length;
  const readinessId = `candidate-import-readiness-${candidate.id}`;
  const readinessClass = !candidate.importEligible ? "blocked" : identityConflict ? "partial" : partialImport ? "partial" : "ready";
  const readinessTitle = !candidate.importEligible
    ? "Importación bloqueada"
    : identityConflict
    ? "Vinculación manual requerida"
    : candidate.importEligible
    ? partialImport
      ? "Importación parcial"
      : "Listo para importar"
    : "Importación bloqueada";
  const readinessDescription = !candidate.importEligible
    ? "El agente no confirmó evidencia permanente suficiente. Aprobar y vincular están deshabilitados; rechazar sigue disponible."
    : identityConflict
    ? "Los identificadores exactos se contradicen. Aprobar está bloqueado; selecciona explícitamente una empresa para vincular o rechaza el candidato."
    : candidate.importEligible
    ? partialImport
      ? `Se importarán ${importableLocationCount} de ${candidate.locations.length} sedes. Las demás quedarán fuera del CRM por falta de evidencia permanente.`
      : `Se importarán ${importableLocationCount} ${importableLocationCount === 1 ? "sede" : "sedes"} respaldadas por evidencia permanente.`
    : "El agente no confirmó evidencia permanente suficiente. Aprobar y vincular están deshabilitados; rechazar sigue disponible.";

  return (
    <>
      <div className="candidate-detail-heading">
        <div><span className={`status-badge prospecting-status ${candidate.reviewStatus}`}>{reviewLabels[candidate.reviewStatus]}</span><h2>{candidate.name}</h2><p>{candidate.legalName || candidate.businessLine}</p></div>
        <div className="score-ring"><strong>{Math.round(candidate.marketScore || candidate.score)}</strong><span>{candidate.marketScore ? "mercado" : "de 100"}</span></div>
      </div>
      {candidate.reviewStatus === "possible_duplicate" ? (
        <div className="duplicate-alert">
          <AlertTriangle size={19} />
          <span>
            <strong>Requiere decisión humana</strong>
            {duplicate
              ? `Coincide con la empresa ${duplicate.name}.`
              : duplicateProspect
                ? `Coincide con el candidato ${duplicateProspect.name}${duplicateProspectLocation ? ` de ${duplicateProspectLocation.comunaName}` : ""}.`
                : candidate.possibleDuplicateExternalCandidateId
                  ? "Coincide con otro candidato detectado por el agente, pero no está disponible en esta ejecución."
                  : candidate.reviewNotes || "Hay señales de una empresa ya registrada."}
          </span>
        </div>
      ) : null}
      {linked ? <div className="linked-alert"><Link2 size={18} /><span>Vinculado a <strong>{linked.name}</strong>. No se creó un duplicado.</span></div> : null}

      {candidate.companySummary ? (
        <div className="candidate-import-readiness ready" role="status">
          <Building2 size={19} />
          <div><strong>Descripción investigada</strong><p>{candidate.companySummary}</p></div>
        </div>
      ) : null}

      {candidate.marketScore ? (
        <div className="candidate-import-readiness ready" role="status">
          <Sparkles size={19} />
          <div><strong>Importancia de mercado: {Math.round(candidate.marketScore)}/100</strong><p>Apareció en {Number(candidate.marketSignals?.query_hits || 0)} búsquedas; mejor posición {Number(candidate.marketSignals?.best_rank || 0) || "sin dato"}. El ranking también considera perfil comercial, marcas, sucursales y evidencia oficial.</p></div>
        </div>
      ) : null}

      <div
        id={readinessId}
        className={`candidate-import-readiness ${readinessClass}`}
        role={candidate.importEligible ? "status" : "alert"}
      >
        {candidate.importEligible ? <ShieldCheck size={19} /> : <AlertTriangle size={19} />}
        <div>
          <strong>{readinessTitle}</strong>
          <p>{readinessDescription}</p>
          {candidate.reviewFlags.length ? (
            <ul>
              {candidate.reviewFlags.map((flag) => <li key={flag}>{reviewFlagMessage(flag, candidate)}</li>)}
            </ul>
          ) : null}
        </div>
      </div>

      <dl className="candidate-definition-grid">
        <div><dt>Actividad</dt><dd>{candidate.businessLine || "No informada"}</dd></div>
        <div><dt>Tipo sugerido</dt><dd>{candidate.companyType}</dd></div>
        <div><dt>RUT</dt><dd>{candidate.rut || "No encontrado"}</dd></div>
        <div><dt>Ubicación validada</dt><dd>{primary ? `${primary.comunaName}, ${primary.regionName}` : "Sin ubicación"}</dd></div>
        <div><dt>Dirección</dt><dd>{primary?.address || "No informada"}</dd></div>
        <div><dt>Teléfono</dt><dd>{candidate.phone || "No encontrado"}</dd></div>
        <div><dt>Email</dt><dd>{candidate.email || "No encontrado"}</dd></div>
        <div><dt>Sitio web</dt><dd>{website ? <a href={website} target="_blank" rel="noreferrer">Abrir sitio <ExternalLink size={12} /></a> : "No encontrado"}</dd></div>
      </dl>

      {candidate.enrichmentStatus !== "not_requested" ? (
        <div className="candidate-import-readiness ready" role="status">
          <Sparkles size={19} />
          <div>
            <strong>{candidate.enrichmentStatus === "completed" ? "Investigación web completada" : candidate.enrichmentStatus === "failed" ? "Investigación con error" : candidate.enrichmentStatus === "paused" ? "Investigación pausada" : "Investigación web en curso"}</strong>
            <p>{candidate.enrichedAt ? `Verificada ${formatDateTime(candidate.enrichedAt)}.` : candidate.enrichmentError || "El agente está revisando fuentes públicas autorizadas."}</p>
            {candidate.specialties.length ? <p><strong>Especialidades:</strong> {candidate.specialties.join(", ")}</p> : null}
            {candidate.brands.length ? <p><strong>Marcas detectadas:</strong> {candidate.brands.join(", ")}</p> : null}
            {Object.keys(candidate.socialMedia).length ? <p><strong>Redes:</strong> {Object.entries(candidate.socialMedia).map(([name, url]) => <a key={name} href={safeExternalUrl(url) || undefined} target="_blank" rel="noreferrer"> {name}</a>)}</p> : null}
          </div>
        </div>
      ) : null}

      <div className="candidate-evidence-section">
        <div className="prospecting-section-heading"><div><strong>Evidencia por campo</strong><span>Fuente y fecha de verificación</span></div><span>{candidate.evidence.length} registros</span></div>
        <div className="evidence-list">
          {candidate.evidence.map((evidence) => {
            const url = safeExternalUrl(evidence.url);
            return (
              <article key={evidence.id}>
                <span className="evidence-source">{sourceName(evidence.source)}</span>
                <div><strong>{humanize(evidence.field)}</strong><p>{evidence.value}</p><small>{formatDateTime(evidence.observedAt)} · Confianza {confidencePercent(evidence.confidence)}%</small></div>
                {url ? <a href={url} target="_blank" rel="noreferrer" aria-label="Abrir fuente"><ExternalLink size={16} /></a> : null}
              </article>
            );
          })}
          {!candidate.evidence.length ? <p className="muted">El agente todavía no adjunta evidencia para este candidato.</p> : null}
        </div>
      </div>

      {canReview && reviewable ? (
        <div className="candidate-review-box">
          {!candidate.importEligible && website && primary ? (
            <div className="candidate-import-readiness partial" role="group" aria-label="Verificacion humana">
              <ShieldCheck size={19} />
              <div>
                <strong>¿Revisaste el sitio oficial?</strong>
                <p>Confirma solamente si el nombre, el contacto y la comuna mostrados corresponden a esta empresa. La comprobacion quedara registrada con tu usuario.</p>
                <button className="ghost-button" type="button" disabled={busy} onClick={onConfirmEvidence}>
                  <CheckCircle2 size={17} /> Confirmé los datos en el sitio oficial
                </button>
              </div>
            </div>
          ) : null}
          <div className="candidate-primary-actions">
            <button
              className="primary-button"
              type="button"
              disabled={busy || !candidate.importEligible || identityConflict}
              aria-describedby={readinessId}
              title={identityConflict ? "Bloqueado por identificadores contradictorios" : !candidate.importEligible ? "Bloqueado por falta de evidencia permanente" : undefined}
              onClick={onApprove}
            ><CheckCircle2 size={17} /> Aprobar prospecto</button>
            <button className="ghost-button danger" type="button" disabled={busy} onClick={onReject}><XCircle size={17} /> Rechazar</button>
          </div>
          <div className="candidate-link-action">
            <label>O vincular a una empresa existente<select value={companyToLink} onChange={(event) => onCompanyToLink(event.target.value)}><option value="">Selecciona una empresa</option>{companies.map((company) => <option key={company.id} value={company.id}>{company.name} · {company.city}</option>)}</select></label>
            <button
              className="ghost-button"
              type="button"
              disabled={busy || !companyToLink || !candidate.importEligible}
              aria-describedby={readinessId}
              title={!candidate.importEligible ? "Bloqueado por falta de evidencia permanente" : undefined}
              onClick={onLink}
            ><Link2 size={16} /> Vincular</button>
          </div>
          <p><ShieldCheck size={14} /> Aprobar crea un prospecto; vincular reutiliza una empresa. Ninguna acción agrega destinatarios a campañas comerciales.</p>
        </div>
      ) : !canReview ? <div className="read-only-panel"><Eye size={17} /> Tu rol permite revisar evidencia, pero no aprobar ni descartar.</div> : null}
    </>
  );
}

function TabButton({ active, onClick, icon, children }: { active: boolean; onClick: () => void; icon: React.ReactNode; children: React.ReactNode }) {
  return <button className={active ? "active" : ""} type="button" role="tab" aria-selected={active} onClick={onClick}>{icon}{children}</button>;
}

function MetricCard({ icon, label, value, detail }: { icon: React.ReactNode; label: string; value: number; detail: string }) {
  return <article className="metric-card prospecting-metric"><div>{icon}<span>{label}</span></div><strong>{value.toLocaleString("es-CL")}</strong><p>{detail}</p></article>;
}

function EmptyState({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) {
  return <div className="prospecting-empty">{icon}<strong>{title}</strong><span>{text}</span></div>;
}

function SnowflakeMark() {
  return <span aria-hidden="true">❄</span>;
}

function requiresOfficialWebsite(sources: ProspectingSource[]) {
  return sources.includes("brave_search") && !sources.includes("official_website");
}

function sourceName(source: ProspectingSource) {
  return SOURCE_DEFINITIONS.find((definition) => definition.id === source)?.name ?? source;
}

function territorySummary(territories: ProspectingTerritory[]) {
  if (!territories.length) return "Sin territorio";
  const comunaCount = territories.reduce((total, territory) => total + territory.comunaCodes.length, 0);
  if (territories.length === 1) {
    const territory = territories[0];
    return territory.allCommunes ? `${territory.regionName} completa` : `${territory.regionName} · ${comunaCount} comunas`;
  }
  return `${territories.length} regiones · ${comunaCount} comunas`;
}

function formatDate(value: string) {
  if (!value) return "Sin fecha";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 10);
  return new Intl.DateTimeFormat("es-CL", { day: "2-digit", month: "short", year: "numeric" }).format(date);
}

function formatDateTime(value: string) {
  if (!value) return "Sin iniciar";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("es-CL", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).format(date);
}

function humanize(value: string) {
  const clean = value.replace(/[._-]+/g, " ").trim();
  return clean ? clean.charAt(0).toUpperCase() + clean.slice(1) : "Dato";
}

function reviewFlagMessage(flag: string, candidate: ProspectCandidate) {
  if (flag === "official_location_conflict") {
    return "La ubicacion publicada en el sitio oficial no coincide con la comuna seleccionada. Revisa antes de aprobar.";
  }
  if (flag === "official_site_missing") {
    return "No se encontro un sitio oficial util para profundizar. No se consumieron consultas Brave adicionales.";
  }
  if (flag === "contact_only_import") {
    return "Sin sitio web, pero habilitado para importar porque tiene contacto comercial y comuna validada.";
  }
  if (flag === "insufficient_permanent_evidence") {
    return "Falta respaldo permanente para el nombre, el contacto comercial o al menos una ubicación.";
  }
  if (flag === "eligibility_not_reported") {
    return "Esta ejecución no informó si el candidato cumple las condiciones de importación.";
  }
  if (flag === "eligibility_without_importable_locations") {
    return "El agente marcó el candidato como importable, pero no indicó una sede válida.";
  }
  if (flag === "conflicting_exact_identifiers") {
    return "RUT, proveedor, dominio o teléfono apuntan a candidatos distintos. Revisa la evidencia antes de decidir.";
  }
  if (flag === "conflicting_exact_company_identifiers") {
    return "Los identificadores coinciden con empresas distintas del CRM. Debes vincular manualmente la correcta o rechazar.";
  }
  const temporaryLocation = /^location_(\d+)_temporary_evidence$/.exec(flag);
  if (temporaryLocation) {
    const locationIndex = Number(temporaryLocation[1]);
    const location = candidate.locations[locationIndex];
    const locationLabel = location
      ? [location.comunaName, location.address].filter(Boolean).join(" · ")
      : `Sede ${locationIndex + 1}`;
    return `${locationLabel}: sólo cuenta con evidencia temporal y no se importará.`;
  }
  return humanize(flag);
}

function confidencePercent(value: number) {
  return Math.round(Math.min(100, Math.max(0, value <= 1 ? value * 100 : value)));
}

function safeExternalUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

function normalizeChileanMobileWhatsApp(value: string) {
  const digits = value.replace(/\D/g, "");
  if (digits.startsWith("569") && digits.length === 11) return `+${digits}`;
  if (digits.startsWith("9") && digits.length === 9) return `+56${digits}`;
  return "";
}

function candidateToCompany(candidate: ProspectCandidate, region: string, city: string, address: string): Omit<Company, "id"> {
  const whatsappNumber = normalizeChileanMobileWhatsApp(candidate.whatsappNumber || candidate.phone);
  return {
    name: candidate.name,
    legalName: candidate.legalName,
    description: candidate.businessLine,
    rut: candidate.rut,
    businessLine: candidate.businessLine,
    type: candidate.companyType,
    city,
    region,
    address,
    website: candidate.website,
    instagram: "",
    facebook: "",
    whatsapp: whatsappNumber,
    whatsappNumber,
    whatsappOptIn: false,
    lastWhatsAppMessageAt: "",
    whatsappStatus: "sin_consentimiento",
    phone: candidate.phone,
    email: candidate.email,
    contactName: "",
    contactRole: "",
    priority: candidate.score >= 85 ? "alta" : candidate.score >= 65 ? "media" : "baja",
    source: `Prospección web · ${Array.from(new Set(candidate.evidence.map((evidence) => sourceName(evidence.source)))).join(", ")}`,
    notes: `Aprobado desde prospección el ${new Date().toLocaleDateString("es-CL")}. Evidencia revisada manualmente.`,
    status: "prospecto",
    nextFollowUp: "",
    tags: ["Prospección", "HVAC", city].filter(Boolean),
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "La operación no pudo completarse.";
}
