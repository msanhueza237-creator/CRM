export type CompanyType = "distribuidor" | "tienda comercial" | "tecnico" | "instalador grande" | "competencia" | "otro";
export type CompanyStatus = "prospecto" | "contactado" | "interesado" | "cotizado" | "cliente" | "descartado";
export type Priority = "alta" | "media" | "baja";
export type CampaignType = "email" | "WhatsApp" | "mixta";
export type CampaignStatus = "borrador" | "programada" | "enviada" | "pausada" | "finalizada";
export type WhatsAppStatus = "sin_consentimiento" | "opt_in" | "bloqueado" | "invalido";

export interface Company {
  id: string;
  name: string;
  legalName: string;
  description: string;
  rut: string;
  businessLine: string;
  type: CompanyType;
  city: string;
  region: string;
  address: string;
  website: string;
  instagram: string;
  facebook: string;
  whatsapp: string;
  whatsappNumber?: string;
  whatsappOptIn?: boolean;
  lastWhatsAppMessageAt?: string;
  whatsappStatus?: WhatsAppStatus;
  phone: string;
  email: string;
  contactName: string;
  contactRole: string;
  priority: Priority;
  source: string;
  notes: string;
  status: CompanyStatus;
  nextFollowUp: string;
  tags: string[];
}

export interface Interaction {
  id: string;
  companyId: string;
  date: string;
  type: "Llamada" | "Correo" | "WhatsApp" | "Reunion" | "Cotizacion" | "Nota";
  owner: string;
  description: string;
  result: string;
  nextAction: string;
}

export interface Campaign {
  id: string;
  name: string;
  type: CampaignType;
  segment: string;
  status: CampaignStatus;
  createdAt: string;
  sendAt: string;
  recipients: number;
  sent: number;
  replied: number;
  interested: number;
  discarded: number;
}

export interface MessageTemplate {
  id: string;
  name: string;
  category: string;
  body: string;
  active?: boolean;
}

export interface Task {
  id: string;
  companyId: string;
  title: string;
  dueDate: string;
  done: boolean;
}

export interface Activity {
  id: string;
  date: string;
  text: string;
}

export type ProspectingSource = "google_places" | "brave_search" | "official_website" | "amarillas";
export type ProspectingCampaignStatus = "draft" | "active" | "archived";
export type ProspectingRunStatus =
  | "pending"
  | "running"
  | "paused"
  | "partial"
  | "completed"
  | "failed"
  | "cancel_requested"
  | "cancelled";
export type ProspectReviewStatus = "pending" | "possible_duplicate" | "approved" | "rejected" | "linked";
export type ProspectingEventLevel = "debug" | "info" | "warning" | "error";

export interface GeoRegion {
  code: string;
  name: string;
}

export interface GeoComuna {
  code: string;
  regionCode: string;
  name: string;
  /** Los codigos demo empiezan con `local-` y nunca se envian a Supabase. */
  isLocalOnly?: boolean;
}

export interface ProspectingTerritory {
  regionCode: string;
  regionName: string;
  allCommunes: boolean;
  comunaCodes: string[];
  comunaNames: string[];
}

export interface ProspectingLimits {
  resultsPerTask: number;
  maxCandidates: number;
}

