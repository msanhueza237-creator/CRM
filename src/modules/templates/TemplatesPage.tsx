import { FormEvent, useMemo, useState } from "react";
import { Copy, Edit, FileText, Plus, Power, Save, X } from "lucide-react";
import { useTemplateStore } from "./TemplateStore";
import type { MessageTemplate } from "../../types/crm";

const variables = ["{{nombre_empresa}}", "{{nombre_contacto}}", "{{ciudad}}", "{{tipo_empresa}}", "{{beneficio}}", "{{cupon}}", "{{producto_destacado}}"];

const emptyTemplate: Omit<MessageTemplate, "id"> = {
  name: "",
  category: "Presentacion",
  body: "",
  active: true,
};

export function TemplatesPage() {
  const { createTemplate, duplicateTemplate, templates, toggleTemplate, updateTemplate } = useTemplateStore();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [query, setQuery] = useState("");
  const [form, setForm] = useState(emptyTemplate);

  const filteredTemplates = useMemo(() => {
    const normalizedQuery = query.toLowerCase().trim();
    if (!normalizedQuery) return templates;
    return templates.filter((template) =>
      [template.name, template.category, template.body].join(" ").toLowerCase().includes(normalizedQuery),
    );
  }, [query, templates]);

  function startCreate() {
    setEditingId(null);
    setForm(emptyTemplate);
    setShowForm(true);
  }

  function startEdit(template: MessageTemplate) {
    setEditingId(template.id);
    setForm({
      name: template.name,
      category: template.category,
      body: template.body,
      active: template.active ?? true,
    });
    setShowForm(true);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (editingId) {
      updateTemplate(editingId, form);
    } else {
      createTemplate(form);
    }
    setEditingId(null);
    setForm(emptyTemplate);
    setShowForm(false);
  }

  function insertVariable(token: string) {
    setForm((current) => ({
      ...current,
      body: `${current.body}${current.body ? " " : ""}${token}`,
    }));
  }

  return (
    <section className="page-stack">
      <div className="page-heading">
        <div>
          <p>Mensajes reutilizables</p>
          <h1>Plantillas</h1>
        </div>
        <button className="primary-button" type="button" onClick={startCreate}>
          <Plus size={18} />
          Nueva plantilla
        </button>
      </div>

      {showForm ? (
        <form className="panel template-form" onSubmit={handleSubmit}>
          <div className="panel-heading">
            <h2>{editingId ? "Editar plantilla" : "Crear plantilla"}</h2>
            <button className="ghost-button" type="button" onClick={() => setShowForm(false)}>
              <X size={16} />
              Cerrar
            </button>
          </div>

          <div className="form-grid">
            <label>
              Nombre
              <input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
            </label>
            <label>
              Categoria
              <input required value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })} />
            </label>
            <label>
              Estado
              <select value={form.active ? "activa" : "inactiva"} onChange={(event) => setForm({ ...form, active: event.target.value === "activa" })}>
                <option value="activa">activa</option>
                <option value="inactiva">inactiva</option>
              </select>
            </label>
            <label className="wide-field template-body-field">
              Mensaje
              <textarea required value={form.body} onChange={(event) => setForm({ ...form, body: event.target.value })} />
            </label>
          </div>

          <div className="template-variable-picker">
            {variables.map((token) => (
              <button className="mini-toggle" key={token} type="button" onClick={() => insertVariable(token)}>
                {token}
              </button>
            ))}
          </div>

          <div className="message-preview">
            <span>Vista previa con datos de ejemplo</span>
            <p>{renderPreview(form.body)}</p>
          </div>

          <div className="form-actions">
            <button className="ghost-button" type="button" onClick={() => setShowForm(false)}>Cancelar</button>
            <button className="primary-button" type="submit">
              <Save size={18} />
              Guardar plantilla
            </button>
          </div>
        </form>
      ) : null}

      <div className="filters-panel template-search">
        <label className="search-field">
          <FileText size={18} />
          <input placeholder="Buscar por nombre, categoria o texto" value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
      </div>

      <div className="template-grid">
        {filteredTemplates.map((template) => (
          <article className={`template-card ${template.active === false ? "inactive" : ""}`} key={template.id}>
            <div>
              <FileText size={22} />
              <span>{template.category}</span>
            </div>
            <h2>{template.name}</h2>
            <p>{template.body}</p>
            <div className="template-card-actions">
              <button className="ghost-button" type="button" onClick={() => startEdit(template)}>
                <Edit size={16} />
                Editar
              </button>
              <button className="ghost-button" type="button" onClick={() => duplicateTemplate(template.id)}>
                <Copy size={16} />
                Duplicar
              </button>
              <button className="ghost-button" type="button" onClick={() => toggleTemplate(template.id)}>
                <Power size={16} />
                {template.active === false ? "Activar" : "Desactivar"}
              </button>
            </div>
          </article>
        ))}
      </div>

      <div className="panel">
        <div className="panel-heading">
          <h2>Variables disponibles</h2>
        </div>
        <div className="tag-row">
          {variables.map((token) => (
            <span key={token}>{token}</span>
          ))}
        </div>
      </div>
    </section>
  );
}

function renderPreview(body: string) {
  return body
    .replace(/\{\{nombre_empresa\}\}/g, "Refrigera Express")
    .replace(/\{\{nombre_contacto\}\}/g, "Paula Morales")
    .replace(/\{\{ciudad\}\}/g, "Valparaiso")
    .replace(/\{\{tipo_empresa\}\}/g, "tienda comercial")
    .replace(/\{\{beneficio\}\}/g, "Inscribete en climactiva.cl y accede a un 7% de descuento especial por ser instalador.")
    .replace(/\{\{cupon\}\}/g, "Inscribete en climactiva.cl y accede a un 7% de descuento especial por ser instalador.")
    .replace(/\{\{producto_destacado\}\}/g, "bombas de condensado");
}
