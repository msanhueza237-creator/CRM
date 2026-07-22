import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, Eye, Megaphone, Plus, Send, UserMinus, UserPlus, XCircle } from "lucide-react";
import { demoCampaigns, demoTemplates } from "../../data/demoData";
import { isSupabaseConfigured, supabase } from "../../lib/supabase";
import { useAuth } from "../auth/AuthContext";
import { useCompanyStore } from "../companies/CompanyStore";
import { useTemplateStore } from "../templates/TemplateStore";
import { getGmailStatus, sendGmailCampaign, syncGmailReplies } from "../../lib/gmailApi";
import { chileData, normalizeString } from "../../data/chileData";
import type { Campaign, CampaignStatus, CampaignType, Company, CompanyType, MessageTemplate } from "../../types/crm";

type CampaignSegment = "todas" | "prioridad alta" | "distribuidores y tiendas" | "instaladores" | "interesados";
type CampaignCompanyTypeFilter = "todas" | CompanyType;

interface CampaignDraft extends Campaign {
  templateId: string;
  product: string;
  coupon: string;
  recipientIds: string[];
  attachments?: { name: string; url: string }[];
}

interface RecipientState {
  campaignId: string;
  companyId: string;
  sent: boolean;
  replied: boolean;
  interested: boolean;
  discarded: boolean;
  replyFromEmail?: string;
  replySubject?: string;
  replySnippet?: string;
  replyBody?: string;
  replyReceivedAt?: string;
  replyGmailMessageId?: string;
  replyGmailUrl?: string;
}

type Row = Record<string, unknown>;

function asRecord(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};
}

