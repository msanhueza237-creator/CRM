import { FormEvent, useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { ArrowLeft, Edit, Mail, MessageCircle, Phone, Plus } from "lucide-react";
import { useCompanyStore } from "./CompanyStore";
import type { Interaction } from "../../types/crm";

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

export function CompanyDetailPage() {
  const { companyId } = useParams();
  const { createInteraction, getCompany, getCompanyInteractions } = useCompanyStore();
  const [showInteractionForm, setShowInteractionForm] = useState(false);
  const [interactionForm, setInteractionForm] = useState(emptyInteraction);
  const company = companyId ? getCompany(companyId) : undefined;

  if (!company) return <Navigate to="/empresas" replace />;

  const interactions = getCompanyInteractions(company.id);

  function updateInteractionField<K extends keyof typeof interactionForm>(field: K, value: (typeof interactionForm)[K]) {
    setInteractionForm((current) => ({ ...current, [field]: value }));
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

  return (
    <section className="page-stack">
      <div className="detail-actions">
        <Link to="/empresas" className="ghost-button"><ArrowLeft size={18} /> Volver</Link>
        <Link to={`/empresas/${company.id}/editar`} className="primary-button"><Edit size={18} /> Editar ficha</Link>
      </div>

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
                onChange={(event) => updateInteractionField("type", event.target.value as Interaction["type"])}
              >
                {interactionTypes.map((type) => <option key={type} value={type}>{type}</option>)}
              </select>
            </label>
            <label>
              Responsable
              <input value={interactionForm.owner} onChange={(event) => updateInteractionField("owner", event.target.value)} />
            </label>
            <label className="wide-field">
              Descripcion
              <textarea
                required
                value={interactionForm.description}
                onChange={(event) => updateInteractionField("description", event.target.value)}
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
            <div className="form-actions wide-field">
              <button className="ghost-button" type="button" onClick={() => setShowInteractionForm(false)}>Cancelar</button>
              <button className="primary-button" type="submit">Guardar interaccion</button>
            </div>
          </form>
        ) : null}

        <div className="timeline">
          {interactions.map((interaction) => (
            <article key={interaction.id}>
              <span>{interaction.date} - {interaction.type} - {interaction.owner}</span>
              <h3>{interaction.description}</h3>
              <p>{interaction.result}</p>
              <strong>{interaction.nextAction}</strong>
            </article>
          ))}
        </div>
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
