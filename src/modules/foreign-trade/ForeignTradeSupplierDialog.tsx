import { FormEvent, useState } from "react";
import { AlertTriangle, Save, X } from "lucide-react";
import { upsertForeignTradeSupplier } from "../../lib/foreignTradeApi";
import type { ForeignTradeSupplier, UpsertForeignTradeSupplierInput } from "../../types/foreignTrade";

export function ForeignTradeSupplierDialog({
  supplier,
  onClose,
  onSaved,
}: {
  supplier?: ForeignTradeSupplier | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [form, setForm] = useState<UpsertForeignTradeSupplierInput>({
    id: supplier?.id,
    name: supplier?.name || "",
    companyName: supplier?.company_name || "",
    countryCode: supplier?.country_code || "CN",
    factoryCity: supplier?.factory_city || "",
    contactName: supplier?.contact_name || "",
    email: supplier?.email || "",
    whatsapp: supplier?.whatsapp || "",
    phone: supplier?.phone || "",
    currency: supplier?.currency || "USD",
    usualIncoterms: supplier?.usual_incoterms || [],
    paymentTerms: supplier?.payment_terms || "",
    defaultProductionDays: String(supplier?.default_production_days ?? 45),
    notes: supplier?.notes || "",
    active: supplier?.active ?? true,
  });
  const [incoterms, setIncoterms] = useState((supplier?.usual_incoterms || []).join(", "));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await upsertForeignTradeSupplier({
        ...form,
        usualIncoterms: incoterms.split(",").map((item) => item.trim().toUpperCase()).filter(Boolean),
      });
      await onSaved();
    } catch (submitError) {
      setError(submitError instanceof Error ? humanizeSupplierError(submitError.message) : "No se pudo guardar el proveedor.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="foreign-trade-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <form className="foreign-trade-operation-dialog" role="dialog" aria-modal="true" aria-labelledby="foreign-trade-supplier-title" onSubmit={submit}>
        <div className="foreign-trade-dialog-heading">
          <div><span>Ficha privada</span><h2 id="foreign-trade-supplier-title">{supplier ? "Editar proveedor" : "Nuevo proveedor"}</h2></div>
          <button className="icon-button" type="button" title="Cerrar" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="foreign-trade-form-grid">
          <label><span>Nombre corto</span><input autoFocus required maxLength={160} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
          <label><span>Razón social</span><input value={form.companyName} onChange={(event) => setForm({ ...form, companyName: event.target.value })} /></label>
          <label><span>País (ISO)</span><input required maxLength={2} value={form.countryCode} onChange={(event) => setForm({ ...form, countryCode: event.target.value.toUpperCase() })} placeholder="CN" /></label>
          <label><span>Ciudad de fábrica</span><input value={form.factoryCity} onChange={(event) => setForm({ ...form, factoryCity: event.target.value })} /></label>
          <label><span>Contacto</span><input value={form.contactName} onChange={(event) => setForm({ ...form, contactName: event.target.value })} /></label>
          <label><span>Email</span><input type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} /></label>
          <label><span>WhatsApp</span><input value={form.whatsapp} onChange={(event) => setForm({ ...form, whatsapp: event.target.value })} /></label>
          <label><span>Teléfono</span><input value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} /></label>
          <label><span>Moneda habitual</span><input required maxLength={3} value={form.currency} onChange={(event) => setForm({ ...form, currency: event.target.value.toUpperCase() })} /></label>
          <label><span>Producción habitual (días)</span><input required inputMode="numeric" value={form.defaultProductionDays} onChange={(event) => setForm({ ...form, defaultProductionDays: event.target.value })} /></label>
          <label className="wide-field"><span>Incoterms habituales, separados por coma</span><input value={incoterms} onChange={(event) => setIncoterms(event.target.value)} placeholder="EXW, FOB, CIF" /></label>
          <label className="wide-field"><span>Condiciones de pago</span><input value={form.paymentTerms} onChange={(event) => setForm({ ...form, paymentTerms: event.target.value })} /></label>
          <label className="wide-field"><span>Notas internas</span><textarea value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} /></label>
          <label className="foreign-trade-checkbox-field"><input type="checkbox" checked={form.active} onChange={(event) => setForm({ ...form, active: event.target.checked })} /><span>Proveedor activo</span></label>
        </div>
        {error ? <div className="notice-banner error"><AlertTriangle size={17} /> {error}</div> : null}
        <div className="foreign-trade-dialog-actions"><button className="ghost-button" type="button" onClick={onClose}>Cancelar</button><button className="primary-button" type="submit" disabled={busy}><Save size={17} /> {busy ? "Guardando..." : "Guardar proveedor"}</button></div>
      </form>
    </div>
  );
}

function humanizeSupplierError(message: string) {
  if (message.includes("foreign_trade_forbidden")) return "Tu usuario no tiene permiso para administrar proveedores.";
  if (message.includes("foreign_trade_invalid")) return "Revisa el nombre, país, moneda y días de producción.";
  return message;
}
