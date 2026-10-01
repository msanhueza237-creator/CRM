import { useState } from "react";
import { Check, RefreshCw, X } from "lucide-react";
import { customerClassification, type CustomerClassificationPreview } from "../../lib/copilotCentralApi";
import { useAuth } from "../auth/AuthContext";
import { useCompanyStore } from "./CompanyStore";
import "./company-insights.css";

export function CustomerClassification() {
  const { user } = useAuth(), { refreshCompanies } = useCompanyStore();
  const [preview, setPreview] = useState<CustomerClassificationPreview>();
  const [includeNew, setIncludeNew] = useState(false);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  if (user?.role !== "administrador") return null;
  async function review() {
    setBusy(true); setMessage(""); setPreview(undefined); setIncludeNew(false);
    try { setPreview(await customerClassification() as CustomerClassificationPreview); }
    catch (e) { setMessage(e instanceof Error ? e.message : "No se pudo revisar el historial."); }
    finally { setBusy(false); }
  }
  async function confirm() {
    if (!preview) return;
    setBusy(true); setMessage("");
    try {
      const result = await customerClassification(preview, includeNew);
      if ("applied" in result) { setMessage(`${result.applied.length} clientes incorporados o clasificados, incluyendo ${result.created.length} fichas nuevas. ${result.conflicts.length} cambios concurrentes pendientes de revisar.`); setPreview(undefined); refreshCompanies(); }
    } catch (e) { setPreview(undefined); setMessage(e instanceof Error ? e.message : "No se pudo confirmar. Revisa el estado antes de reintentar."); }
    finally { setBusy(false); }
  }
  const pending = preview?.plan.filter(p=>p.action==="classify" || (includeNew && p.action==="create")) || [];
  const newCompanies = preview?.plan.filter(p=>p.action==="create") || [];
  const exceptions = preview?.plan.filter(p=>["ambiguous","unlinked"].includes(p.action)) || [];
  return <section className="customer-classification" aria-label="Clasificacion de clientes facturados">
    <button type="button" className="ghost-button" disabled={busy} onClick={()=>void review()}><RefreshCw size={17}/>{busy ? "Revisando…" : "Revisar clientes con facturas"}</button>
    {!!message && <p role="status">{message}</p>}
    {preview && <div>
      <h2>Clientes con historial de facturas</h2>
      <p>{pending.length} empresas por clasificar · {preview.plan.filter(p=>p.action==="unchanged").length} ya son clientes · {exceptions.length} identidades por revisar.</p>
      <p className="company-insight-note">Solo cambia el estado a cliente. Se conservan categoría, contactos, consentimientos y contabilidad.</p>
      {!!newCompanies.length && <label><input type="checkbox" checked={includeNew} onChange={e=>setIncludeNew(e.target.checked)} disabled={busy}/> Incorporar {newCompanies.length} fichas nuevas con razón social y RUT verificado, sin contactos ni consentimiento de envío.</label>}
      <div className="table-wrap"><table><thead><tr><th>Empresa</th><th>RUT</th><th>Estado actual</th><th>Facturas</th></tr></thead><tbody>{pending.map(p=><tr key={p.taxId}><td>{p.companyName}</td><td>{p.taxId}</td><td>{p.action==="create" ? "Nueva ficha" : p.previousStatus}</td><td>{p.documents.length}</td></tr>)}</tbody></table></div>
      {!!exceptions.length && <details><summary>Identidades pendientes</summary><ul>{exceptions.map(p=><li key={p.taxId}>{p.companyName} · {p.taxId}: {p.action==="ambiguous" ? "Conflicto de RUT o nombre con otra ficha" : "Sin identidad suficiente para crear o vincular ficha"}</li>)}</ul></details>}
      <div className="form-actions"><button type="button" className="ghost-button" disabled={busy} onClick={()=>setPreview(undefined)}><X size={17}/>Cerrar</button>
        <button type="button" className="primary-button" disabled={busy || !pending.length} onClick={()=>void confirm()}><Check size={17}/>Confirmar {pending.length} clientes</button></div>
    </div>}
  </section>;
}
