import { FormEvent, useMemo, useState } from "react";
import { CheckCircle2, Eye, Megaphone, Plus, Send, UserMinus, UserPlus, XCircle } from "lucide-react";
import { demoCampaigns, demoTemplates } from "../../data/demoData";
import { useCompanyStore } from "../companies/CompanyStore";
import { useTemplateStore } from "../templates/TemplateStore";
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
  const { companies } = useCompanyStore();
  const { activeTemplates } = useTemplateStore();
  const templates = activeTemplates.length ? activeTemplates : demoTemplates;
  const [campaigns, setCampaigns] = useState<CampaignDraft[]>(loadCampaigns);
  const [recipients, setRecipients] = useState<RecipientState[]>(loadRecipients);
  const [selectedCampaignId, setSelectedCampaignId] = useState(campaigns[0]?.id ?? "");
  const [companyToAdd, setCompanyToAdd] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    name: "",
    type: "mixta" as CampaignType,
    segment: "distribuidores y tiendas" as CampaignSegment,
    templateId: templates[0].id,
    product: "bombas de condensado y herramientas Super Stars",
    coupon: "CLIMA10",
    sendAt: new Date().toISOString().slice(0, 10),
  });

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
        <button className="primary-button" type="button" onClick={() => setShowForm((current) => !current)}>
          <Plus size={18} />
          Nueva campana
        </button>
      </div>

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
              <div className="campaign-actions">
                <button className="ghost-button" type="button" onClick={confirmCampaign}>
                  <CheckCircle2 size={18} />
                  Confirmar lista
                </button>
                <button className="primary-button" type="button" onClick={markCampaignSent}>
                  <Send size={18} />
                  Marcar como enviada
                </button>
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
    </section>
  );
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
