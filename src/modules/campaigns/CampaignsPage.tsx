import { FormEvent, useEffect, useMemo, useState } from "react";
import { CheckCircle2, Eye, Megaphone, Plus, Send, UserMinus, UserPlus, XCircle } from "lucide-react";
import { demoCampaigns, demoTemplates } from "../../data/demoData";
import { isSupabaseConfigured, supabase } from "../../lib/supabase";
import { useAuth } from "../auth/AuthContext";
import { useCompanyStore } from "../companies/CompanyStore";
import { useTemplateStore } from "../templates/TemplateStore";
import { getGmailStatus, sendGmailCampaign } from "../../lib/gmailApi";
import type { Campaign, CampaignStatus, CampaignType, Company, MessageTemplate } from "../../types/crm";

type CampaignSegment = "todas" | "prioridad alta" | "distribuidores y tiendas" | "instaladores" | "interesados";

interface CampaignDraft extends Campaign {
  templateId: string;
  product: string;
  coupon: string;
  recipientIds: string[];
}

interface RecipientState {
  campaignId: string;
  companyId: string;
  sent: boolean;
  replied: boolean;
  interested: boolean;
  discarded: boolean;
}

const CAMPAIGNS_STORAGE_KEY = "climactiva_campaigns";
const RECIPIENTS_STORAGE_KEY = "climactiva_campaign_recipients";
const segments: CampaignSegment[] = ["todas", "prioridad alta", "distribuidores y tiendas", "instaladores", "interesados"];
const campaignTypes: CampaignType[] = ["email", "WhatsApp", "mixta"];

