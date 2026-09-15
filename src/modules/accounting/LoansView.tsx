import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ArrowDownLeft, ArrowUpRight, Check, Landmark, LoaderCircle, Pencil, Plus, RefreshCw, Save, X } from "lucide-react";
import { getAccountingLoans, postAccountingLoan, previewAccountingLoan, saveAccountingLoan } from "../../lib/accountingApi";
import type { AccountingBootstrap } from "../../types/accounting";
import { loanFigures, type AccountingLoan, type LoanDraft, type LoanPosting, type LoanPreview } from "../../types/loans";
import "./loans.css";

const money = (value: number | null) => value == null ? "Por revisar" : value.toLocaleString("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 });
const day = (value: string | null | undefined) => value ? new Date(`${value}T12:00:00`).toLocaleDateString("es-CL") : "Por definir";
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santiago" }).format(new Date());
const labels: Record<string,string> = { draft: "Borrador", open: "Vigente", paid: "Capital devuelto", review: "Revisar asientos" };
const normalize = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

export function LoansView({ data, refresh }: { data: AccountingBootstrap; refresh: () => Promise<void> }) {
  const [loans, setLoans] = useState<AccountingLoan[]>([]), [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [busy, setBusy] = useState(false);
  const [query, setQuery] = useState(""), [status, setStatus] = useState("all");
  const [selected, setSelected] = useState("");
  const [draft, setDraft] = useState<LoanDraft | null>(null);
  const [action, setAction] = useState<LoanPosting | null>(null), [preview, setPreview] = useState<LoanPreview | null>(null);
  const generation = useRef(0);
  async function load() {
    const seq = ++generation.current;
    setLoading(true);
    try { const result = await getAccountingLoans(data.entity.id); if (seq === generation.current) { setLoans(result.loans); setUnavailable(false); setError(""); } }
    catch(e) { if (seq === generation.current) { setLoans([]); setUnavailable(true); setError(e instanceof Error ? e.message : "No se pudieron leer los préstamos."); } }
    finally { if (seq === generation.current) setLoading(false); }
  }
  useEffect(() => { void load(); return () => { generation.current++; }; }, [data]);
  const accounts = data.accounts.filter(a => a.active && a.allows_posting && a.currency === "CLP" && ["related_party_loan_payable", "loan_payable"].includes(a.classification));
  const rows = loans.filter(l => (!query || normalize(`${l.lender_name} ${l.lender_tax_id || ""} ${l.purpose} ${l.invoice_reference}`).includes(normalize(query))) && (status === "all" || loanFigures(l).status === status));
  const current = loans.find(l => l.id === selected);
  const figures = current ? loanFigures(current) : null;
  const all = loans.map(loanFigures), needsReview = all.some(f => f.status === "review");
  const transactions = data.bankTransactions.filter(t => current && ["unmatched", "proposed"].includes(t.reconciliation_status) && !t.metadata.classification_locked && !t.metadata.verified_classification && t.currency === "CLP"
    && (action?.kind === "received" ? Number(t.amount_clp) === Number(current.principal_clp) && t.transaction_date === current.received_on : Number(t.amount_clp) < 0 && t.transaction_date >= current.received_on));
  function startDraft(loan?: AccountingLoan) {
    setError(""); setNotice("");
    setDraft(loan ? { ...loan } : { id: crypto.randomUUID(), entity_id: data.entity.id, liability_account_id: accounts.find(a => a.classification === "loan_payable")?.id || accounts[0]?.id || "",
      lender_name: "", lender_tax_id: null, principal_clp: 0, received_on: today(), due_on: null, interest_terms: "unknown", terms_notes: "", purpose: "", invoice_reference: "" });
  }
  async function save(event: FormEvent) {
    event.preventDefault(); if (!draft || busy) return;
    setBusy(true); setError("");
    try { await saveAccountingLoan(draft); setSelected(draft.id); setDraft(null); setNotice("Borrador guardado. Aún no hay asiento ni movimiento de dinero."); await load(); }
    catch(e) { setError(e instanceof Error ? e.message : "No se pudo guardar el préstamo."); }
    finally { setBusy(false); }
  }
  async function process(confirm: boolean) {
    if (!action || busy) return;
    setBusy(true); setError("");
    try {
      if (!confirm) setPreview(await previewAccountingLoan(action));
      else {
        const result = await postAccountingLoan(action);
        setAction(null); setPreview(null); setNotice(result.existing ? "El movimiento ya estaba contabilizado; no se duplicó." : "Capital contabilizado y vinculado a cartola.");
        await load();
        try { await refresh(); } catch { setError("El asiento se guardó; falta actualizar el resto de Finanzas. No repitas el registro."); }
      }
    } catch(e) { setError(e instanceof Error ? e.message : "No se pudo procesar el asiento."); }
    finally { setBusy(false); }
  }
  return <section className="loans-view" aria-label="Préstamos recibidos">
    <header className="loan-heading"><div><h2><Landmark size={22} /> Préstamos recibidos</h2><p>Deudas con socios y terceros · capital en CLP</p></div><div className="loan-actions"><button className="ghost-button" type="button" disabled={loading} onClick={() => void load()} title="Actualizar préstamos" aria-label="Actualizar préstamos"><RefreshCw size={17}/></button><button className="primary-button" type="button" disabled={!accounts.length} onClick={() => startDraft()}><Plus size={17}/> Nuevo préstamo</button></div></header>
    {error && !draft && !action && <p className="notice-banner error" role="alert">{error}</p>}
    {notice && <p className="notice-banner success" role="status">{notice}</p>}
    {!accounts.length && <p className="notice-banner error">Falta una cuenta contable de préstamos CLP activa.</p>}
    <dl className="loan-totals"><div><dt>Capital recibido</dt><dd>{loading ? "…" : unavailable ? "No disponible" : money(all.reduce((n,f) => n+f.received,0))}</dd></div><div><dt>Capital devuelto</dt><dd>{loading ? "…" : unavailable ? "No disponible" : money(all.reduce((n,f) => n+f.repaid,0))}</dd></div><div><dt>Capital pendiente</dt><dd>{loading ? "…" : unavailable ? "No disponible" : money(needsReview ? null : all.reduce((n,f) => n+(f.balance || 0),0))}</dd></div></dl>
    <p className="loan-caption">Solo préstamos registrados en esta sección. Sin intereses ni saldos históricos no vinculados.</p>
    <div className="loan-filters"><label>Prestamista o destino<input type="search" value={query} onChange={e => setQuery(e.target.value)}/></label><label>Estado<select value={status} onChange={e => setStatus(e.target.value)}><option value="all">Todos</option>{Object.entries(labels).map(([key,label]) => <option key={key} value={key}>{label}</option>)}</select></label></div>
    {loading ? <p role="status"><LoaderCircle size={17} className="spin"/> Leyendo préstamos…</p> : !rows.length ? <p>No hay préstamos para estos filtros.</p> : <div className="loan-list">{rows.map(l => { const f=loanFigures(l); return <button key={l.id} type="button" className={selected===l.id ? "selected" : ""} onClick={() => setSelected(l.id)}><span><strong>{l.lender_name}</strong><small>{day(l.received_on)} · {labels[f.status]}</small></span><span><strong>{money(f.status === "draft" ? Number(l.principal_clp) : f.balance)}</strong><small>Vence {day(l.due_on)}</small></span><ArrowUpRight size={17}/></button>; })}</div>}
    {current && figures && <section className="loan-detail" aria-label="Detalle del préstamo"><header className="loan-heading"><div><h3>{current.lender_name}</h3><p>{labels[figures.status]} · {current.lender_tax_id || "Sin RUT registrado"}</p></div><div className="loan-actions">{figures.status === "draft" && <><button type="button" className="ghost-button" title="Editar borrador" aria-label="Editar borrador" onClick={() => startDraft(current)}><Pencil size={17}/></button><button type="button" className="primary-button" onClick={() => { setError(""); setAction({loanId:current.id,kind:"received",transactionId:""}); setPreview(null); }}><ArrowDownLeft size={17}/> Contabilizar ingreso</button></>}{figures.status === "open" && <button type="button" className="primary-button" onClick={() => { setError(""); setAction({loanId:current.id,kind:"repayment",transactionId:""}); setPreview(null); }}><ArrowUpRight size={17}/> Registrar abono de capital</button>}</div></header>
      <dl className="loan-facts"><div><dt>Principal acordado</dt><dd>{money(Number(current.principal_clp))}</dd></div><div><dt>Recepción</dt><dd>{day(current.received_on)}</dd></div><div><dt>Devolución acordada</dt><dd>{day(current.due_on)}</dd></div><div><dt>Intereses</dt><dd>{{unknown:"Por definir",none:"Sin intereses",agreed:"Según condiciones"}[current.interest_terms]}</dd></div><div><dt>Cuenta contable</dt><dd>{accounts.find(a => a.id === current.liability_account_id)?.name || "Revisar cuenta"}</dd></div><div><dt>Invoice de destino</dt><dd>{current.invoice_reference || "Sin referencia vinculada"}</dd></div></dl>
      {current.purpose && <p><strong>Destino:</strong> {current.purpose}</p>}{current.terms_notes && <p><strong>Condiciones:</strong> {current.terms_notes}</p>}
      <p className="loan-caption">La fecha de devolución no ejecuta pagos. La invoice y sus pagos se registran por separado.</p>
      {!!current.accounting_loan_movements.length && <div className="loan-table-scroll"><table><caption>Movimientos de capital</caption><thead><tr><th>Fecha</th><th>Movimiento</th><th>Monto CLP</th><th>Asiento</th><th>Estado</th></tr></thead><tbody>{current.accounting_loan_movements.map(m => <tr key={m.id}><td>{day(m.accounting_journal_entries?.entry_date)}</td><td>{m.kind === "received" ? "Préstamo recibido" : "Devolución de capital"}</td><td>{money(Number(m.amount_clp))}</td><td>{m.accounting_journal_entries?.entry_number || m.entry_id.slice(0,8)}</td><td>{m.accounting_journal_entries?.status === "posted" ? "Contabilizado" : "Revisar reversa"}</td></tr>)}</tbody></table></div>}
    </section>}
    {draft && <LoanDialog title="Registrar préstamo" busy={busy} close={() => setDraft(null)}><form onSubmit={save}><div className="accounting-form-grid"><label>Prestamista<input required minLength={3} maxLength={200} value={draft.lender_name} onChange={e => setDraft({...draft,lender_name:e.target.value})}/></label><label>RUT (opcional)<input maxLength={30} value={draft.lender_tax_id || ""} onChange={e => setDraft({...draft,lender_tax_id:e.target.value || null})}/></label><label>Capital CLP<input type="number" required min="1" max="999999999999" step="1" value={draft.principal_clp || ""} onChange={e => setDraft({...draft,principal_clp:Number(e.target.value)})}/></label><label>Fecha de recepción<input type="date" required value={draft.received_on} onChange={e => setDraft({...draft,received_on:e.target.value})}/></label><label>Devolución acordada<input type="date" min={draft.received_on} value={draft.due_on || ""} onChange={e => setDraft({...draft,due_on:e.target.value || null})}/></label><label>Intereses<select value={draft.interest_terms} onChange={e => setDraft({...draft,interest_terms:e.target.value as LoanDraft["interest_terms"]})}><option value="unknown">Por definir</option><option value="none">Sin intereses</option><option value="agreed">Con intereses acordados</option></select></label><label className="wide">Cuenta del préstamo<select required value={draft.liability_account_id} onChange={e => setDraft({...draft,liability_account_id:e.target.value})}>{accounts.map(a => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</select></label><label className="wide">Destino del dinero<textarea maxLength={1000} value={draft.purpose} onChange={e => setDraft({...draft,purpose:e.target.value})}/></label><label className="wide">Invoice de destino (referencia)<input maxLength={200} value={draft.invoice_reference} onChange={e => setDraft({...draft,invoice_reference:e.target.value})}/></label><label className="wide">Condiciones y respaldo<textarea required={draft.interest_terms === "agreed"} minLength={draft.interest_terms === "agreed" ? 5 : undefined} maxLength={1000} value={draft.terms_notes} onChange={e => setDraft({...draft,terms_notes:e.target.value})}/></label></div>{error && <p role="alert" className="notice-banner error">{error}</p>}<div className="loan-actions"><button type="button" className="ghost-button" disabled={busy} onClick={() => setDraft(null)}>Cancelar</button><button type="submit" disabled={busy} className="primary-button"><Save size={17}/> {busy ? "Guardando…" : "Guardar borrador"}</button></div></form></LoanDialog>}
    {action && current && <LoanDialog title={action.kind === "received" ? "Contabilizar préstamo recibido" : "Registrar abono de capital"} busy={busy} close={() => {setAction(null);setPreview(null);}}><p><strong>{current.lender_name}</strong> · Capital pendiente {money(figures?.balance || Number(current.principal_clp))}</p><label className="loan-transaction-label">Movimiento de cartola<select value={action.transactionId} disabled={busy} onChange={e => {setAction({...action,transactionId:e.target.value});setPreview(null);setError("");}}><option value="">Seleccionar movimiento</option>{transactions.map(t => <option key={t.id} value={t.id}>{day(t.transaction_date)} · {data.bankAccounts.find(b => b.id===t.bank_account_id)?.institution} · {money(Math.abs(Number(t.amount_clp)))} · {t.description}</option>)}</select></label>{!transactions.length && <p className="notice-banner">No hay movimientos compatibles sin clasificar. El préstamo queda en borrador hasta disponer de su cartola.</p>}<p className="loan-caption">Solo capital. No incluye intereses ni genera una transferencia bancaria.</p>
      {preview && <section className="loan-preview" aria-label="Vista previa del asiento">{preview.existing ? <p>Este movimiento ya está contabilizado.</p> : <><p>{day(preview.date || null)} · {preview.staged ? "Reclasificación de cuenta transitoria; banco ya contabilizado." : "Ingreso o egreso bancario aún no contabilizado."}</p><div className="loan-table-scroll"><table><thead><tr><th>Cuenta</th><th>Debe</th><th>Haber</th></tr></thead><tbody>{preview.lines?.map((line,i) => <tr key={i}><td>{data.accounts.find(a => a.id===line.account_id)?.name || line.account_id}</td><td>{money(Number(line.debit_clp))}</td><td>{money(Number(line.credit_clp))}</td></tr>)}</tbody></table></div><p>Capital pendiente después: <strong>{money(preview.balanceAfter ?? null)}</strong></p></>}</section>}
      {error && <p role="alert" className="notice-banner error">{error}</p>}<div className="loan-actions"><button type="button" className="ghost-button" disabled={busy} onClick={() => {setAction(null);setPreview(null);}}>Cancelar</button><button type="button" className="primary-button" disabled={busy || !action.transactionId} onClick={() => void process(!!preview)}><Check size={17}/> {busy ? "Procesando…" : preview ? "Confirmar asiento" : "Revisar asiento"}</button></div>
    </LoanDialog>}
  </section>;
}

function LoanDialog({ title, children, close, busy }: { title: string; children: ReactNode; close: () => void; busy: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog ref={ref} className="loan-dialog" aria-label={title} onCancel={e => {e.preventDefault();if(!busy)close();}}><header className="loan-heading"><h2>{title}</h2><button type="button" className="icon-button" disabled={busy} title="Cerrar" aria-label="Cerrar" onClick={close}><X size={18}/></button></header>{children}</dialog>;
}