const CAMPAIGNS_STORAGE_KEY = "climactiva_campaigns";
const RECIPIENTS_STORAGE_KEY = "climactiva_campaign_recipients";
const PROPOSAL_OVERRIDES_STORAGE_KEY = "climactiva_proposal_overrides";
const DISMISSED_PROPOSALS_STORAGE_KEY = "climactiva_dismissed_proposals";
const CAMPAIGN_ATTACHMENTS_BUCKET = "campaign-attachments";
const MAX_ATTACHMENT_SIZE_MB = 20;
const ALLOWED_ATTACHMENT_TYPES = new Set([
  "application/pdf",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

interface ProposalOverride {
  name?: string;
  description?: string;
  type?: CampaignType;
  product?: string;
  coupon?: string;
  subject?: string;
  message?: string;
}
const segments: CampaignSegment[] = ["todas", "prioridad alta", "distribuidores y tiendas", "instaladores", "interesados"];
const campaignTypes: CampaignType[] = ["email", "WhatsApp", "mixta"];
const companyTypeFilters: CampaignCompanyTypeFilter[] = [
  "todas",
  "distribuidor",
  "tienda comercial",
  "tecnico",
  "instalador grande",
  "competencia",
  "otro",
];
const INSTALLER_REGISTER_URL = "https://www.climactiva.cl/account/register/wholesale/7d860bbb-d587-465e-a4f9-251620a5b478";
const DEFAULT_INSTALLER_BENEFIT = `Inscribete aqui: ${INSTALLER_REGISTER_URL} y accede a un 7% de descuento especial por ser instalador.`;

function isInstallerCampaignType(companyType: CampaignCompanyTypeFilter) {
  return companyType === "tecnico" || companyType === "instalador grande";
}

function isInstallerCampaignSegment(segment: CampaignSegment | string) {
  return segment === "instaladores" || segment.includes("tecnico") || segment.includes("instalador grande");
}

function isInstallerAccountTemplate(template?: MessageTemplate) {
  if (!template) return false;
  const text = `${template.id} ${template.name} ${template.body}`.toLowerCase();
  return text.includes("cuenta instalador") || text.includes("cuenta de instalador") || text.includes(INSTALLER_REGISTER_URL);
}

function canReceiveInstallerBenefit(company: Company) {
  return company.type === "tecnico" || company.type === "instalador grande";
}

function getCampaignBenefitForCompany(campaign: CampaignDraft, company: Company) {
  return canReceiveInstallerBenefit(company) ? campaign.coupon || "" : "";
}

function cleanEmptyBenefitText(message: string) {
  return message
    .replace(/^\s*(Cup[oó]n de referencia|Beneficio|Llamado \/ beneficio):\s*$/gim, "")
    .replace(/^\s*Recuerda que tienes habilitado tu c[oó]digo de descuento\s+para tu pr[oó]xima facturaci[oó]n\.\s*$/gim, "")
    .replace(/^\s*Adem[aá]s, habilitamos el beneficio especial\s+para que puedas concretar tu proyecto con un descuento extra\.\s*$/gim, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function defaultCampaigns(): CampaignDraft[] {
  return demoCampaigns.map((campaign, index) => ({
    ...campaign,
    templateId: demoTemplates[index === 0 ? 1 : 2]?.id ?? demoTemplates[0].id,
    product: "bombas de condensado y herramientas Super Stars",
    coupon: DEFAULT_INSTALLER_BENEFIT,
    recipientIds: [],
  }));
}

function loadCampaigns() {
  const stored = localStorage.getItem(CAMPAIGNS_STORAGE_KEY);
  if (!stored) return defaultCampaigns();

  try {
    return JSON.parse(stored) as CampaignDraft[];
  } catch {
    return defaultCampaigns();
  }
}

function loadRecipients() {
  const stored = localStorage.getItem(RECIPIENTS_STORAGE_KEY);
  if (!stored) return [] as RecipientState[];

  try {
    return JSON.parse(stored) as RecipientState[];
  } catch {
    return [];
  }
}

function saveCampaigns(campaigns: CampaignDraft[]) {
  localStorage.setItem(CAMPAIGNS_STORAGE_KEY, JSON.stringify(campaigns));
}

function saveRecipients(recipients: RecipientState[]) {
  localStorage.setItem(RECIPIENTS_STORAGE_KEY, JSON.stringify(recipients));
}

function loadProposalOverrides(): Record<string, ProposalOverride> {
  const stored = localStorage.getItem(PROPOSAL_OVERRIDES_STORAGE_KEY);
  if (!stored) return {};

  try {
    return JSON.parse(stored) as Record<string, ProposalOverride>;
  } catch {
    return {};
  }
}

function saveProposalOverrides(overrides: Record<string, ProposalOverride>) {
  localStorage.setItem(PROPOSAL_OVERRIDES_STORAGE_KEY, JSON.stringify(overrides));
}

function loadDismissedProposals(): string[] {
  const stored = localStorage.getItem(DISMISSED_PROPOSALS_STORAGE_KEY);
  if (!stored) return [];

  try {
    return JSON.parse(stored) as string[];
  } catch {
    return [];
  }
}

function saveDismissedProposals(ids: string[]) {
  localStorage.setItem(DISMISSED_PROPOSALS_STORAGE_KEY, JSON.stringify(ids));
}

function normalizeAttachmentRows(value: unknown): { name: string; url: string }[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      const name = String(record.name ?? "").trim();
      const url = String(record.url ?? "").trim();
      return name && url ? { name, url } : null;
    })
    .filter((item): item is { name: string; url: string } => Boolean(item));
}

function sanitizeStorageFileName(fileName: string) {
  const fallback = "catalogo";
  const clean = fileName
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return clean || fallback;
}

function getSegmentCompanies(companies: Company[], segment: CampaignSegment) {
  if (segment === "prioridad alta") return companies.filter((company) => company.priority === "alta");
  if (segment === "distribuidores y tiendas") {
    return companies.filter((company) => company.type === "distribuidor" || company.type === "tienda comercial");
  }
  if (segment === "instaladores") {
    return companies.filter((company) => company.type === "tecnico" || company.type === "instalador grande");
  }
  if (segment === "interesados") {
    return companies.filter((company) => company.status === "interesado" || company.status === "cotizado");
  }
  return companies;
}

function getFilteredCampaignCompanies(
  companies: Company[],
  filters: { companyType: CampaignCompanyTypeFilter; region: string; city: string },
) {
  return companies.filter((company) => {
    const typeMatches = filters.companyType === "todas" || company.type === filters.companyType;
    const regionMatches = !filters.region || normalizeString(company.region) === normalizeString(filters.region);
    const cityMatches = !filters.city || normalizeString(company.city) === normalizeString(filters.city);
    return typeMatches && regionMatches && cityMatches;
  });
}

function describeCampaignSegment(filters: { companyType: CampaignCompanyTypeFilter; region: string; city: string }) {
  const parts = [
    filters.companyType === "todas" ? "todas las clasificaciones" : filters.companyType,
    filters.city || filters.region || "todo Chile",
  ];
  return parts.filter(Boolean).join(" · ");
}

function renderMessage(template: MessageTemplate, company: Company, campaign: CampaignDraft) {
  const benefit = getCampaignBenefitForCompany(campaign, company);
  return cleanEmptyBenefitText(template.body
    .replace(/\{\{nombre_empresa\}\}/g, company.name)
    .replace(/\{\{nombre_contacto\}\}/g, company.contactName || "equipo comercial")
    .replace(/\{\{ciudad\}\}/g, company.city || "su zona")
    .replace(/\{\{tipo_empresa\}\}/g, company.type)
    .replace(/\{\{cupon\}\}/g, benefit)
    .replace(/\{\{beneficio\}\}/g, benefit)
    .replace(/\{\{producto_destacado\}\}/g, campaign.product));
}

export function CampaignsPage() {
  const { user } = useAuth();
  const { companies } = useCompanyStore();
  const { activeTemplates } = useTemplateStore();
  const templates = activeTemplates.length ? activeTemplates : demoTemplates;
  const firstNonInstallerTemplateId = templates.find((template) => !isInstallerAccountTemplate(template))?.id ?? templates[0].id;
  const [campaigns, setCampaigns] = useState<CampaignDraft[]>(loadCampaigns);
  const [recipients, setRecipients] = useState<RecipientState[]>(loadRecipients);
  const [selectedCampaignId, setSelectedCampaignId] = useState(campaigns[0]?.id ?? "");
  const [companyToAdd, setCompanyToAdd] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [showMetaModal, setShowMetaModal] = useState(false);
  const [metaApiKey, setMetaApiKey] = useState("");
  const [metaTemplateName, setMetaTemplateName] = useState("");
  const [allowWithoutOptIn, setAllowWithoutOptIn] = useState(false);
  const [adminOverrideReason, setAdminOverrideReason] = useState("");
  const [sendingCampaign, setSendingCampaign] = useState(false);
  const [sendingResults, setSendingResults] = useState<{ success: number; failed: number; log: string[] } | null>(null);
  const [gmailConnected, setGmailConnected] = useState(false);
  const [syncingReplies, setSyncingReplies] = useState(false);
  const [campaignFormError, setCampaignFormError] = useState("");
  const [form, setForm] = useState({
    name: "",
    type: "mixta" as CampaignType,
    segment: "distribuidores y tiendas" as CampaignSegment,
    companyType: "distribuidor" as CampaignCompanyTypeFilter,
    region: "",
    city: "",
    templateId: firstNonInstallerTemplateId,
    product: "bombas de condensado y herramientas Super Stars",
    coupon: "",
    sendAt: new Date().toISOString().slice(0, 10),
  });

  // Smart suggestions state variables
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedProposalIndex, setSelectedProposalIndex] = useState(0);
  const [proposalForm, setProposalForm] = useState({
    name: "",
    description: "",
    type: "mixta" as CampaignType,
    product: "bombas de condensado y herramientas Super Stars",
    coupon: DEFAULT_INSTALLER_BENEFIT,
    subject: "",
    message: "",
  });
  const [excludedCompanyIds, setExcludedCompanyIds] = useState<string[]>([]);
  const [proposalSuccessMessage, setProposalSuccessMessage] = useState<string | null>(null);
  const [savingProposal, setSavingProposal] = useState(false);
  const [proposalOverrides, setProposalOverrides] = useState<Record<string, ProposalOverride>>(loadProposalOverrides);
  const [dismissedProposalIds, setDismissedProposalIds] = useState<string[]>(loadDismissedProposals);
  const [proposalEditSavedMessage, setProposalEditSavedMessage] = useState<string | null>(null);

  // Attachment state variables
  const [formAttachments, setFormAttachments] = useState<{ name: string; url: string }[]>([]);
  const [proposalAttachments, setProposalAttachments] = useState<{ name: string; url: string }[]>([]);
  const [uploadingFile, setUploadingFile] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [manualAttachmentName, setManualAttachmentName] = useState("");
  const [manualAttachmentUrl, setManualAttachmentUrl] = useState("");

  async function handleFileUpload(file: File, isProposal: boolean) {
    if (!isSupabaseConfigured || !supabase) {
      setUploadError("Para subir archivos debes tener conectado Supabase.");
      return;
    }

    if (file.size > MAX_ATTACHMENT_SIZE_MB * 1024 * 1024) {
      setUploadError(`El archivo supera ${MAX_ATTACHMENT_SIZE_MB} MB. Usa un PDF mas liviano o un enlace web.`);
      return;
    }

    if (file.type && !ALLOWED_ATTACHMENT_TYPES.has(file.type)) {
      setUploadError("Formato no permitido. Usa PDF, Excel, Word, JPG, PNG o WebP.");
      return;
    }

    setUploadingFile(true);
    setUploadError(null);

    const fileName = `${crypto.randomUUID()}-${sanitizeStorageFileName(file.name)}`;
    const filePath = `campaigns/${new Date().toISOString().slice(0, 7)}/${fileName}`;

    try {
      const { error: uploadErr } = await supabase.storage
        .from(CAMPAIGN_ATTACHMENTS_BUCKET)
        .upload(filePath, file, {
          cacheControl: "3600",
          contentType: file.type || "application/octet-stream",
          upsert: false,
        });

      if (uploadErr) {
        throw uploadErr;
      }

      const { data } = supabase.storage.from(CAMPAIGN_ATTACHMENTS_BUCKET).getPublicUrl(filePath);
      const publicUrl = data.publicUrl;

      const newAttachment = { name: file.name, url: publicUrl };
      if (isProposal) {
        setProposalAttachments((prev) => [...prev, newAttachment]);
      } else {
        setFormAttachments((prev) => [...prev, newAttachment]);
      }
    } catch (err) {
      console.error(err);
      const message = err instanceof Error ? err.message : "";
      if (message.includes("Bucket not found") || message.includes("does not exist")) {
        setUploadError("Falta crear el bucket de adjuntos en Supabase. Ejecuta supabase/campaign_attachments.sql.");
      } else if (message.toLowerCase().includes("row-level security") || message.toLowerCase().includes("policy")) {
        setUploadError("Supabase bloqueo la subida por politicas de Storage. Ejecuta supabase/campaign_attachments.sql.");
      } else {
        setUploadError("No se pudo subir el archivo. Revisa Storage en Supabase o usa un enlace web directo.");
      }
    } finally {
      setUploadingFile(false);
    }
  }

  function addManualAttachment(isProposal: boolean) {
    if (!manualAttachmentName || !manualAttachmentUrl) return;
    try {
      const parsedUrl = new URL(manualAttachmentUrl.trim());
      if (!["http:", "https:"].includes(parsedUrl.protocol)) throw new Error("invalid");
    } catch {
      setUploadError("El enlace debe empezar con http:// o https://.");
      return;
    }

    const newAttachment = { name: manualAttachmentName.trim(), url: manualAttachmentUrl.trim() };
    if (isProposal) {
      setProposalAttachments((prev) => [...prev, newAttachment]);
    } else {
      setFormAttachments((prev) => [...prev, newAttachment]);
    }
    setManualAttachmentName("");
    setManualAttachmentUrl("");
  }

  function renderAttachmentsEditor(isProposal: boolean) {
    const list = isProposal ? proposalAttachments : formAttachments;
    const setList = isProposal ? setProposalAttachments : setFormAttachments;

    return (
      <div className="attachments-editor" style={{ marginTop: "16px", padding: "16px", background: "#f8f9fa", borderRadius: "8px", border: "1px solid #dfe7ea" }}>
        <strong style={{ fontSize: "13px", color: "#40515b", display: "block", marginBottom: "8px" }}>
          📎 Documentos Adjuntos ({list.length})
        </strong>

        {list.length > 0 ? (
          <ul style={{ paddingLeft: "20px", margin: "0 0 16px 0", fontSize: "13px" }}>
            {list.map((item, index) => (
              <li key={index} style={{ marginBottom: "6px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <a href={item.url} target="_blank" rel="noopener noreferrer" style={{ color: "#0b7285", textDecoration: "underline", fontWeight: "600" }}>
                  {item.name}
                </a>
                <button 
                  type="button" 
                  onClick={() => setList(list.filter((_, i) => i !== index))}
                  style={{ background: "#fdf2f2", color: "#e03131", border: "1px solid #fbd5d5", borderRadius: "4px", padding: "2px 6px", fontSize: "11px", cursor: "pointer" }}
                >
                  Eliminar
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted" style={{ fontSize: "12px", margin: "0 0 16px 0" }}>No hay documentos adjuntos aún.</p>
        )}

        <div style={{ display: "grid", gap: "12px", borderTop: "1px solid #e9ecef", paddingTop: "14px" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            <span style={{ fontSize: "12px", fontWeight: "bold", color: "#40515b" }}>Subir archivo a Supabase:</span>
            <input 
              type="file" 
              accept=".pdf,.xls,.xlsx,.doc,.docx,.jpg,.jpeg,.png,.webp"
              disabled={uploadingFile}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) {
                  void handleFileUpload(file, isProposal);
                }
              }}
              style={{ padding: "6px", fontSize: "12px" }}
            />
            {uploadingFile && <span style={{ fontSize: "12px", color: "#0b7285" }}>Subiendo archivo...</span>}
            {uploadError && <span style={{ fontSize: "12px", color: "#e03131" }}>{uploadError}</span>}
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            <span style={{ fontSize: "12px", fontWeight: "bold", color: "#40515b" }}>O agregar enlace externo (URL):</span>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1.5fr auto", gap: "8px", alignItems: "end" }}>
              <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "11px", fontWeight: "normal" }}>
                Nombre del documento
                <input 
                  type="text" 
                  placeholder="Ej: Catálogo 2026.pdf" 
                  value={manualAttachmentName}
                  onChange={(e) => setManualAttachmentName(e.target.value)}
                  style={{ minHeight: "34px", padding: "0 8px", fontSize: "12px", border: "1px solid #cfdade", borderRadius: "6px" }}
                />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "11px", fontWeight: "normal" }}>
                Dirección URL
                <input 
                  type="url" 
                  placeholder="Ej: https://site.com/doc.pdf" 
                  value={manualAttachmentUrl}
                  onChange={(e) => setManualAttachmentUrl(e.target.value)}
                  style={{ minHeight: "34px", padding: "0 8px", fontSize: "12px", border: "1px solid #cfdade", borderRadius: "6px" }}
                />
              </label>
              <button 
                type="button" 
                onClick={() => addManualAttachment(isProposal)}
                disabled={!manualAttachmentName.trim() || !manualAttachmentUrl.trim()}
                className="ghost-button"
                style={{ minHeight: "34px", padding: "0 10px", fontSize: "12px", whiteSpace: "nowrap" }}
              >
                + Agregar
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Memoized smart proposals based on real company database contents
  const proposals = useMemo(() => {
    const vipCompanies = companies.filter(
      (c) => c.priority === "alta" && (c.type === "distribuidor" || c.type === "tienda comercial")
    );
    const techCompanies = companies.filter((c) => c.type === "tecnico" || c.type === "instalador grande");
    const leadCompanies = companies.filter(
      (c) => c.status === "prospecto" || c.status === "contactado" || c.status === "cotizado"
    );

    const baseProposals = [
      {
        id: "prop-vip",
        defaultName: "Fidelización VIP - Distribuidores Principales",
        type: "mixta" as CampaignType,
        segment: "prioridad alta" as CampaignSegment,
        description: "Fortalece la relación comercial con tus principales distribuidores ofreciendo stock exclusivo de importaciones.",
        product: "Herramientas de refrigeración y Bombas de Condensado Super Stars",
        coupon: "VIPCLIMA15",
        subject: "Condiciones comerciales preferentes y stock garantizado",
        potentialCompanies: vipCompanies,
        defaultMessage: `Hola {{nombre_contacto}},\n\nEsperamos que estés muy bien. Como socio comercial clave de Clima Activa en {{ciudad}}, queremos ofrecerte prioridad y condiciones especiales en nuestro catálogo de {{producto_destacado}}.\n\nRecuerda que tienes habilitado tu código de descuento {{cupon}} para tu próxima facturación.\n\nQuedamos atentos a tus pedidos.\n\nSaludos,\nEquipo Clima Activa`,
      },
      {
        id: "prop-tech",
        defaultName: "Campaña Instaladores - Temporada Aire Acondicionado",
        type: "WhatsApp" as CampaignType,
        segment: "instaladores" as CampaignSegment,
        description: "Enfocada en instaladores autónomos y técnicos. Promociona repuestos y bombas de condensado para instalación rápida.",
        product: "Bombas de Condensado y herramientas Super Stars",
        coupon: "TECHSTARS10",
        subject: "Herramientas técnicas premium en oferta",
        potentialCompanies: techCompanies,
        defaultMessage: `Estimado {{nombre_contacto}} de {{nombre_empresa}},\n\nEsperamos que sea una excelente temporada en {{ciudad}}. Desde Clima Activa te recordamos que contamos con stock de {{producto_destacado}} con un 10% de descuento usando el código {{cupon}}.\n\nEscríbenos directamente aquí para coordinar el despacho hoy mismo.\n\nAtentamente,\nClima Activa`,
      },
      {
        id: "prop-reactivation",
        defaultName: "Reactivación de Cotizaciones y Prospectos",
        type: "email" as CampaignType,
        segment: "interesados" as CampaignSegment,
        description: "Recupera la atención de prospectos y contactos fríos que solicitaron información o cotizaciones previas.",
        product: "Bombas de Condensado Super Stars",
        coupon: "REACTIVACLIMA",
        subject: "¿Conversamos sobre tus próximos proyectos de climatización?",
        potentialCompanies: leadCompanies,
        defaultMessage: `Hola {{nombre_contacto}},\n\nTe escribimos de Clima Activa. Hace un tiempo estuvimos conversando sobre soluciones de climatización para {{nombre_empresa}}.\n\nQueremos reactivar el contacto contigo en {{ciudad}} y comentarte que tenemos disponibilidad inmediata de {{producto_destacado}}.\n\nAdemás, habilitamos el beneficio especial {{cupon}} para que puedas concretar tu proyecto con un descuento extra.\n\n¿Te gustaría que agendemos una breve llamada de 5 minutos?\n\nSaludos cordiales,\nClima Activa`,
      },
    ];

    return baseProposals
      .filter((prop) => !dismissedProposalIds.includes(prop.id))
      .map((prop) => {
        const override = proposalOverrides[prop.id];
        if (!override) return prop;
        return {
          ...prop,
          defaultName: override.name ?? prop.defaultName,
          description: override.description ?? prop.description,
          type: override.type ?? prop.type,
          product: override.product ?? prop.product,
          coupon: override.coupon ?? prop.coupon,
          subject: override.subject ?? prop.subject,
          defaultMessage: override.message ?? prop.defaultMessage,
        };
      });
  }, [companies, proposalOverrides, dismissedProposalIds]);

  // Synchronize forms only when the user switches to a different proposal card.
  // Deliberately excludes `proposals` from the deps: saving an override edit
  // recomputes that memo, and resyncing on every content change would wipe out
  // the just-saved confirmation message and reset excluded/attachments state.
  const proposalsRef = useRef(proposals);
  proposalsRef.current = proposals;

  useEffect(() => {
    const prop = proposalsRef.current[selectedProposalIndex];
    if (prop) {
      setProposalForm({
        name: prop.defaultName,
        description: prop.description,
        type: prop.type,
        product: prop.product,
        coupon: prop.coupon,
        subject: prop.subject,
        message: prop.defaultMessage,
      });
      setExcludedCompanyIds([]);
      setProposalSuccessMessage(null);
      setProposalEditSavedMessage(null);
      setProposalAttachments([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProposalIndex]);

  function saveProposalEdits() {
    const prop = proposals[selectedProposalIndex];
    if (!prop) return;

    const nextOverrides: Record<string, ProposalOverride> = {
      ...proposalOverrides,
      [prop.id]: {
        name: proposalForm.name,
        description: proposalForm.description,
        type: proposalForm.type,
        product: proposalForm.product,
        coupon: proposalForm.coupon,
        subject: proposalForm.subject,
        message: proposalForm.message,
      },
    };
    setProposalOverrides(nextOverrides);
    saveProposalOverrides(nextOverrides);
    setProposalEditSavedMessage("Cambios guardados en la propuesta.");
  }

  function dismissProposal(proposalId: string) {
    if (!confirm("¿Eliminar esta propuesta de la lista de sugerencias?")) return;

    const nextDismissed = [...dismissedProposalIds, proposalId];
    setDismissedProposalIds(nextDismissed);
    saveDismissedProposals(nextDismissed);
    setSelectedProposalIndex(0);
  }

  function restoreDismissedProposals() {
    setDismissedProposalIds([]);
    saveDismissedProposals([]);
  }

  function renderProposalPreview(templateText: string, company: Company) {
    if (!company) return "No hay empresas seleccionadas.";
    const benefit = canReceiveInstallerBenefit(company) ? proposalForm.coupon || DEFAULT_INSTALLER_BENEFIT : "";
    return cleanEmptyBenefitText(templateText
      .replace(/\{\{nombre_empresa\}\}/g, company.name)
      .replace(/\{\{nombre_contacto\}\}/g, company.contactName || "equipo comercial")
      .replace(/\{\{ciudad\}\}/g, company.city || "su zona")
      .replace(/\{\{tipo_empresa\}\}/g, company.type)
      .replace(/\{\{cupon\}\}/g, benefit)
      .replace(/\{\{beneficio\}\}/g, benefit)
      .replace(/\{\{producto_destacado\}\}/g, proposalForm.product));
  }

  async function saveProposedCampaign() {
    const prop = proposals[selectedProposalIndex];
    if (!prop) return;

    setSavingProposal(true);
    setProposalSuccessMessage(null);

    const targetCompanies = prop.potentialCompanies.filter((c) => !excludedCompanyIds.includes(c.id));

    if (targetCompanies.length === 0) {
      alert("Por favor selecciona al menos un cliente potencial para la campaña.");
      setSavingProposal(false);
      return;
    }

    const newCampaignId = `cam-${crypto.randomUUID()}`;
    const newCampaign: CampaignDraft = {
      id: newCampaignId,
      name: proposalForm.name || prop.defaultName,
      type: proposalForm.type,
      segment: prop.segment,
      status: "borrador",
      createdAt: new Date().toISOString().slice(0, 10),
      sendAt: new Date().toISOString().slice(0, 10),
      recipients: targetCompanies.length,
      sent: 0,
      replied: 0,
      interested: 0,
      discarded: 0,
      templateId: templates[0]?.id || demoTemplates[0].id,
      product: proposalForm.product,
      coupon: isInstallerCampaignSegment(prop.segment) ? proposalForm.coupon : "",
      recipientIds: targetCompanies.map((c) => c.id),
      attachments: proposalAttachments,
    };

    persistCampaigns([newCampaign, ...campaigns]);

    const createdRecipients: RecipientState[] = targetCompanies.map((c) => ({
      campaignId: newCampaignId,
      companyId: c.id,
      sent: false,
      replied: false,
      interested: false,
      discarded: false,
    }));
    persistRecipients([...createdRecipients, ...recipients]);

    if (isSupabaseConfigured && supabase && user) {
      try {
        const { data: dbCampaign, error: campaignError } = await supabase
          .from("campaigns")
          .insert({
            name: newCampaign.name,
            type:
              newCampaign.type.toLowerCase() === "whatsapp"
                ? "whatsapp"
                : newCampaign.type.toLowerCase() === "email"
                ? "email"
                : "mixta",
            segment: newCampaign.segment,
            message: proposalForm.message,
            status: "borrador",
            product: newCampaign.product,
            coupon: newCampaign.coupon,
            attachments: newCampaign.attachments ?? [],
            send_at: new Date().toISOString(),
          })
          .select()
          .single();

        if (campaignError) {
          console.error("Error al guardar campaña en Supabase:", campaignError);
        } else if (dbCampaign) {
          const dbCampaignId = String(dbCampaign.id);

          const recipientsToInsert = targetCompanies.map((c) => ({
            campaign_id: dbCampaign.id,
            company_id: c.id,
            rendered_message: renderMessage(
              {
                id: "proposal-preview",
                name: newCampaign.name,
                category: newCampaign.type,
                body: proposalForm.message,
                active: true,
              },
              c,
              newCampaign,
            ),
          }));

          const { error: recipientsError } = await supabase.from("campaign_recipients").insert(recipientsToInsert);

          if (recipientsError) {
            console.error("Error al guardar destinatarios en Supabase:", recipientsError);
          } else {
            const updatedCampaigns = [
              {
                ...newCampaign,
                id: dbCampaignId,
              },
              ...campaigns,
            ];
            setCampaigns(updatedCampaigns);
            saveCampaigns(updatedCampaigns);

            const updatedRecipients = createdRecipients
              .map((r) => ({ ...r, campaignId: dbCampaignId }))
              .concat(recipients);
            setRecipients(updatedRecipients);
            saveRecipients(updatedRecipients);

            setSelectedCampaignId(dbCampaignId);
          }
        }
      } catch (err) {
        console.error("Error de red o permisos al guardar en Supabase:", err);
      }
    } else {
      setSelectedCampaignId(newCampaignId);
    }

    setSavingProposal(false);
    setProposalSuccessMessage(
      "¡Propuesta de campaña guardada con éxito como BORRADOR! Puedes verla, personalizar destinatarios y realizar el envío en la pestaña 'Envíos y Seguimiento'."
    );
  }

  useEffect(() => {
    if (!isSupabaseConfigured || !supabase || !user) return;

    async function loadSupabaseCampaigns() {
      const [
        { data: campaignsData, error: campaignsError },
        { data: recipientsData, error: recipientsError },
        { data: emailCampaignsData },
        { data: emailRecipientsData },
      ] =
        await Promise.all([
          supabase!.from("campaigns").select("*").order("created_at", { ascending: false }),
          supabase!.from("campaign_recipients").select("*"),
          supabase!.from("email_campaigns").select("id,name,segment_filters,status,created_at"),
          supabase!.from("email_campaign_recipients").select("campaign_id,company_id,status,sent_at,replied_at,reply_from_email,reply_subject,reply_snippet,reply_body,reply_gmail_message_id,reply_gmail_url,error_message"),
        ]);

      if (!campaignsError && campaignsData) {
        const mappedCampaigns: CampaignDraft[] = campaignsData.map((row) => ({
          id: String(row.id),
          name: String(row.name ?? ""),
          type: mapCampaignTypeFromSupabase(String(row.type)),
          segment: String(row.segment ?? ""),
          status: row.status as CampaignStatus,
          createdAt: String(row.created_at ?? "").slice(0, 10),
          sendAt: String(row.send_at ?? "").slice(0, 10),
          recipients: 0,
          sent: 0,
          replied: 0,
          interested: 0,
          discarded: 0,
          templateId: templates[0]?.id ?? demoTemplates[0].id,
          product: String(row.product ?? ""),
          coupon: String(row.coupon ?? ""),
          attachments: normalizeAttachmentRows(row.attachments),
          recipientIds: [],
        }));

        const mappedRecipients: RecipientState[] = !recipientsError && recipientsData
          ? recipientsData.map((row) => ({
              campaignId: String(row.campaign_id),
              companyId: String(row.company_id),
              sent: Boolean(row.sent_at),
              replied: Boolean(row.replied_at),
              interested: Boolean(row.interested),
              discarded: Boolean(row.discarded),
            }))
          : [];

        const emailCampaignRows = (emailCampaignsData ?? []) as Row[];
        const emailRecipientRows = (emailRecipientsData ?? []) as Row[];
        const emailCampaignIdsByCrmCampaignId = new Map<string, Set<string>>();
        const emailCampaignIdsByName = new Map<string, Set<string>>();

        emailCampaignRows.forEach((row) => {
          const emailCampaignId = String(row.id ?? "");
          const filters = asRecord(row.segment_filters);
          const crmCampaignId = String(filters.crm_campaign_id ?? "");
          const name = normalizeString(String(row.name ?? ""));
          if (crmCampaignId) {
            const ids = emailCampaignIdsByCrmCampaignId.get(crmCampaignId) ?? new Set<string>();
            ids.add(emailCampaignId);
            emailCampaignIdsByCrmCampaignId.set(crmCampaignId, ids);
          }
          if (name) {
            const ids = emailCampaignIdsByName.get(name) ?? new Set<string>();
            ids.add(emailCampaignId);
            emailCampaignIdsByName.set(name, ids);
          }
        });

        const sentEmailCompanyIdsByCampaignId = new Map<string, Set<string>>();
        const emailRepliesByCampaignCompany = new Map<string, Partial<RecipientState>>();
        mappedCampaigns.forEach((campaign) => {
          const emailCampaignIds = emailCampaignIdsByCrmCampaignId.get(campaign.id) ?? emailCampaignIdsByName.get(normalizeString(campaign.name)) ?? new Set<string>();
          if (!emailCampaignIds.size) return;
          const sent = new Set<string>();
          emailRecipientRows.forEach((row) => {
            if (!emailCampaignIds.has(String(row.campaign_id ?? ""))) return;
            const companyId = String(row.company_id ?? "");
            if (!companyId) return;
            if (String(row.status ?? "") === "sent" || row.sent_at) sent.add(companyId);
            if (row.replied_at) {
              emailRepliesByCampaignCompany.set(`${campaign.id}:${companyId}`, {
                replied: true,
                replyFromEmail: String(row.reply_from_email ?? ""),
                replySubject: String(row.reply_subject ?? ""),
                replySnippet: String(row.reply_snippet ?? ""),
                replyBody: String(row.reply_body ?? ""),
                replyReceivedAt: String(row.replied_at ?? ""),
                replyGmailMessageId: String(row.reply_gmail_message_id ?? ""),
                replyGmailUrl: String(row.reply_gmail_url ?? ""),
              });
            }
          });
          sentEmailCompanyIdsByCampaignId.set(campaign.id, sent);
        });

        const campaignsWithRecipients = mappedCampaigns.map((campaign) => {
          const campaignRows = mappedRecipients.filter((recipient) => recipient.campaignId === campaign.id);
          const sentByGmail = sentEmailCompanyIdsByCampaignId.get(campaign.id) ?? new Set<string>();
          return {
            ...campaign,
            recipientIds: campaignRows.map((recipient) => recipient.companyId),
            recipients: campaignRows.length,
            sent: campaignRows.filter((recipient) => recipient.sent || sentByGmail.has(recipient.companyId)).length,
            replied: campaignRows.filter((recipient) => recipient.replied || emailRepliesByCampaignCompany.has(`${campaign.id}:${recipient.companyId}`)).length,
            interested: campaignRows.filter((recipient) => recipient.interested).length,
            discarded: campaignRows.filter((recipient) => recipient.discarded).length,
          };
        });

        const mergedRecipients = mappedRecipients.map((recipient) => {
          const reply = emailRepliesByCampaignCompany.get(`${recipient.campaignId}:${recipient.companyId}`);
          return {
            ...recipient,
            sent: recipient.sent || Boolean(sentEmailCompanyIdsByCampaignId.get(recipient.campaignId)?.has(recipient.companyId)),
            replied: recipient.replied || Boolean(reply),
            ...reply,
          };
        });

        setCampaigns(campaignsWithRecipients);
        saveCampaigns(campaignsWithRecipients);
        setRecipients(mergedRecipients);
        saveRecipients(mergedRecipients);
        setSelectedCampaignId(campaignsWithRecipients[0]?.id ?? "");
      }
    }

    void loadSupabaseCampaigns();
  }, [templates, user]);

  useEffect(() => {
    if (!isSupabaseConfigured) return;
    getGmailStatus()
      .then((status) => setGmailConnected(status.connected))
      .catch(() => setGmailConnected(false));
  }, []);

  const selectedCampaign = campaigns.find((campaign) => campaign.id === selectedCampaignId) ?? campaigns[0];
  const selectedTemplate = templates.find((template) => template.id === selectedCampaign?.templateId) ?? templates[0];
  const selectedCompanies = useMemo(() => {
    if (!selectedCampaign) return [];
    const recipientIds = getCampaignRecipientIds(selectedCampaign, companies);
    return companies.filter((company) => recipientIds.includes(company.id));
  }, [companies, selectedCampaign]);
  const availableCompanies = useMemo(
    () => companies.filter((company) => !selectedCompanies.some((selectedCompany) => selectedCompany.id === company.id)),
    [companies, selectedCompanies],
  );

  const campaignRecipients = recipients.filter((recipient) => recipient.campaignId === selectedCampaign?.id);
  const analytics = {
    total: selectedCompanies.length,
    sent: campaignRecipients.filter((recipient) => recipient.sent).length,
    replied: campaignRecipients.filter((recipient) => recipient.replied).length,
    interested: campaignRecipients.filter((recipient) => recipient.interested).length,
    discarded: campaignRecipients.filter((recipient) => recipient.discarded).length,
    withoutOptIn: selectedCompanies.filter((company) => !company.whatsappOptIn).length,
  };
  const selectedReplies = campaignRecipients
    .filter((recipient) => recipient.replied && (recipient.replyBody || recipient.replySnippet || recipient.replySubject))
    .map((recipient) => ({
      recipient,
      company: companies.find((company) => company.id === recipient.companyId),
    }))
    .filter((item) => item.company);
  const formCities = useMemo(() => {
    if (!form.region) return [];
    return chileData.find((region) => normalizeString(region.region) === normalizeString(form.region))?.comunas.sort() ?? [];
  }, [form.region]);
  const formUsesInstallerBenefit = isInstallerCampaignType(form.companyType);
  const formTemplates = useMemo(
    () => (formUsesInstallerBenefit ? templates : templates.filter((template) => !isInstallerAccountTemplate(template))),
    [formUsesInstallerBenefit, templates],
  );
  const previewTargetCompanies = useMemo(
    () =>
      getFilteredCampaignCompanies(companies, {
        companyType: form.companyType,
        region: form.region,
        city: form.city,
      }),
    [companies, form.city, form.companyType, form.region],
  );
  const previewWithEmail = previewTargetCompanies.filter((company) => company.email).length;
  const previewWithWhatsApp = previewTargetCompanies.filter((company) => company.whatsapp || company.phone).length;
  const previewVisibleCompanies = previewTargetCompanies.slice(0, 50);

  useEffect(() => {
    setForm((current) => {
      const selectedFormTemplate = templates.find((template) => template.id === current.templateId);
      const fallbackTemplateId = templates.find((template) => !isInstallerAccountTemplate(template))?.id ?? templates[0]?.id ?? "";

      if (isInstallerCampaignType(current.companyType)) {
        return current.coupon ? current : { ...current, coupon: DEFAULT_INSTALLER_BENEFIT };
      }

      if (!current.coupon && !isInstallerAccountTemplate(selectedFormTemplate)) {
        return current;
      }

      return {
        ...current,
        coupon: "",
        templateId: isInstallerAccountTemplate(selectedFormTemplate) ? fallbackTemplateId : current.templateId,
      };
    });
  }, [form.companyType, templates]);

  function persistCampaigns(nextCampaigns: CampaignDraft[]) {
    setCampaigns(nextCampaigns);
    saveCampaigns(nextCampaigns);
  }

  function persistRecipients(nextRecipients: RecipientState[]) {
    setRecipients(nextRecipients);
    saveRecipients(nextRecipients);
  }

  async function createCampaign(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCampaignFormError("");
    const targetCompanies = previewTargetCompanies;
    if (!form.name.trim()) {
      setCampaignFormError("Falta el nombre de la campana. Escribe un nombre para identificarla antes de crearla.");
      return;
    }
    if (!targetCompanies.length) {
      setCampaignFormError("No hay empresas que coincidan con la clasificacion, region y ciudad seleccionadas.");
      return;
    }
    const segmentDescription = describeCampaignSegment({
      companyType: form.companyType,
      region: form.region,
      city: form.city,
    });
    const formTemplate = templates.find((template) => template.id === form.templateId) ?? templates[0];
    const campaignBenefit = isInstallerCampaignType(form.companyType) ? form.coupon : "";
    const created: CampaignDraft = {
      id: `cam-${crypto.randomUUID()}`,
      name: form.name.trim(),
      type: form.type,
      segment: segmentDescription,
      status: "borrador",
      createdAt: new Date().toISOString().slice(0, 10),
      sendAt: form.sendAt,
      recipients: targetCompanies.length,
      sent: 0,
      replied: 0,
      interested: 0,
      discarded: 0,
      templateId: form.templateId,
      product: form.product,
      coupon: campaignBenefit,
      recipientIds: targetCompanies.map((company) => company.id),
      attachments: formAttachments,
    };
    persistCampaigns([created, ...campaigns]);
    setSelectedCampaignId(created.id);
    setShowForm(false);
    setForm((current) => ({ ...current, name: "" }));

    if (isSupabaseConfigured && supabase && user) {
      try {
        const { data: dbCampaign, error: campaignError } = await supabase
          .from("campaigns")
          .insert({
            name: created.name,
            type:
              created.type.toLowerCase() === "whatsapp"
                ? "whatsapp"
                : created.type.toLowerCase() === "email"
                ? "email"
                : "mixta",
            segment: created.segment,
            message: formTemplate?.body ?? "",
            status: "borrador",
            product: created.product,
            coupon: created.coupon,
            attachments: created.attachments ?? [],
            send_at: created.sendAt ? new Date(`${created.sendAt}T12:00:00`).toISOString() : null,
          })
          .select()
          .single();

        if (campaignError) throw campaignError;

        if (dbCampaign) {
          const dbCampaignId = String(dbCampaign.id);
          const recipientsToInsert = targetCompanies.map((company) => ({
            campaign_id: dbCampaignId,
            company_id: company.id,
            rendered_message: renderMessage(formTemplate, company, created),
          }));

          if (recipientsToInsert.length) {
            const { error: recipientsError } = await supabase.from("campaign_recipients").insert(recipientsToInsert);
            if (recipientsError) throw recipientsError;
          }

          const savedCampaign = { ...created, id: dbCampaignId };
          const savedRecipients = targetCompanies.map((company) => ({
            campaignId: dbCampaignId,
            companyId: company.id,
            sent: false,
            replied: false,
            interested: false,
            discarded: false,
          }));

          persistCampaigns([savedCampaign, ...campaigns]);
          persistRecipients([...savedRecipients, ...recipients]);
          setSelectedCampaignId(dbCampaignId);
        }
      } catch (err) {
        console.error("Error al guardar campana en Supabase:", err);
        alert("La campana quedo como borrador local, pero no se pudo guardar en Supabase. Revisa la actualizacion de adjuntos en SQL.");
      }
    }

    setFormAttachments([]);
  }

  function updateCampaignStatus(status: CampaignStatus) {
    if (!selectedCampaign) return;
    const nextCampaigns = campaigns.map((campaign) =>
      campaign.id === selectedCampaign.id ? { ...campaign, status } : campaign,
    );
    persistCampaigns(nextCampaigns);
  }

  function updateCampaignRecipients(recipientIds: string[]) {
    if (!selectedCampaign) return;
    const uniqueRecipientIds = Array.from(new Set(recipientIds));
    const nextCampaigns = campaigns.map((campaign) =>
      campaign.id === selectedCampaign.id
        ? { ...campaign, recipientIds: uniqueRecipientIds, recipients: uniqueRecipientIds.length }
        : campaign,
    );
    persistCampaigns(nextCampaigns);
  }

  function addRecipient() {
    if (!selectedCampaign || !companyToAdd) return;
    const currentRecipientIds = getCampaignRecipientIds(selectedCampaign, companies);
    updateCampaignRecipients([...currentRecipientIds, companyToAdd]);
    setCompanyToAdd("");
  }

  function removeRecipient(companyId: string) {
    if (!selectedCampaign) return;
    const nextRecipientIds = getCampaignRecipientIds(selectedCampaign, companies).filter((id) => id !== companyId);
    updateCampaignRecipients(nextRecipientIds);
    persistRecipients(
      recipients.filter((recipient) => !(recipient.campaignId === selectedCampaign.id && recipient.companyId === companyId)),
    );
  }

  function ensureRecipientRows(markSent = false) {
    if (!selectedCampaign) return;

    const existingKeys = new Set(recipients.map((recipient) => `${recipient.campaignId}:${recipient.companyId}`));
    const createdRows = selectedCompanies
      .filter((company) => !existingKeys.has(`${selectedCampaign.id}:${company.id}`))
      .map((company) => ({
        campaignId: selectedCampaign.id,
        companyId: company.id,
        sent: markSent,
        replied: false,
        interested: false,
        discarded: false,
      }));
    const nextRecipients = recipients
      .map((recipient) =>
        recipient.campaignId === selectedCampaign.id && markSent ? { ...recipient, sent: true } : recipient,
      )
      .concat(createdRows);

    persistRecipients(nextRecipients);
  }

  function confirmCampaign() {
    ensureRecipientRows(false);
    updateCampaignStatus("programada");
  }

  function markCampaignSent() {
    ensureRecipientRows(true);
    updateCampaignStatus("enviada");
  }

  async function markCampaignEmailRecipientsSent(companyIds: string[]) {
    if (!selectedCampaign || !companyIds.length) return;

    const ids = new Set(companyIds);
    const existingKeys = new Set(recipients.map((recipient) => `${recipient.campaignId}:${recipient.companyId}`));
    const createdRows = selectedCompanies
      .filter((company) => ids.has(company.id) && !existingKeys.has(`${selectedCampaign.id}:${company.id}`))
      .map((company) => ({
        campaignId: selectedCampaign.id,
        companyId: company.id,
        sent: true,
        replied: false,
        interested: false,
        discarded: false,
      }));
    const nextRecipients = recipients
      .map((recipient) =>
        recipient.campaignId === selectedCampaign.id && ids.has(recipient.companyId)
          ? { ...recipient, sent: true }
          : recipient,
      )
      .concat(createdRows);

    persistRecipients(nextRecipients);
    updateCampaignStatus("enviada");

    if (isSupabaseConfigured && supabase) {
      const sentAt = new Date().toISOString();
      await supabase
        .from("campaign_recipients")
        .update({ sent_at: sentAt })
        .eq("campaign_id", selectedCampaign.id)
        .in("company_id", companyIds);
      await supabase.from("campaigns").update({ status: "enviada" }).eq("id", selectedCampaign.id);
    }
  }

  async function executeMetaCampaign() {
    if (!selectedCampaign || !isSupabaseConfigured || !supabase) return;
    setSendingCampaign(true);
    setSendingResults(null);

    if (selectedTemplate && isInstallerAccountTemplate(selectedTemplate) && selectedCompanies.some((company) => !canReceiveInstallerBenefit(company))) {
      setSendingResults({
        success: 0,
        failed: selectedCompanies.length,
        log: ["Campana bloqueada: la plantilla de cuenta instalador solo se puede usar con empresas tipo tecnico o instalador grande."],
      });
      setSendingCampaign(false);
      return;
    }

    const mappedRecipients = selectedCompanies.map((company) => {
      const phone = company.whatsapp || company.phone || "";
      return {
        phone,
        companyId: company.id,
        parameters: [
          company.name,
          company.contactName || "cliente",
          company.city || "su zona",
          selectedCampaign.product || "",
          getCampaignBenefitForCompany(selectedCampaign, company)
        ]
      };
    }).filter((r) => r.phone);

    if (mappedRecipients.length === 0) {
      setSendingResults({
        success: 0,
        failed: 0,
        log: ["❌ Error: No hay destinatarios con número de WhatsApp válido."]
      });
      setSendingCampaign(false);
      return;
    }

    try {
      const { data, error } = await supabase.functions.invoke("crm-agent/send-campaign", {
        body: {
          campaignId: selectedCampaign.id,
          templateName: metaTemplateName,
          recipients: mappedRecipients,
          allowWithoutOptIn,
          adminOverrideReason
        },
        headers: {
          "x-climactiva-api-key": metaApiKey
        }
      });

      if (error || !data || !data.success) {
        setSendingResults({
          success: 0,
          failed: mappedRecipients.length,
          log: [error?.message || data?.error || "Error al invocar la función de Supabase."]
        });
      } else {
        const results = data.results as Array<{ phone: string; success: boolean; error?: string }>;
        const successCount = results.filter((r) => r.success).length;
        const failedCount = results.filter((r) => !r.success).length;
        const logMsgs = results.map((r) => 
          r.success 
            ? `✅ Enviado con éxito a ${r.phone}`
            : `❌ Falló para ${r.phone}: ${r.error || "error desconocido"}`
        );

        setSendingResults({
          success: successCount,
          failed: failedCount,
          log: logMsgs
        });

        if (successCount > 0) {
          markCampaignSent();
        }
      }
    } catch (err) {
      setSendingResults({
        success: 0,
        failed: mappedRecipients.length,
        log: [err instanceof Error ? err.message : "Error inesperado al conectar con el servidor."]
      });
    } finally {
      setSendingCampaign(false);
    }
  }

  async function executeGmailCampaign() {
    if (!selectedCampaign || !selectedTemplate || !isSupabaseConfigured || !supabase) return;

    if (isInstallerAccountTemplate(selectedTemplate) && selectedCompanies.some((company) => !canReceiveInstallerBenefit(company))) {
      setSendingResults({
        success: 0,
        failed: selectedCompanies.length,
        log: ["Campana bloqueada: la plantilla de cuenta instalador solo se puede usar con empresas tipo tecnico o instalador grande."],
      });
      return;
    }

    const emailRecipients = selectedCompanies
      .filter((company) => company.email)
      .map((company) => {
        const benefit = getCampaignBenefitForCompany(selectedCampaign, company);
        return {
          companyId: company.id,
          toEmail: company.email,
          variables: {
            nombre_empresa: company.name,
            nombre_contacto: company.contactName || "equipo comercial",
            ciudad: company.city || "su zona",
            tipo_empresa: company.type,
            producto_destacado: selectedCampaign.product || "",
            cupon: benefit,
            beneficio: benefit,
          },
        };
      });

    if (!emailRecipients.length) {
      setSendingResults({
        success: 0,
        failed: 0,
        log: ["No hay destinatarios con email valido en esta campana."],
      });
      return;
    }

    const confirmed = window.confirm(
      `Enviar campana Gmail a ${emailRecipients.length} destinatarios desde msanhueza@latinchile.cl?\n\nRevisa que el segmento sea preciso, que el mensaje este personalizado y que tengas permiso comercial para contactar.`,
    );
    if (!confirmed) return;

    setSendingCampaign(true);
    setSendingResults(null);

    try {
      const data = await sendGmailCampaign({
        name: selectedCampaign.name,
        subject: selectedCampaign.name,
        bodyText: selectedTemplate.body,
        bodyHtml: selectedTemplate.body.replace(/\n/g, "<br />"),
        segmentFilters: {
          crm_campaign_id: selectedCampaign.id,
          segment: selectedCampaign.segment,
          type: selectedCampaign.type,
          product: selectedCampaign.product,
          coupon: selectedCompanies.every(canReceiveInstallerBenefit) ? selectedCampaign.coupon : "",
        },
        recipients: emailRecipients,
        attachments: selectedCampaign.attachments || [],
      });

      setSendingResults({
        success: Number(data.sent || 0),
        failed: Number(data.failed || 0),
        log: Array.isArray(data.log) ? data.log : [],
      });

      if (Number(data.sent || 0) > 0) {
        await markCampaignEmailRecipientsSent(emailRecipients.map((recipient) => recipient.companyId));
      }
    } catch (error) {
      setSendingResults({
        success: 0,
        failed: emailRecipients.length,
        log: [error instanceof Error ? error.message : "Error inesperado al enviar Gmail."],
      });
    } finally {
      setSendingCampaign(false);
    }
  }

  async function syncRepliesFromGmail() {
    if (!selectedCampaign || !gmailConnected) return;
    setSyncingReplies(true);
    setSendingResults(null);

    try {
      const data = await syncGmailReplies();
      const selectedName = normalizeString(selectedCampaign.name);
      const repliesForSelected = data.replies.filter(
        (reply) => reply.campaignId === selectedCampaign.id || normalizeString(reply.campaignName) === selectedName,
      );
      const repliedCompanyIds = new Set(repliesForSelected.map((reply) => reply.companyId).filter(Boolean));

      if (repliedCompanyIds.size) {
        const nextRecipients = recipients.map((recipient) =>
          recipient.campaignId === selectedCampaign.id && repliedCompanyIds.has(recipient.companyId)
            ? {
                ...recipient,
                replied: true,
                ...(() => {
                  const reply = repliesForSelected.find((item) => item.companyId === recipient.companyId);
                  return reply
                    ? {
                        replyFromEmail: reply.fromEmail,
                        replySubject: reply.subject,
                        replySnippet: reply.snippet,
                        replyBody: reply.body,
                        replyReceivedAt: reply.receivedAt,
                        replyGmailMessageId: reply.gmailMessageId,
                        replyGmailUrl: reply.gmailUrl,
                      }
                    : {};
                })(),
              }
            : recipient,
        );
        persistRecipients(nextRecipients);
      }

      setSendingResults({
        success: repliesForSelected.length,
        failed: 0,
        log: repliesForSelected.length
          ? repliesForSelected.map((reply) => `${reply.fromEmail}: respondió "${reply.subject || selectedCampaign.name}"`)
          : [`Se revisaron ${data.checked} correos enviados. No hay respuestas nuevas para esta campaña.`],
      });
    } catch (error) {
      setSendingResults({
        success: 0,
        failed: 1,
        log: [error instanceof Error ? error.message : "No se pudieron sincronizar respuestas Gmail."],
      });
    } finally {
      setSyncingReplies(false);
    }
  }

  function updateRecipient(companyId: string, field: keyof Omit<RecipientState, "campaignId" | "companyId">) {
    if (!selectedCampaign) return;
    const existing = recipients.find((recipient) => recipient.campaignId === selectedCampaign.id && recipient.companyId === companyId);
    const base = existing ?? {
      campaignId: selectedCampaign.id,
      companyId,
      sent: false,
      replied: false,
      interested: false,
      discarded: false,
    };
    const updated = { ...base, [field]: !base[field] };
    const nextRecipients = existing
      ? recipients.map((recipient) =>
          recipient.campaignId === selectedCampaign.id && recipient.companyId === companyId ? updated : recipient,
        )
      : [updated, ...recipients];
    persistRecipients(nextRecipients);
  }

  return (
    <section className="page-stack">
      <div className="page-heading">
        <div>
          <p>Email y WhatsApp con confirmacion manual</p>
          <h1>Campanas</h1>
        </div>
        {!showSuggestions && (
          <button className="primary-button" type="button" onClick={() => setShowForm((current) => !current)}>
            <Plus size={18} />
            Nueva campana
          </button>
        )}
      </div>

      {/* Selector de pestañas */}
      <div className="tab-group" style={{ display: "flex", gap: "12px", borderBottom: "1px solid #dfe7ea", paddingBottom: "12px", marginBottom: "20px" }}>
        <button 
          className={!showSuggestions ? "tab-button active" : "tab-button"} 
          type="button"
          onClick={() => setShowSuggestions(false)}
          style={{
            background: !showSuggestions ? "#0b7285" : "transparent",
            color: !showSuggestions ? "#fff" : "#40515b",
            border: "1px solid #cfdade",
            borderRadius: "8px",
            padding: "10px 18px",
            cursor: "pointer",
            fontWeight: "bold",
            transition: "all 0.2s"
          }}
        >
          Envíos y Seguimiento
        </button>
        <button 
          className={showSuggestions ? "tab-button active" : "tab-button"} 
          type="button"
          onClick={() => setShowSuggestions(true)}
          style={{
            background: showSuggestions ? "#0b7285" : "transparent",
            color: showSuggestions ? "#fff" : "#40515b",
            border: "1px solid #cfdade",
            borderRadius: "8px",
            padding: "10px 18px",
            cursor: "pointer",
            fontWeight: "bold",
            display: "flex",
            alignItems: "center",
            gap: "8px",
            transition: "all 0.2s"
          }}
        >
          💡 Propuestas Inteligentes
        </button>
      </div>

      {!showSuggestions ? (
        <>
          {showForm ? (
            <form className="panel campaign-form" onSubmit={createCampaign}>
              <div className="form-section">
                <h2>Crear campana</h2>
                <div className="form-grid">
                  <label>
                    Nombre
                    <input
                      value={form.name}
                      placeholder="Ej: Tecnicos RM julio 2026"
                      onChange={(event) => {
                        setCampaignFormError("");
                        setForm({ ...form, name: event.target.value });
                      }}
                    />
                  </label>
                  <label>
                    Tipo
                    <select value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value as CampaignType })}>
                      {campaignTypes.map((type) => <option key={type} value={type}>{type}</option>)}
                    </select>
                  </label>
                  <label>
                    Clasificacion / tipo
                    <select value={form.companyType} onChange={(event) => setForm({ ...form, companyType: event.target.value as CampaignCompanyTypeFilter })}>
                      {companyTypeFilters.map((type) => <option key={type} value={type}>{type}</option>)}
                    </select>
                  </label>
                  <label>
                    Fecha de envio
                    <input type="date" value={form.sendAt} onChange={(event) => setForm({ ...form, sendAt: event.target.value })} />
                  </label>
                  <label>
                    Plantilla
                    <select value={form.templateId} onChange={(event) => setForm({ ...form, templateId: event.target.value })}>
                      {formTemplates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}
                    </select>
                  </label>
                  <label>
                    Producto destacado
                    <input value={form.product} onChange={(event) => setForm({ ...form, product: event.target.value })} />
                  </label>
                  {formUsesInstallerBenefit ? (
                    <label>
                      Llamado / beneficio
                      <input value={form.coupon} onChange={(event) => setForm({ ...form, coupon: event.target.value })} />
                    </label>
                  ) : null}
                  <label>
                    Region
                    <select
                      value={form.region}
                      onChange={(event) => setForm({ ...form, region: event.target.value, city: "" })}
                    >
                      <option value="">Todas las regiones</option>
                      {chileData.map((region) => <option key={region.region} value={region.region}>{region.region}</option>)}
                    </select>
                  </label>
                  <label>
                    Ciudad / comuna
                    <select
                      value={form.city}
                      onChange={(event) => setForm({ ...form, city: event.target.value })}
                      disabled={!form.region}
                    >
                      <option value="">Todas las comunas</option>
                      {formCities.map((city) => <option key={city} value={city}>{city}</option>)}
                    </select>
                  </label>
                </div>
                <div className="deliverability-panel" style={{ marginTop: "16px" }}>
                  <strong>Segmento automatico: {describeCampaignSegment({ companyType: form.companyType, region: form.region, city: form.city })}</strong>
                  <p>
                    Se agregaran automaticamente {previewTargetCompanies.length} empresa{previewTargetCompanies.length === 1 ? "" : "s"}.
                    {["email", "mixta"].includes(form.type) ? ` Con email: ${previewWithEmail}.` : ""}
                    {["WhatsApp", "mixta"].includes(form.type) ? ` Con WhatsApp/telefono: ${previewWithWhatsApp}.` : ""}
                  </p>
                </div>
                <div className="panel" style={{ marginTop: "16px", padding: "14px", background: "#ffffff" }}>
                  <div className="panel-heading" style={{ marginBottom: "10px" }}>
                    <h2 style={{ fontSize: "16px" }}>Empresas seleccionadas automaticamente</h2>
                    <span>{previewTargetCompanies.length} empresa{previewTargetCompanies.length === 1 ? "" : "s"}</span>
                  </div>
                  {previewTargetCompanies.length ? (
                    <>
                      <div className="table-wrap" style={{ maxHeight: "320px", overflow: "auto" }}>
                        <table>
                          <thead>
                            <tr>
                              <th>Empresa</th>
                              <th>Tipo</th>
                              <th>Ubicacion</th>
                              <th>Email</th>
                              <th>WhatsApp/telefono</th>
                            </tr>
                          </thead>
                          <tbody>
                            {previewVisibleCompanies.map((company) => (
                              <tr key={company.id}>
                                <td>
                                  <strong>{company.name}</strong>
                                  {company.legalName ? <small>{company.legalName}</small> : null}
                                </td>
                                <td>{company.type}</td>
                                <td>
                                  {company.city || "Sin comuna"}
                                  <small>{company.region || "Sin region"}</small>
                                </td>
                                <td>{company.email || <span className="muted">Sin email</span>}</td>
                                <td>{company.whatsapp || company.phone || <span className="muted">Sin telefono</span>}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      {previewTargetCompanies.length > previewVisibleCompanies.length ? (
                        <p className="muted" style={{ marginTop: "10px" }}>
                          Mostrando las primeras {previewVisibleCompanies.length}. Al crear la campana se agregaran las {previewTargetCompanies.length} empresas del filtro.
                        </p>
                      ) : null}
                    </>
                  ) : (
                    <p className="muted">No hay empresas que coincidan con estos filtros.</p>
                  )}
                </div>
                {renderAttachmentsEditor(false)}
              </div>
              <div className="form-actions">
                {campaignFormError ? <p className="gmail-notice error">{campaignFormError}</p> : null}
                <button className="ghost-button" type="button" onClick={() => setShowForm(false)}>Cancelar</button>
                <button className="primary-button" type="submit" disabled={!previewTargetCompanies.length}>Crear y revisar</button>
              </div>
            </form>
          ) : null}

          <div className="panel">
            <div className="panel-heading">
              <h2>Campanas comerciales</h2>
              <span>{campaigns.length} campanas</span>
            </div>
            <div className="campaign-grid">
              {campaigns.map((campaign) => (
                <article className={`campaign-card ${selectedCampaign?.id === campaign.id ? "selected" : ""}`} key={campaign.id}>
                  <div>
                    <Megaphone size={22} />
                    <span className={`status-badge ${campaign.status}`}>{campaign.status}</span>
                  </div>
                  <h3>{campaign.name}</h3>
                  <p>{campaign.segment}</p>
                  <dl>
                    <div><dt>Tipo</dt><dd>{campaign.type}</dd></div>
                    <div><dt>Destinatarios</dt><dd>{campaign.recipientIds.length || campaign.recipients}</dd></div>
                    <div><dt>Envio</dt><dd>{campaign.sendAt}</dd></div>
                    <div><dt>Respondidos</dt><dd>{recipients.filter((recipient) => recipient.campaignId === campaign.id && recipient.replied).length}</dd></div>
                  </dl>
                  <button className="ghost-button" type="button" onClick={() => setSelectedCampaignId(campaign.id)}>
                    <Eye size={16} />
                    Revisar antes de enviar
                  </button>
                </article>
              ))}
            </div>
          </div>

          {selectedCampaign ? (
            <>
              <div className="metric-grid">
                <Metric label="Destinatarios" value={analytics.total} />
                <Metric label="Enviados" value={analytics.sent} />
                <Metric label="Respondidos" value={analytics.replied} />
                <Metric label="Interesados" value={analytics.interested} />
              </div>

              <div className="two-column">
                <div className="panel">
                  <div className="panel-heading">
                    <h2>Vista previa obligatoria</h2>
                    <span>{selectedCampaign.name}</span>
                  </div>
                  <div className="message-preview">
                    <span>Plantilla: {selectedTemplate.name}</span>
                    <p>{selectedCompanies[0] ? renderMessage(selectedTemplate, selectedCompanies[0], selectedCampaign) : "No hay destinatarios para este segmento."}</p>
                  </div>
                  {selectedCampaign.attachments && selectedCampaign.attachments.length > 0 && (
                    <div style={{ padding: "14px", marginTop: "14px", background: "#f1f3f5", borderRadius: "8px", border: "1px solid #dee2e6" }}>
                      <strong style={{ fontSize: "13px", color: "#495057", display: "block", marginBottom: "8px" }}>
                        📎 Documentos Adjuntos en esta Campaña ({selectedCampaign.attachments.length}):
                      </strong>
                      <ul style={{ margin: 0, paddingLeft: "20px", fontSize: "13px" }}>
                        {selectedCampaign.attachments.map((att: { name: string; url: string }, i: number) => (
                          <li key={i} style={{ marginBottom: "4px" }}>
                            <a href={att.url} target="_blank" rel="noopener noreferrer" style={{ color: "#0b7285", fontWeight: "bold", textDecoration: "underline" }}>
                              {att.name}
                            </a>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {["email", "mixta"].includes(selectedCampaign.type) ? (
                    <div className="deliverability-panel">
                      <strong>Buenas practicas Gmail</strong>
                      <p>
                        Envia segmentos pequenos, usa variables personalizadas, evita asuntos agresivos y agrega datos claros de contacto de Clima Activa / LatinChile.
                        Para campanas recurrentes queda pendiente agregar baja/desuscripcion.
                      </p>
                    </div>
                  ) : null}
                  <div className="campaign-actions">
                    <button className="ghost-button" type="button" onClick={confirmCampaign}>
                      <CheckCircle2 size={18} />
                      Confirmar lista
                    </button>
                    <button className="primary-button" type="button" onClick={markCampaignSent}>
                      <Send size={18} />
                      Marcar como enviada
                    </button>
                    {["WhatsApp", "mixta"].includes(selectedCampaign.type) && (
                      <button 
                        className="primary-button" 
                        type="button" 
                        onClick={() => {
                          if (!metaTemplateName && selectedTemplate.name) {
                            setMetaTemplateName(selectedTemplate.name);
                          }
                          setShowMetaModal(true);
                        }}
                        style={{ background: "#25D366", borderColor: "#25D366", color: "#ffffff" }}
                      >
                        <Send size={18} />
                        Enviar vía Meta API
                      </button>
                    )}
                    {["email", "mixta"].includes(selectedCampaign.type) && (
                      <>
                        <button
                          className="primary-button"
                          type="button"
                          onClick={executeGmailCampaign}
                          disabled={sendingCampaign || !gmailConnected}
                          title={gmailConnected ? undefined : "Gmail no esta conectado. Ve a Administracion para conectar."}
                        >
                          <Send size={18} />
                          {sendingCampaign ? "Enviando..." : gmailConnected ? "Enviar via Gmail API" : "Gmail desconectado"}
                        </button>
                        <button
                          className="ghost-button"
                          type="button"
                          onClick={syncRepliesFromGmail}
                          disabled={syncingReplies || !gmailConnected}
                          title={gmailConnected ? "Busca respuestas de clientes en Gmail y actualiza esta campana." : "Gmail no esta conectado. Ve a Administracion para conectar."}
                        >
                          <CheckCircle2 size={18} />
                          {syncingReplies ? "Sincronizando..." : "Sincronizar respuestas Gmail"}
                        </button>
                      </>
                    )}
                    <button className="ghost-button" type="button" onClick={() => updateCampaignStatus("pausada")}>
                      <XCircle size={18} />
                      Pausar
                    </button>
                  </div>
                </div>

                <div className="panel">
                  <div className="panel-heading">
                    <h2>Analisis de uso</h2>
                  </div>
                  <div className="bar-list">
                    <BarRow label="Tasa de envio" value={analytics.sent} max={analytics.total} />
                    <BarRow label="Tasa de respuesta" value={analytics.replied} max={analytics.sent || analytics.total} />
                    <BarRow label="Interesados" value={analytics.interested} max={analytics.total} />
                    <BarRow label="Descartados" value={analytics.discarded} max={analytics.total} />
                  </div>
                </div>
              </div>

              {selectedReplies.length ? (
                <div className="panel">
                  <div className="panel-heading">
                    <h2>Respuestas recibidas Gmail</h2>
                    <span>{selectedReplies.length} respuesta{selectedReplies.length === 1 ? "" : "s"}</span>
                  </div>
                  <div className="response-list" style={{ display: "grid", gap: "12px" }}>
                    {selectedReplies.map(({ recipient, company }) => (
                      <article key={`${recipient.campaignId}:${recipient.companyId}`} style={{ border: "1px solid #dfe7ea", borderRadius: "10px", padding: "14px", background: "#f8fbfc" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", gap: "12px", alignItems: "flex-start" }}>
                          <div>
                            <strong>{company?.name}</strong>
                            <p className="muted" style={{ margin: "4px 0 0" }}>
                              {recipient.replyFromEmail || company?.email || "Correo no identificado"}
                              {recipient.replyReceivedAt ? ` · ${new Date(recipient.replyReceivedAt).toLocaleString("es-CL")}` : ""}
                            </p>
                          </div>
                          {recipient.replyGmailMessageId ? (
                            <a
                              className="ghost-button"
                              href={recipient.replyGmailUrl || `https://mail.google.com/mail/u/msanhueza%40latinchile.cl/#inbox/${recipient.replyGmailMessageId}`}
                              target="_blank"
                              rel="noreferrer"
                              style={{ textDecoration: "none" }}
                            >
                              Abrir Gmail
                            </a>
                          ) : null}
                        </div>
                        <h3 style={{ fontSize: "15px", margin: "12px 0 8px" }}>{recipient.replySubject || selectedCampaign.name}</h3>
                        <p style={{ whiteSpace: "pre-wrap", margin: 0 }}>
                          {recipient.replyBody || recipient.replySnippet || "Respuesta detectada sin texto disponible."}
                        </p>
                      </article>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="panel">
                <div className="panel-heading">
                  <h2>Destinatarios y resultado</h2>
                  <span>No envia mensajes automaticamente</span>
                </div>
                <div className="recipient-editor">
                  <label>
                    Agregar destinatario
                    <select value={companyToAdd} onChange={(event) => setCompanyToAdd(event.target.value)}>
                      <option value="">Selecciona una empresa</option>
                      {availableCompanies.map((company) => (
                        <option key={company.id} value={company.id}>
                          {company.name} - {company.type} - {company.city}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button className="ghost-button" type="button" onClick={addRecipient} disabled={!companyToAdd}>
                    <UserPlus size={16} />
                    Agregar
                  </button>
                </div>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Lista</th>
                        <th>Empresa</th>
                        <th>Contacto</th>
                        <th>Canal</th>
                        <th>Mensaje</th>
                        <th>Estado</th>
                        <th>Respuesta</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selectedCompanies.map((company) => {
                        const row = recipients.find((recipient) => recipient.campaignId === selectedCampaign.id && recipient.companyId === company.id);
                        return (
                          <tr key={company.id}>
                            <td>
                              <button className="mini-toggle danger" type="button" onClick={() => removeRecipient(company.id)}>
                                <UserMinus size={13} />
                                sacar
                              </button>
                            </td>
                            <td>
                              <strong>{company.name}</strong>
                              <small>{company.type} - {company.city}</small>
                            </td>
                            <td>
                              {company.contactName}
                              <small>{company.email || company.whatsapp}</small>
                            </td>
                            <td>{selectedCampaign.type}</td>
                            <td className="message-cell">{renderMessage(selectedTemplate, company, selectedCampaign)}</td>
                            <td>
                              <button className={row?.sent ? "mini-toggle active" : "mini-toggle"} type="button" onClick={() => updateRecipient(company.id, "sent")}>
                                enviado
                              </button>
                            </td>
                            <td>
                              <div className="recipient-actions">
                                <button className={row?.replied ? "mini-toggle active" : "mini-toggle"} type="button" onClick={() => updateRecipient(company.id, "replied")}>respondio</button>
                                <button className={row?.interested ? "mini-toggle active" : "mini-toggle"} type="button" onClick={() => updateRecipient(company.id, "interested")}>interesado</button>
                                <button className={row?.discarded ? "mini-toggle active danger" : "mini-toggle"} type="button" onClick={() => updateRecipient(company.id, "discarded")}>descartado</button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          ) : null}
        </>
      ) : (
        /* UI de Propuestas Inteligentes */
        <div className="suggestions-planner page-stack" style={{ gap: "20px" }}>
          <div className="panel" style={{ padding: "24px" }}>
            <div style={{ marginBottom: "20px", display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <div>
                <h2 style={{ color: "#103842", margin: 0 }}>💡 Propuestas de Campañas Sugeridas</h2>
                <p className="muted" style={{ fontSize: "14px", marginTop: "6px" }}>
                  El CRM ha analizado tu base de datos de empresas y propone las siguientes campañas segmentadas. Revisa, edita los mensajes y desmarca a los clientes que prefieras excluir.
                </p>
              </div>
              {dismissedProposalIds.length > 0 && (
                <button type="button" className="link-button" onClick={restoreDismissedProposals}>
                  Restaurar {dismissedProposalIds.length} propuesta{dismissedProposalIds.length > 1 ? "s" : ""} eliminada{dismissedProposalIds.length > 1 ? "s" : ""}
                </button>
              )}
            </div>

            <div className="two-column" style={{ display: "grid", gridTemplateColumns: "1fr 1.5fr", gap: "24px" }}>
              {/* Columna Izquierda: Listado de propuestas */}
              <div className="proposal-list" style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                {proposals.map((prop, index) => {
                  const isSelected = selectedProposalIndex === index;
                  return (
                    <div 
                      key={prop.id}
                      onClick={() => setSelectedProposalIndex(index)}
                      style={{
                        border: isSelected ? "2px solid #0b7285" : "1px solid #dfe7ea",
                        borderRadius: "8px",
                        padding: "16px",
                        cursor: "pointer",
                        background: isSelected ? "#f4f8f9" : "#ffffff",
                        boxShadow: isSelected ? "0 4px 12px rgba(11,114,133,0.12)" : "none",
                        transition: "all 0.2s ease"
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
                        <span className={`status-badge ${prop.type === "WhatsApp" ? "programada" : prop.type === "email" ? "pausada" : "enviada"}`} style={{ fontSize: "11px", textTransform: "uppercase" }}>
                          {prop.type}
                        </span>
                        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                          <span style={{ fontSize: "12px", fontWeight: "bold", color: "#62717a" }}>
                            👥 {prop.potentialCompanies.length} potenciales
                          </span>
                          <button
                            type="button"
                            title="Eliminar propuesta"
                            aria-label="Eliminar propuesta"
                            onClick={(event) => {
                              event.stopPropagation();
                              dismissProposal(prop.id);
                            }}
                            style={{ border: "none", background: "none", cursor: "pointer", color: "#c92a2a", fontSize: "16px", lineHeight: 1, padding: "2px 4px" }}
                          >
                            ✕
                          </button>
                        </div>
                      </div>
                      <h4 style={{ margin: "0 0 6px 0", color: "#103842", fontSize: "15px", fontWeight: "bold" }}>{prop.defaultName}</h4>
                      <p className="muted" style={{ fontSize: "13px", margin: 0 }}>{prop.description}</p>
                    </div>
                  );
                })}
              </div>

              {/* Columna Derecha: Formulario de edición */}
              {proposals[selectedProposalIndex] ? (
                <div className="panel" style={{ padding: "24px", background: "#ffffff", border: "1px solid #dfe7ea", borderRadius: "8px" }}>
                  {proposalSuccessMessage && (
                    <div style={{ background: "#d3f9d8", border: "1px solid #b2f2bb", color: "#2b8a3e", padding: "14px", borderRadius: "8px", marginBottom: "20px", fontSize: "14px", fontWeight: 500 }}>
                      {proposalSuccessMessage}
                    </div>
                  )}
                  {proposalEditSavedMessage && (
                    <div style={{ background: "#e7f5ff", border: "1px solid #a5d8ff", color: "#1864ab", padding: "14px", borderRadius: "8px", marginBottom: "20px", fontSize: "14px", fontWeight: 500 }}>
                      {proposalEditSavedMessage}
                    </div>
                  )}

                  <h3 style={{ marginTop: 0, marginBottom: "20px", color: "#103842" }}>Configuración del Borrador</h3>

                  <div className="campaign-form" style={{ display: "grid", gap: "16px", background: "none", border: "none", boxShadow: "none", padding: 0 }}>
                    <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontWeight: "bold", fontSize: "14px", color: "#40515b" }}>
                      Nombre de la Campaña
                      <input
                        type="text"
                        value={proposalForm.name}
                        onChange={(e) => setProposalForm({ ...proposalForm, name: e.target.value })}
                        style={{ minHeight: "40px", border: "1px solid #cfdade", borderRadius: "8px", padding: "0 12px" }}
                      />
                    </label>

                    <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontWeight: "bold", fontSize: "14px", color: "#40515b" }}>
                      Descripción de la propuesta
                      <textarea
                        value={proposalForm.description}
                        onChange={(e) => setProposalForm({ ...proposalForm, description: e.target.value })}
                        rows={2}
                        style={{ border: "1px solid #cfdade", borderRadius: "8px", padding: "10px 12px", fontFamily: "inherit", fontWeight: "normal" }}
                      />
                    </label>

                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
                      <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontWeight: "bold", fontSize: "14px", color: "#40515b" }}>
                        Canal de Envío
                        <select 
                          value={proposalForm.type} 
                          onChange={(e) => setProposalForm({ ...proposalForm, type: e.target.value as CampaignType })}
                          style={{ minHeight: "40px", border: "1px solid #cfdade", borderRadius: "8px", padding: "0 12px" }}
                        >
                          <option value="email">Email</option>
                          <option value="WhatsApp">WhatsApp</option>
                          <option value="mixta">Mixta (Email y WhatsApp)</option>
                        </select>
                      </label>

                      {isInstallerCampaignSegment(proposals[selectedProposalIndex].segment) ? (
                        <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontWeight: "bold", fontSize: "14px", color: "#40515b" }}>
                          Llamado / beneficio
                          <input 
                            type="text" 
                            value={proposalForm.coupon} 
                            onChange={(e) => setProposalForm({ ...proposalForm, coupon: e.target.value })} 
                            style={{ minHeight: "40px", border: "1px solid #cfdade", borderRadius: "8px", padding: "0 12px" }}
                          />
                        </label>
                      ) : null}
                    </div>

                    <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontWeight: "bold", fontSize: "14px", color: "#40515b" }}>
                      Producto Destacado
                      <input 
                        type="text" 
                        value={proposalForm.product} 
                        onChange={(e) => setProposalForm({ ...proposalForm, product: e.target.value })} 
                        style={{ minHeight: "40px", border: "1px solid #cfdade", borderRadius: "8px", padding: "0 12px" }}
                      />
                    </label>

                    {["email", "mixta"].includes(proposalForm.type) && (
                      <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontWeight: "bold", fontSize: "14px", color: "#40515b" }}>
                        Asunto del Correo
                        <input 
                          type="text" 
                          value={proposalForm.subject} 
                          onChange={(e) => setProposalForm({ ...proposalForm, subject: e.target.value })} 
                          style={{ minHeight: "40px", border: "1px solid #cfdade", borderRadius: "8px", padding: "0 12px" }}
                        />
                      </label>
                    )}

                    <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontWeight: "bold", fontSize: "14px", color: "#40515b" }}>
                      Cuerpo del Mensaje (Soporta variables)
                      <textarea 
                        value={proposalForm.message} 
                        onChange={(e) => setProposalForm({ ...proposalForm, message: e.target.value })}
                        style={{ minHeight: "140px", fontFamily: "monospace", fontSize: "13px", padding: "12px", borderRadius: "8px", border: "1px solid #cfdade", resize: "vertical" }}
                      />
                    </label>
                    {renderAttachmentsEditor(true)}
                  </div>

                  {/* Vista Previa en Vivo */}
                  <div style={{ marginTop: "24px", padding: "16px", background: "#f8f9fa", border: "1px solid #e9ecef", borderRadius: "8px" }}>
                    <strong style={{ fontSize: "13px", color: "#495057", display: "block", marginBottom: "8px" }}>
                      👁️ Vista Previa del Mensaje Renderizado:
                    </strong>
                    <div style={{ fontSize: "13px", color: "#343a40", whiteSpace: "pre-wrap", background: "#ffffff", padding: "14px", border: "1px solid #dee2e6", borderRadius: "6px", lineHeight: "1.5" }}>
                      {proposals[selectedProposalIndex].potentialCompanies.filter(c => !excludedCompanyIds.includes(c.id))[0] ? (
                        renderProposalPreview(
                          proposalForm.message,
                          proposals[selectedProposalIndex].potentialCompanies.filter(c => !excludedCompanyIds.includes(c.id))[0]
                        )
                      ) : (
                        <em style={{ color: "#868e96" }}>Ninguna empresa seleccionada. Selecciona al menos una de la lista de abajo para ver la vista previa.</em>
                      )}
                    </div>
                  </div>

                  {/* Selector de Destinatarios */}
                  <div style={{ marginTop: "24px" }}>
                    <h4 style={{ margin: "0 0 12px 0", color: "#103842", fontSize: "14px", fontWeight: "bold" }}>
                      Seleccionar Destinatarios Potenciales ({proposals[selectedProposalIndex].potentialCompanies.filter(c => !excludedCompanyIds.includes(c.id)).length} seleccionados)
                    </h4>
                    <div style={{ maxHeight: "200px", overflowY: "auto", border: "1px solid #cfdade", borderRadius: "8px", padding: "8px", background: "#fcfdfe" }}>
                      {proposals[selectedProposalIndex].potentialCompanies.length === 0 ? (
                        <p style={{ margin: "8px", fontSize: "13px", color: "#868e96", textAlign: "center" }}>No se encontraron empresas con el segmento comercial sugerido.</p>
                      ) : (
                        proposals[selectedProposalIndex].potentialCompanies.map((c) => {
                          const isChecked = !excludedCompanyIds.includes(c.id);
                          return (
                            <label 
                              key={c.id} 
                              style={{ 
                                display: "flex", 
                                alignItems: "center", 
                                gap: "10px", 
                                padding: "8px", 
                                fontSize: "13px", 
                                borderBottom: "1px solid #f1f3f5",
                                cursor: "pointer",
                                transition: "background 0.2s"
                              }}
                              className="checkbox-label"
                            >
                              <input 
                                type="checkbox" 
                                checked={isChecked}
                                onChange={() => {
                                  if (isChecked) {
                                    setExcludedCompanyIds([...excludedCompanyIds, c.id]);
                                  } else {
                                    setExcludedCompanyIds(excludedCompanyIds.filter(id => id !== c.id));
                                  }
                                }}
                                style={{ width: "16px", height: "16px", cursor: "pointer" }}
                              />
                              <div style={{ display: "flex", flexDirection: "column" }}>
                                <strong style={{ color: "#172026" }}>{c.name}</strong>
                                <span style={{ color: "#62717a", fontSize: "11px" }}>
                                  Contacto: {c.contactName || "Sin contacto"} | Ciudad: {c.city || "Sin ciudad"} | Tipo: {c.type}
                                </span>
                              </div>
                            </label>
                          );
                        })
                      )}
                    </div>
                  </div>

                  <div style={{ marginTop: "24px", display: "flex", gap: "12px", justifyContent: "flex-end" }}>
                    <button
                      className="ghost-button"
                      type="button"
                      onClick={saveProposalEdits}
                      title="Guarda estos cambios en la propuesta para que se mantengan la próxima vez que la abras"
                    >
                      Guardar cambios en la propuesta
                    </button>
                    <button
                      className="primary-button"
                      type="button"
                      onClick={saveProposedCampaign}
                      disabled={savingProposal || proposals[selectedProposalIndex].potentialCompanies.filter(c => !excludedCompanyIds.includes(c.id)).length === 0}
                    >
                      {savingProposal ? "Guardando..." : "Guardar como Borrador"}
                    </button>
                  </div>
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "200px", gap: "10px" }}>
                  <p className="muted">
                    {dismissedProposalIds.length > 0
                      ? "Eliminaste todas las propuestas sugeridas."
                      : "Selecciona una propuesta sugerida para ver su edición."}
                  </p>
                  {dismissedProposalIds.length > 0 && (
                    <button type="button" className="link-button" onClick={restoreDismissedProposals}>
                      Restaurar propuestas eliminadas
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {showMetaModal && (
        <div className="meta-modal-overlay">
          <div className="meta-modal-box">
            <h2>Enviar Campaña vía Meta Cloud API</h2>
            
            <div className="meta-form-grid">
              <label className="wide">
                Climactiva API Key
                <input 
                  type="password" 
                  placeholder="ca_live_..." 
                  value={metaApiKey} 
                  onChange={(e) => setMetaApiKey(e.target.value)} 
                />
              </label>

              <label className="wide">
                Configuracion segura
                <input
                  type="text"
                  value="El token Meta y Phone Number ID se leen solo desde variables de entorno del backend."
                  readOnly
                />
              </label>

              <label>
                Nombre de Plantilla en Meta
                <input 
                  type="text" 
                  placeholder="Ej: presentacion_comercial" 
                  value={metaTemplateName} 
                  onChange={(e) => setMetaTemplateName(e.target.value)} 
                />
              </label>

              <label className="checkbox-field wide">
                <input
                  type="checkbox"
                  checked={allowWithoutOptIn}
                  onChange={(e) => setAllowWithoutOptIn(e.target.checked)}
                />
                Permitir envio a destinatarios sin consentimiento registrado
              </label>

              {allowWithoutOptIn ? (
                <label className="wide">
                  Motivo de excepcion administrativa
                  <input
                    type="text"
                    placeholder="Ej: autorizacion manual documentada por el administrador"
                    value={adminOverrideReason}
                    onChange={(e) => setAdminOverrideReason(e.target.value)}
                  />
                </label>
              ) : null}
            </div>

            <div className="meta-variables-list">
              <h4>Variables enviadas al template de Meta:</h4>
              <ul>
                <li><code>{"{{1}}"}</code>: Nombre de la empresa</li>
                <li><code>{"{{2}}"}</code>: Nombre del contacto (o "cliente")</li>
                <li><code>{"{{3}}"}</code>: Ciudad de la empresa (o "su zona")</li>
                <li><code>{"{{4}}"}</code>: Producto destacado (o vacío)</li>
                <li><code>{"{{5}}"}</code>: Llamado/beneficio, por ejemplo cuenta instalador con 7% de descuento</li>
              </ul>
            </div>

            {analytics.withoutOptIn > 0 ? (
              <div className="meta-warning-panel">
                <strong>Advertencia de consentimiento</strong>
                <p>
                  Hay {analytics.withoutOptIn} destinatarios sin consentimiento WhatsApp registrado. El backend bloqueara
                  esos envios salvo que actives la excepcion administrativa y dejes un motivo.
                </p>
              </div>
            ) : null}

            {sendingResults && (
              <div className="meta-log-panel">
                <strong>Resultados del envío:</strong><br />
                Enviados con éxito: {sendingResults.success}<br />
                Fallidos: {sendingResults.failed}<br />
                <hr style={{ borderColor: "#333", margin: "6px 0" }} />
                {sendingResults.log.map((line, i) => (
                  <div key={i}>{line}</div>
                ))}
              </div>
            )}

            <div className="meta-modal-actions">
              <button 
                type="button" 
                className="ghost-button" 
                onClick={() => {
                  setShowMetaModal(false);
                  setSendingResults(null);
                }}
                disabled={sendingCampaign}
              >
                Cerrar
              </button>
              <button 
                type="button" 
                className="primary-button" 
                onClick={executeMetaCampaign}
                disabled={sendingCampaign || !metaApiKey || !metaTemplateName || (allowWithoutOptIn && !adminOverrideReason.trim())}
                style={{ background: "#25D366", borderColor: "#25D366", color: "#ffffff" }}
              >
                {sendingCampaign ? "Enviando..." : "Iniciar Envío Masivo"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function mapCampaignTypeFromSupabase(type: string): CampaignType {
  if (type === "whatsapp") return "WhatsApp";
  if (type === "email") return "email";
  return "mixta";
}

function getCampaignRecipientIds(campaign: CampaignDraft, companies: Company[]) {
  if (campaign.recipientIds.length) return campaign.recipientIds;
  return getSegmentCompanies(companies, campaign.segment as CampaignSegment).map((company) => company.id);
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <article className="metric-card">
      <Megaphone size={22} />
      <span>{label}</span>
      <strong>{value}</strong>
      <p>Campana seleccionada</p>
    </article>
  );
}

function BarRow({ label, value, max }: { label: string; value: number; max: number }) {
  const width = max ? `${Math.max((value / max) * 100, value ? 8 : 0)}%` : "0%";
  return (
    <div className="bar-row">
      <div>
        <span>{label}</span>
        <strong>{max ? Math.round((value / max) * 100) : 0}%</strong>
      </div>
      <div className="bar-track">
        <span style={{ width }} />
      </div>
    </div>
  );
}