function defaultCampaigns(): CampaignDraft[] {
  return demoCampaigns.map((campaign, index) => ({
    ...campaign,
    templateId: demoTemplates[index === 0 ? 1 : 2]?.id ?? demoTemplates[0].id,
    product: "bombas de condensado y herramientas Super Stars",
    coupon: "CLIMA10",
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

function renderMessage(template: MessageTemplate, company: Company, campaign: CampaignDraft) {
  return template.body
    .replace(/\{\{nombre_empresa\}\}/g, company.name)
    .replace(/\{\{nombre_contacto\}\}/g, company.contactName || "equipo comercial")
    .replace(/\{\{ciudad\}\}/g, company.city || "su zona")
    .replace(/\{\{tipo_empresa\}\}/g, company.type)
    .replace(/\{\{cupon\}\}/g, campaign.coupon)
    .replace(/\{\{producto_destacado\}\}/g, campaign.product);
}

export function CampaignsPage() {
  const { user } = useAuth();
  const { companies } = useCompanyStore();
  const { activeTemplates } = useTemplateStore();
  const templates = activeTemplates.length ? activeTemplates : demoTemplates;
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
  const [form, setForm] = useState({
    name: "",
    type: "mixta" as CampaignType,
    segment: "distribuidores y tiendas" as CampaignSegment,
    templateId: templates[0].id,
    product: "bombas de condensado y herramientas Super Stars",
    coupon: "CLIMA10",
    sendAt: new Date().toISOString().slice(0, 10),
  });

  // Smart suggestions state variables
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedProposalIndex, setSelectedProposalIndex] = useState(0);
  const [proposalForm, setProposalForm] = useState({
    name: "",
    type: "mixta" as CampaignType,
    product: "bombas de condensado y herramientas Super Stars",
    coupon: "CLIMA10",
    subject: "",
    message: "",
  });
  const [excludedCompanyIds, setExcludedCompanyIds] = useState<string[]>([]);
  const [proposalSuccessMessage, setProposalSuccessMessage] = useState<string | null>(null);
  const [savingProposal, setSavingProposal] = useState(false);

  // Memoized smart proposals based on real company database contents
  const proposals = useMemo(() => {
    const vipCompanies = companies.filter(
      (c) => c.priority === "alta" && (c.type === "distribuidor" || c.type === "tienda comercial")
    );
    const techCompanies = companies.filter((c) => c.type === "tecnico" || c.type === "instalador grande");
    const leadCompanies = companies.filter(
      (c) => c.status === "prospecto" || c.status === "contactado" || c.status === "cotizado"
    );

    return [
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
  }, [companies]);

  // Synchronize forms when changing target proposal template
  useEffect(() => {
    const prop = proposals[selectedProposalIndex];
    if (prop) {
      setProposalForm({
        name: prop.defaultName,
        type: prop.type,
        product: prop.product,
        coupon: prop.coupon,
        subject: prop.subject,
        message: prop.defaultMessage,
      });
      setExcludedCompanyIds([]);
      setProposalSuccessMessage(null);
    }
  }, [selectedProposalIndex, proposals]);

  function renderProposalPreview(templateText: string, company: Company) {
    if (!company) return "No hay empresas seleccionadas.";
    return templateText
      .replace(/\{\{nombre_empresa\}\}/g, company.name)
      .replace(/\{\{nombre_contacto\}\}/g, company.contactName || "equipo comercial")
      .replace(/\{\{ciudad\}\}/g, company.city || "su zona")
      .replace(/\{\{tipo_empresa\}\}/g, company.type)
      .replace(/\{\{cupon\}\}/g, proposalForm.coupon)
      .replace(/\{\{producto_destacado\}\}/g, proposalForm.product);
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
      coupon: proposalForm.coupon,
      recipientIds: targetCompanies.map((c) => c.id),
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
            rendered_message: proposalForm.message
              .replace(/\{\{nombre_empresa\}\}/g, c.name)
              .replace(/\{\{nombre_contacto\}\}/g, c.contactName || "equipo comercial")
              .replace(/\{\{ciudad\}\}/g, c.city || "su zona")
              .replace(/\{\{tipo_empresa\}\}/g, c.type)
              .replace(/\{\{cupon\}\}/g, newCampaign.coupon)
              .replace(/\{\{producto_destacado\}\}/g, newCampaign.product),
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
      const [{ data: campaignsData, error: campaignsError }, { data: recipientsData, error: recipientsError }] =
        await Promise.all([
          supabase!.from("campaigns").select("*").order("created_at", { ascending: false }),
          supabase!.from("campaign_recipients").select("*"),
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

        const campaignsWithRecipients = mappedCampaigns.map((campaign) => {
          const campaignRows = mappedRecipients.filter((recipient) => recipient.campaignId === campaign.id);
          return {
            ...campaign,
            recipientIds: campaignRows.map((recipient) => recipient.companyId),
            recipients: campaignRows.length,
            sent: campaignRows.filter((recipient) => recipient.sent).length,
            replied: campaignRows.filter((recipient) => recipient.replied).length,
            interested: campaignRows.filter((recipient) => recipient.interested).length,
            discarded: campaignRows.filter((recipient) => recipient.discarded).length,
          };
        });

        setCampaigns(campaignsWithRecipients);
        saveCampaigns(campaignsWithRecipients);
        setRecipients(mappedRecipients);
        saveRecipients(mappedRecipients);
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

  function persistCampaigns(nextCampaigns: CampaignDraft[]) {
    setCampaigns(nextCampaigns);
    saveCampaigns(nextCampaigns);
  }

  function persistRecipients(nextRecipients: RecipientState[]) {
    setRecipients(nextRecipients);
    saveRecipients(nextRecipients);
  }

  function createCampaign(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const targetCompanies = getSegmentCompanies(companies, form.segment);
    const created: CampaignDraft = {
      id: `cam-${crypto.randomUUID()}`,
      name: form.name,
      type: form.type,
      segment: form.segment,
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
      coupon: form.coupon,
      recipientIds: targetCompanies.map((company) => company.id),
    };
    persistCampaigns([created, ...campaigns]);
    setSelectedCampaignId(created.id);
    setShowForm(false);
    setForm((current) => ({ ...current, name: "" }));
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

  async function executeMetaCampaign() {
    if (!selectedCampaign || !isSupabaseConfigured || !supabase) return;
    setSendingCampaign(true);
    setSendingResults(null);

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
          selectedCampaign.coupon || ""
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

    const emailRecipients = selectedCompanies
      .filter((company) => company.email)
      .map((company) => ({
        companyId: company.id,
        toEmail: company.email,
        variables: {
          nombre_empresa: company.name,
          nombre_contacto: company.contactName || "equipo comercial",
          ciudad: company.city || "su zona",
          tipo_empresa: company.type,
          producto_destacado: selectedCampaign.product || "",
          cupon: selectedCampaign.coupon || "",
        },
      }));

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
          segment: selectedCampaign.segment,
          type: selectedCampaign.type,
          product: selectedCampaign.product,
          coupon: selectedCampaign.coupon,
        },
        recipients: emailRecipients,
      });

      setSendingResults({
        success: Number(data.sent || 0),
        failed: Number(data.failed || 0),
        log: Array.isArray(data.log) ? data.log : [],
      });

      if (Number(data.sent || 0) > 0) {
        markCampaignSent();
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
                    <input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
                  </label>
                  <label>
                    Tipo
                    <select value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value as CampaignType })}>
                      {campaignTypes.map((type) => <option key={type} value={type}>{type}</option>)}
                    </select>
                  </label>
                  <label>
                    Segmento
                    <select value={form.segment} onChange={(event) => setForm({ ...form, segment: event.target.value as CampaignSegment })}>
                      {segments.map((segment) => <option key={segment} value={segment}>{segment}</option>)}
                    </select>
                  </label>
                  <label>
                    Fecha de envio
                    <input type="date" value={form.sendAt} onChange={(event) => setForm({ ...form, sendAt: event.target.value })} />
                  </label>
                  <label>
                    Plantilla
                    <select value={form.templateId} onChange={(event) => setForm({ ...form, templateId: event.target.value })}>
                      {templates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}
                    </select>
                  </label>
                  <label>
                    Producto destacado
                    <input value={form.product} onChange={(event) => setForm({ ...form, product: event.target.value })} />
                  </label>
                  <label>
                    Cupon
                    <input value={form.coupon} onChange={(event) => setForm({ ...form, coupon: event.target.value })} />
                  </label>
                </div>
              </div>
              <div className="form-actions">
                <button className="ghost-button" type="button" onClick={() => setShowForm(false)}>Cancelar</button>
                <button className="primary-button" type="submit">Crear y revisar</button>
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
            <div style={{ marginBottom: "20px" }}>
              <h2 style={{ color: "#103842", margin: 0 }}>💡 Propuestas de Campañas Sugeridas</h2>
              <p className="muted" style={{ fontSize: "14px", marginTop: "6px" }}>
                El CRM ha analizado tu base de datos de empresas y propone las siguientes campañas segmentadas. Revisa, edita los mensajes y desmarca a los clientes que prefieras excluir.
              </p>
            </div>

            <div className="two-column" style={{ display: "grid", gridTemplateColumns: "1fr 1.5fr", gap: "24px" }}>
              {/* Columna Izquierda: Listado de propuestas */}
              <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
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
                        <span style={{ fontSize: "12px", fontWeight: "bold", color: "#62717a" }}>
                          👥 {prop.potentialCompanies.length} potenciales
                        </span>
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

                      <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontWeight: "bold", fontSize: "14px", color: "#40515b" }}>
                        Cupón Promocional
                        <input 
                          type="text" 
                          value={proposalForm.coupon} 
                          onChange={(e) => setProposalForm({ ...proposalForm, coupon: e.target.value })} 
                          style={{ minHeight: "40px", border: "1px solid #cfdade", borderRadius: "8px", padding: "0 12px" }}
                        />
                      </label>
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
                <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "200px" }}>
                  <p className="muted">Selecciona una propuesta sugerida para ver su edición.</p>
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
                <li><code>{"{{5}}"}</code>: Cupón de descuento (o vacío)</li>
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
