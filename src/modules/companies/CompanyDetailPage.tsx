import { FormEvent, useEffect, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Edit, Mail, MessageCircle, Phone, Plus, Trash2 } from "lucide-react";
import { isSupabaseConfigured, supabase } from "../../lib/supabase";
import { useCompanyStore } from "./CompanyStore";
import type { Interaction } from "../../types/crm";
import { useAuth } from "../auth/AuthContext";

const interactionTypes: Interaction["type"][] = ["Llamada", "Correo", "WhatsApp", "Reunion", "Cotizacion", "Nota"];
const today = new Date().toISOString().slice(0, 10);

const emptyInteraction: Omit<Interaction, "id" | "companyId"> = {
  date: today,
  type: "Llamada",
  owner: "Administrador",
  description: "",
  result: "",
  nextAction: "",
};

interface EmailMessageRow {
  id: string;
  campaign_id: string | null;
  to_email: string;
  subject: string;
  body_preview: string | null;
  status: string;
  sent_at: string | null;
  error_message: string | null;
  created_at: string;
}

export function CompanyDetailPage() {
  const { companyId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { createInteraction, deleteCompany, getCompany, getCompanyInteractions } = useCompanyStore();
  const [showInteractionForm, setShowInteractionForm] = useState(false);
  const [interactionForm, setInteractionForm] = useState(emptyInteraction);
  const [selectedChannel, setSelectedChannel] = useState<"Gmail" | "WhatsApp">("WhatsApp");
  const [selectedCatalog, setSelectedCatalog] = useState<string>("");
  const [customFileName, setCustomFileName] = useState<string>("");
  const [emailMessages, setEmailMessages] = useState<EmailMessageRow[]>([]);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  const company = companyId ? getCompany(companyId) : undefined;

  useEffect(() => {
    if (!companyId || !isSupabaseConfigured || !supabase) return;

    async function loadEmailMessages() {
      const { data, error } = await supabase!
        .from("email_messages")
        .select("id, campaign_id, to_email, subject, body_preview, status, sent_at, error_message, created_at")
        .eq("company_id", companyId)
        .order("created_at", { ascending: false })
        .limit(20);

      if (!error && data) setEmailMessages(data as EmailMessageRow[]);
    }

    void loadEmailMessages();
  }, [companyId]);

  if (!company) return <Navigate to="/empresas" replace />;

  const interactions = getCompanyInteractions(company.id);

  function updateInteractionField<K extends keyof typeof interactionForm>(field: K, value: (typeof interactionForm)[K]) {
    setInteractionForm((current) => ({ ...current, [field]: value }));
  }

  const catalogOptions = [
    { id: "", name: "Ninguno (Solo mensaje)", url: "", label: "Sin adjunto" },
    { id: "pdf", name: "Catálogo Clima Activa (PDF)", url: "https://climactiva.cl/catalogos/catalogo_general.pdf", label: "Catálogo PDF" },
    { id: "xlsx", name: "Lista de Precios 2026 (Excel)", url: "https://climactiva.cl/catalogos/lista_de_precios_2026.xlsx", label: "Lista Excel" },
    { id: "jpg", name: "Ofertas de Climatización (JPG)", url: "https://climactiva.cl/catalogos/ofertas_julio.jpg", label: "Ofertas JPG" },
    { id: "local", name: "Subir archivo local...", url: "", label: "Archivo Local" },
  ];

  const catalogObj = catalogOptions.find((c) => c.id === selectedCatalog);
  let attachmentText = "";
  if (catalogObj) {
    if (catalogObj.id === "local" && customFileName) {
      attachmentText = `\n\n[Archivo local adjunto: ${customFileName}]`;
    } else if (catalogObj.url) {
      attachmentText = `\n\nTe adjunto nuestro documento: ${catalogObj.name}\nDescargar aquí: ${catalogObj.url}`;
    }
  }
  const previewMessage = interactionForm.description + attachmentText;

  function handleSendRealContact() {
    if (!interactionForm.description.trim()) {
      alert("Por favor, escribe una descripción o mensaje antes de enviar.");
      return;
    }

    if (selectedChannel === "WhatsApp") {
      const cleanPhone = company!.whatsapp.replace(/\D/g, "");
      const whatsappUrl = `https://api.whatsapp.com/send?phone=${cleanPhone}&text=${encodeURIComponent(previewMessage)}`;
      window.open(whatsappUrl, "_blank");
      
      updateInteractionField("result", `Mensaje enviado por WhatsApp${catalogObj ? ` con ${catalogObj.label}` : ""}`);
      updateInteractionField("nextAction", "Hacer seguimiento por WhatsApp");
    } else {
      const subject = `Contacto Clima Activa - ${company!.name}`;
      const gmailUrl = `https://mail.google.com/mail/?view=cm&fs=1&to=${company!.email}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(previewMessage)}`;
      window.open(gmailUrl, "_blank");
      
      updateInteractionField("result", `Correo enviado por Gmail${catalogObj ? ` con ${catalogObj.label}` : ""}`);
      updateInteractionField("nextAction", "Esperar respuesta de correo");
    }
  }

  function handleInteractionSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    createInteraction({
      ...interactionForm,
      companyId: company!.id,
    });
    setInteractionForm(emptyInteraction);
    setShowInteractionForm(false);
  }

  async function handleDeleteCompany() {
    if (!company || !window.confirm(`¿Borrar definitivamente “${company.name}”? También se eliminarán sus interacciones asociadas.`)) return;
    setDeleting(true);
    setDeleteError("");
    try {
      await deleteCompany(company.id);
      navigate("/empresas", { replace: true });
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "No se pudo borrar la empresa.");
      setDeleting(false);
    }
  }

  return (
    <section className="page-stack">
      <div className="detail-actions">
        <Link to="/empresas" className="ghost-button"><ArrowLeft size={18} /> Volver</Link>
        {user?.role === "administrador" ? <button className="ghost-button danger" type="button" disabled={deleting} onClick={() => void handleDeleteCompany()}><Trash2 size={18} /> {deleting ? "Borrando..." : "Borrar empresa"}</button> : null}
        <Link to={`/empresas/${company.id}/editar`} className="primary-button"><Edit size={18} /> Editar ficha</Link>
      </div>
      {deleteError ? <p className="gmail-notice error">{deleteError}</p> : null}

      <div className="company-hero">
        <div>
          <p>{company.type} - {company.city}, {company.region}</p>
          <h1>{company.name}</h1>
          <div className="tag-row">
            <span className={`status-badge ${company.status}`}>{company.status}</span>
            <span className={`priority ${company.priority}`}>prioridad {company.priority}</span>
            {company.tags.map((tag) => <span key={tag}>{tag}</span>)}
          </div>
        </div>
        <div className="quick-actions">
          <a href={`tel:${company.phone}`} aria-label="Llamar"><Phone size={20} /></a>
          <a href={`mailto:${company.email}`} aria-label="Email"><Mail size={20} /></a>
          <a href={`https://wa.me/${company.whatsapp.replace(/\D/g, "")}`} aria-label="WhatsApp"><MessageCircle size={20} /></a>
        </div>
      </div>

      <div className="panel company-description">
        <div className="panel-heading">
          <h2>Descripcion de la empresa</h2>
        </div>
        <p>{company.description}</p>
      </div>

      <div className="detail-grid">
        <div className="panel">
          <div className="panel-heading">
            <h2>Datos comerciales</h2>
          </div>
          <dl className="definition-grid">
            <div><dt>Razon social</dt><dd>{company.legalName}</dd></div>
            <div><dt>RUT</dt><dd>{company.rut}</dd></div>
            <div><dt>Giro</dt><dd>{company.businessLine}</dd></div>
            <div><dt>Fuente</dt><dd>{company.source}</dd></div>
            <div><dt>Proximo seguimiento</dt><dd>{company.nextFollowUp}</dd></div>
            <div><dt>Direccion</dt><dd>{company.address}</dd></div>
          </dl>
        </div>

        <div className="panel">
          <div className="panel-heading">
            <h2>Contacto principal</h2>
          </div>
          <dl className="definition-grid">
            <div><dt>Nombre</dt><dd>{company.contactName}</dd></div>
            <div><dt>Cargo</dt><dd>{company.contactRole}</dd></div>
            <div><dt>Email</dt><dd>{company.email}</dd></div>
            <div><dt>WhatsApp</dt><dd>{company.whatsapp}</dd></div>
            <div><dt>Consentimiento WhatsApp</dt><dd>{company.whatsappOptIn ? "Autorizado" : "Sin consentimiento"}</dd></div>
            <div><dt>Estado WhatsApp</dt><dd>{company.whatsappStatus ?? "sin_consentimiento"}</dd></div>
            <div><dt>Telefono</dt><dd>{company.phone}</dd></div>
            <div><dt>Web</dt><dd>{company.website || "Sin registrar"}</dd></div>
          </dl>
        </div>
      </div>

      <div className="panel">
        <div className="panel-heading">
          <h2>Historial comercial</h2>
          <button className="ghost-button" type="button" onClick={() => setShowInteractionForm((current) => !current)}>
            <Plus size={16} />
            Registrar interaccion
          </button>
        </div>

        {showInteractionForm ? (
          <form className="interaction-form" onSubmit={handleInteractionSubmit}>
            <label>
              Fecha
              <input type="date" value={interactionForm.date} onChange={(event) => updateInteractionField("date", event.target.value)} />
            </label>
            <label>
              Tipo
              <select
                value={interactionForm.type}
                onChange={(event) => {
                  const newType = event.target.value as Interaction["type"];
                  updateInteractionField("type", newType);
                  if (newType === "WhatsApp") {
                    setSelectedChannel("WhatsApp");
                  } else if (newType === "Correo") {
                    setSelectedChannel("Gmail");
                  }
                }}
              >
                {interactionTypes.map((type) => <option key={type} value={type}>{type}</option>)}
              </select>
            </label>
            <label>
              Responsable
              <input value={interactionForm.owner} onChange={(event) => updateInteractionField("owner", event.target.value)} />
            </label>
            <label className="wide-field">
              Descripcion / Mensaje
              <textarea
                required
                value={interactionForm.description}
                onChange={(event) => updateInteractionField("description", event.target.value)}
                placeholder="Escribe el mensaje o descripción aquí..."
              />
            </label>
            <label>
              Resultado
              <input value={interactionForm.result} onChange={(event) => updateInteractionField("result", event.target.value)} />
            </label>
            <label>
              Proxima accion
              <input value={interactionForm.nextAction} onChange={(event) => updateInteractionField("nextAction", event.target.value)} />
            </label>

            {["WhatsApp", "Correo", "Cotizacion"].includes(interactionForm.type) && (
              <div className="real-contact-panel">
                <h3>Generar Contacto Real con Cliente</h3>
                
                <label>
                  Canal de envío
                  <select 
                    value={selectedChannel} 
                    onChange={(e) => setSelectedChannel(e.target.value as "Gmail" | "WhatsApp")}
                  >
                    <option value="WhatsApp">WhatsApp</option>
                    <option value="Gmail">Gmail</option>
                  </select>
                </label>

                <label>
                  Adjuntar Documento
                  <select 
                    value={selectedCatalog} 
                    onChange={(e) => {
                      setSelectedCatalog(e.target.value);
                      if (e.target.value !== "local") {
                        setCustomFileName("");
                      }
                    }}
                  >
                    {catalogOptions.map((opt) => (
                      <option key={opt.id} value={opt.id}>{opt.name}</option>
                    ))}
                  </select>
                </label>

                {selectedCatalog === "local" ? (
                  <label>
                    Seleccionar archivo local
                    <input 
                      type="file" 
                      onChange={(e) => {
                        if (e.target.files?.[0]) {
                          setCustomFileName(e.target.files[0].name);
                        }
                      }} 
                    />
                  </label>
                ) : (
                  <div></div>
                )}

                {selectedCatalog === "local" && (
                  <div className="file-note">
                    ⚠️ <strong>Nota sobre archivos locales:</strong> Por limitaciones del navegador, debes adjuntar el archivo manualmente en la ventana que se abrirá.
                  </div>
                )}

                <div className="wide-field" style={{ gridColumn: "span 3" }}>
                  <label>Vista previa del mensaje a enviar</label>
                  <div className="real-contact-preview">
                    {previewMessage || "(Escribe una descripción/mensaje arriba para ver la vista previa)"}
                  </div>
                </div>

                <div className="real-contact-actions wide-field" style={{ gridColumn: "span 3" }}>
                  <button 
                    type="button" 
                    className="primary-button" 
                    onClick={handleSendRealContact}
                    disabled={!interactionForm.description.trim()}
                  >
                    Enviar Mensaje Real ({selectedChannel})
                  </button>
                </div>
              </div>
            )}

            <div className="form-actions wide-field" style={{ gridColumn: "span 3" }}>
              <button className="ghost-button" type="button" onClick={() => setShowInteractionForm(false)}>Cancelar</button>
              <button className="primary-button" type="submit">Guardar interaccion</button>
            </div>
          </form>
        ) : null}

        <div className="timeline">
          {interactions.map((interaction) => (
            <article key={interaction.id}>
              <span>{interaction.date} - {interaction.type} - {interaction.owner}</span>
              <h3 style={{ whiteSpace: "pre-wrap" }}>{interaction.description}</h3>
              <p>{interaction.result}</p>
              <strong>{interaction.nextAction}</strong>
              {interaction.relatedUrl ? (
                <p>
                  <a href={interaction.relatedUrl} target="_blank" rel="noreferrer">
                    Abrir hilo en Gmail
                  </a>
                </p>
              ) : null}
            </article>
          ))}
        </div>
      </div>

      <div className="panel">
        <div className="panel-heading">
          <h2>Historial Gmail API</h2>
          <span>{emailMessages.length ? `${emailMessages.length} registros` : "Sin envios registrados"}</span>
        </div>
        {emailMessages.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Destinatario</th>
                  <th>Asunto</th>
                  <th>Estado</th>
                  <th>Error</th>
                </tr>
              </thead>
              <tbody>
                {emailMessages.map((message) => (
                  <tr key={message.id}>
                    <td>{(message.sent_at || message.created_at).slice(0, 10)}</td>
                    <td>{message.to_email}</td>
                    <td>
                      <strong>{message.subject}</strong>
                      <small>{message.campaign_id ? `Campana: ${message.campaign_id.slice(0, 8)}` : "Correo de prueba/manual"}</small>
                    </td>
                    <td><span className={`status-badge ${message.status === "sent" ? "enviada" : message.status === "failed" ? "descartado" : "programada"}`}>{message.status}</span></td>
                    <td>{message.error_message || "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">Cuando se envien correos por Gmail API, apareceran aqui con campana, asunto, destinatario, estado y error si falla.</p>
        )}
      </div>

      <div className="panel">
        <div className="panel-heading">
          <h2>Observaciones</h2>
        </div>
        <p className="muted">{company.notes}</p>
      </div>
    </section>
  );
}