export interface ProspectingCampaign {
  id: string;
  version: number;
  name: string;
  description: string;
  sector: "hvac";
  status: ProspectingCampaignStatus;
  keywords: string[];
  sources: ProspectingSource[];
  territories: ProspectingTerritory[];
  targetTypes: CompanyType[];
  limits: ProspectingLimits;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProspectingRunProgress {
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  candidatesFound: number;
}

export interface ProspectingRunSnapshot {
  schemaVersion: 1;
  campaignVersion: number;
  campaignId: string;
  campaignName: string;
  sector: "hvac";
  keywords: string[];
  sources: ProspectingSource[];
  territories: ProspectingTerritory[];
  targetTypes: CompanyType[];
  limits: ProspectingLimits;
  requestedBy: string;
  requestedAt: string;
}

export interface ProspectingRun {
  id: string;
  campaignId: string;
  status: ProspectingRunStatus;
  snapshot: ProspectingRunSnapshot;
  progress: ProspectingRunProgress;
  requestedBy: string;
  createdAt: string;
  startedAt: string;
  completedAt: string;
  lastError: string;
  enrichmentStatus: "not_requested" | "pending" | "running" | "paused" | "completed" | "partial";
  enrichmentTotal: number;
  enrichmentCompleted: number;
  enrichmentFailed: number;
}

export interface ProspectLocation {
  id: string;
  kind: "casa_matriz" | "sucursal";
  regionCode: string;
  regionName: string;
  comunaCode: string;
  comunaName: string;
  address: string;
  isPrimary: boolean;
}

export interface SourceEvidence {
  id: string;
  source: ProspectingSource;
  url: string;
  externalId: string;
  field: string;
  value: string;
  confidence: number;
  observedAt: string;
  retentionAllowed: boolean;
}

export interface ProspectCandidate {
  id: string;
  entityId: string;
  externalCandidateId: string;
  campaignId: string;
  runId: string;
  name: string;
  legalName: string;
  rut: string;
  businessLine: string;
  companySummary: string;
  companyType: CompanyType;
  website: string;
  phone: string;
  email: string;
  socialMedia: Record<string, string>;
  specialties: string[];
  brands: string[];
  enrichmentStatus: "not_requested" | "pending" | "running" | "paused" | "completed" | "failed";
  enrichmentSummary: Record<string, number | string | boolean>;
  enrichmentError: string;
  enrichedAt: string;
  score: number;
  marketScore?: number;
  marketSignals?: Record<string, number | string | boolean>;
  reviewStatus: ProspectReviewStatus;
  locations: ProspectLocation[];
  evidence: SourceEvidence[];
  importEligible: boolean;
  importableLocationIndexes: number[];
  reviewFlags: string[];
  possibleDuplicateExternalCandidateId: string;
  possibleDuplicateCompanyId: string;
  linkedCompanyId: string;
  reviewNotes: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface RunEvent {
  id: string;
  runId: string;
  taskId: string;
  createdAt: string;
  level: ProspectingEventLevel;
  stage: string;
  source?: ProspectingSource;
  keyword?: string;
  comunaCode?: string;
  comunaName?: string;
  message: string;
  metrics: Record<string, number | string | boolean>;
}

export interface ProspectingWorkspace {
  campaigns: ProspectingCampaign[];
  runs: ProspectingRun[];
  candidates: ProspectCandidate[];
  events: RunEvent[];
  regions: GeoRegion[];
  comunas: GeoComuna[];
}

export type HistoricalImportStatus = "processing" | "ready" | "partial" | "failed" | "rolled_back";

export interface HistoricalProvenance {
  sheet: string;
  row: number;
}

export interface HistoricalEntityImport {
  identity_key: string;
  legacy_code: string;
  legal_name: string;
  rut_raw: string;
  rut_normalized: string;
  rut_valid: boolean;
  emails: string[];
  invalid_emails: string[];
  phone_raw: string;
  phone_normalized: string;
  relationship_date: string | null;
  territory_status: "unknown" | "verified" | "conflict";
  verification_status: "historical_unverified" | "enrichment_pending" | "verified" | "not_found" | "needs_review";
  flags: string[];
  provenance: HistoricalProvenance[];
}

export interface HistoricalImportPreview {
  filename: string;
  sha256: string;
  relationship_date: string | null;
  sheets: string[];
  rows: HistoricalEntityImport[];
  preview: HistoricalEntityImport[];
  stats: Record<string, number>;
}

export interface HistoricalImportBatch {
  id: string;
  filename: string;
  fileSha256: string;
  status: HistoricalImportStatus;
  relationshipDate: string | null;
  sourceRowCount: number;
  entityCount: number;
  duplicateCount: number;
  needsReviewCount: number;
  sheets: string[];
  createdAt: string;
}
