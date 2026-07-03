import { FormEvent, useMemo, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Save } from "lucide-react";
import { useCompanyStore } from "./CompanyStore";
import type { Company, CompanyStatus, CompanyType, Priority } from "../../types/crm";

const companyTypes: CompanyType[] = ["distribuidor", "tienda comercial", "tecnico", "instalador grande", "competencia", "otro"];
const statuses: CompanyStatus[] = ["prospecto", "contactado", "interesado", "cotizado", "cliente", "descartado"];
const priorities: Priority[] = ["alta", "media", "baja"];

const emptyCompany: Omit<Company, "id"> = {
  name: "",
  legalName: "",
  description: "",
  rut: "",
  businessLine: "",
  type: "distribuidor",
  city: "",
  region: "",
  address: "",
  website: "",
  instagram: "",
  facebook: "",
  whatsapp: "",
  phone: "",
  email: "",
  contactName: "",
  contactRole: "",
  priority: "media",
  source: "",
  notes: "",
  status: "prospecto",
  nextFollowUp: "",
  tags: [],
};

export function CompanyFormPage() {
  const { companyId } = useParams();
  const navigate = useNavigate();
  const { createCompany, getCompany, updateCompany } = useCompanyStore();
  const existingCompany = companyId ? getCompany(companyId) : undefined;
  const isEditing = Boolean(companyId);
  const initialValues = useMemo(
    () => (existingCompany ? { ...existingCompany, tags: existingCompany.tags.join(", ") } : { ...emptyCompany, tags: "" }),
    [existingCompany],
  );
  const [form, setForm] = useState(initialValues);

  if (isEditing && !existingCompany) return <Navigate to="/empresas" replace />;

  function updateField<K extends keyof typeof form>(field: K, value: (typeof form)[K]) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const payload: Omit<Company, "id"> = {
      ...form,
      tags: form.tags.split(",").map((tag) => tag.trim()).filter(Boolean),
    };
    const savedCompany = companyId ? updateCompany(companyId, payload) : createCompany(payload);
    navigate(`/empresas/${savedCompany.id}`);
  }

  return (
    <section className="page-stack">
      <div className="detail-actions">
        <Link to={companyId ? `/empresas/${companyId}` : "/empresas"} className="ghost-button">
          <ArrowLeft size={18} />
          Volver
        </Link>
      </div>

      <div className="page-heading">
        <div>
          <p>{isEditing ? "Editar ficha" : "Nueva empresa"}</p>
          <h1>{isEditing ? existingCompany?.name : "Crear empresa"}</h1>
        </div>
      </div>

      <form className="panel company-form" onSubmit={handleSubmit}>
        <FormSection title="Datos de empresa">
          <TextField label="Nombre empresa" value={form.name} onChange={(value) => updateField("name", value)} required />
          <TextField label="Razon social" value={form.legalName} onChange={(value) => updateField("legalName", value)} />
          <TextField label="RUT" value={form.rut} onChange={(value) => updateField("rut", value)} />
          <TextField label="Giro" value={form.businessLine} onChange={(value) => updateField("businessLine", value)} />
          <SelectField label="Tipo" value={form.type} options={companyTypes} onChange={(value) => updateField("type", value)} />
          <SelectField label="Estado" value={form.status} options={statuses} onChange={(value) => updateField("status", value)} />
          <SelectField label="Prioridad" value={form.priority} options={priorities} onChange={(value) => updateField("priority", value)} />
          <TextField label="Proximo seguimiento" type="date" value={form.nextFollowUp} onChange={(value) => updateField("nextFollowUp", value)} />
          <TextArea label="Descripcion breve" value={form.description} onChange={(value) => updateField("description", value)} />
          <TextArea label="Observaciones" value={form.notes} onChange={(value) => updateField("notes", value)} />
        </FormSection>

        <FormSection title="Ubicacion y canales">
          <TextField label="Ciudad" value={form.city} onChange={(value) => updateField("city", value)} />
          <TextField label="Region" value={form.region} onChange={(value) => updateField("region", value)} />
          <TextField label="Direccion" value={form.address} onChange={(value) => updateField("address", value)} />
          <TextField label="Sitio web" value={form.website} onChange={(value) => updateField("website", value)} />
          <TextField label="Instagram" value={form.instagram} onChange={(value) => updateField("instagram", value)} />
          <TextField label="Facebook" value={form.facebook} onChange={(value) => updateField("facebook", value)} />
          <TextField label="WhatsApp" value={form.whatsapp} onChange={(value) => updateField("whatsapp", value)} />
          <TextField label="Telefono" value={form.phone} onChange={(value) => updateField("phone", value)} />
        </FormSection>

        <FormSection title="Contacto comercial">
          <TextField label="Email" type="email" value={form.email} onChange={(value) => updateField("email", value)} />
          <TextField label="Persona de contacto" value={form.contactName} onChange={(value) => updateField("contactName", value)} />
          <TextField label="Cargo del contacto" value={form.contactRole} onChange={(value) => updateField("contactRole", value)} />
          <TextField label="Fuente del dato" value={form.source} onChange={(value) => updateField("source", value)} />
          <TextField label="Etiquetas separadas por coma" value={form.tags} onChange={(value) => updateField("tags", value)} />
        </FormSection>

        <div className="form-actions">
          <Link to="/empresas" className="ghost-button">Cancelar</Link>
          <button className="primary-button" type="submit">
            <Save size={18} />
            Guardar empresa
          </button>
        </div>
      </form>
    </section>
  );
}

function FormSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="form-section">
      <h2>{title}</h2>
      <div className="form-grid">{children}</div>
    </div>
  );
}

function TextField({
  label,
  value,
  onChange,
  required,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  type?: string;
}) {
  return (
    <label>
      {label}
      <input type={type} value={value} required={required} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function TextArea({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="wide-field">
      {label}
      <textarea value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: T[];
  onChange: (value: T) => void;
}) {
  return (
    <label>
      {label}
      <select value={value} onChange={(event) => onChange(event.target.value as T)}>
        {options.map((option) => (
          <option key={option} value={option}>{option}</option>
        ))}
      </select>
    </label>
  );
}
