import { FormEvent, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  AlertTriangle,
  BadgeDollarSign,
  BookOpenCheck,
  CheckCircle2,
  CircleDollarSign,
  ClipboardCheck,
  Download,
  FileCheck2,
  FileSpreadsheet,
  Landmark,
  LayoutDashboard,
  LoaderCircle,
  LockKeyhole,
  Plus,
  ReceiptText,
  RefreshCw,
  Scale,
  Search,
  ShieldCheck,
  Upload,
  X,
} from "lucide-react";
import {
  closeAccountingPeriod,
  confirmAccountingImport,
  confirmAccountingReconciliation,
  createAccountingAccount,
  createAccountingCheck,
  createAccountingEntry,
  exportAccountingExcel,
  exportAccountingPdf,
  getAccountingReport,
  postAccountingEntry,
  previewAccountingImport,
  proposeAccountingReconciliation,
  refreshAccountingControls,
  reverseAccountingEntry,
  syncAccountingFacto,
  syncAccountingForeignTrade,
  uploadAccountingEvidence,
} from "../../lib/accountingApi";
import type {
  AccountingAccount,
  AccountingBankTransaction,
  AccountingBootstrap,
  AccountingImportPreview,
  AccountingJournalDraft,
  AccountingJournalEntry,
  AccountingPayable,
  AccountingReceivable,
  AccountingReconciliationCandidate,
  AccountingReport,
  AccountingView,
} from "../../types/accounting";
import { useAuth } from "../auth/AuthContext";
import { useAccountingCenter } from "./useAccountingCenter";
import "./accountingCenter.css";

const views: Array<{ id: AccountingView; label: string; icon: typeof Landmark }> = [
  { id: "dashboard", label: "Resumen", icon: LayoutDashboard },
  { id: "accounts", label: "Plan de cuentas", icon: BookOpenCheck },
  { id: "ledger", label: "Contabilidad", icon: Scale },
  { id: "facto", label: "Fuentes", icon: RefreshCw },
  { id: "banks", label: "Bancos", icon: Landmark },
  { id: "reconcile", label: "Conciliación", icon: ClipboardCheck },
  { id: "receivables", label: "Por cobrar", icon: CircleDollarSign },
  { id: "payables", label: "Por pagar", icon: ReceiptText },
  { id: "checks", label: "Cheques", icon: FileCheck2 },
  { id: "periods", label: "Períodos", icon: LockKeyhole },
  { id: "reports", label: "Informes", icon: FileSpreadsheet },
  { id: "controls", label: "Control", icon: ShieldCheck },
];

export function AccountingCenterPage() {
  const { data, error, loading, refresh } = useAccountingCenter();
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const requested = params.get("view") as AccountingView | null;
  const activeView = views.some((view) => view.id === requested) ? requested! : "dashboard";
  const [notice, setNotice] = useState("");
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState("");

  function navigate(view: AccountingView) {
    setParams({ view });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function runAction(key: string, action: () => Promise<unknown>, success: string) {
    setBusy(key);
    setNotice("");
    setActionError("");
    try {
      await action();
      setNotice(success);
      await refresh();
      return true;
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : "No se pudo completar la operación.");
      return false;
    } finally {
      setBusy("");
    }
  }

  return (
    <section className="page-stack accounting-center-page">
      <div className="page-heading accounting-heading">
        <div>
          <p>Información privada de administración y finanzas</p>
          <h1>Finanzas y Contabilidad</h1>
          <span>Contabilidad de doble partida, bancos, cobranza e informes auditables.</span>
        </div>
        <div className="accounting-heading-actions">
          <span className="accounting-private-badge"><LockKeyhole size={15} /> Solo personal autorizado</span>
          <button className="ghost-button" type="button" disabled={loading} onClick={() => void refresh()}>
            <RefreshCw className={loading ? "spin" : ""} size={17} /> Actualizar
          </button>
        </div>
      </div>

      <section className="accounting-principle-band">
        <ShieldCheck size={24} />
        <div><strong>Trazabilidad financiera activa</strong><span>Factura, pago, movimiento bancario, conciliación y asiento se mantienen separados y relacionados. Facto opera en modo solo lectura.</span></div>
      </section>

      <nav className="content-module-tabs accounting-tabs" aria-label="Secciones financieras">
        {views.map((view) => (
          <button key={view.id} className={activeView === view.id ? "active" : ""} type="button" onClick={() => navigate(view.id)}>
            <view.icon size={17} /><span>{view.label}</span>
          </button>
        ))}
      </nav>

      {error ? <div className="notice-banner error"><AlertTriangle size={18} /> {error}</div> : null}
      {actionError ? <div className="notice-banner error"><AlertTriangle size={18} /> {actionError}</div> : null}
      {notice ? <div className="notice-banner success"><CheckCircle2 size={18} /> {notice}</div> : null}
      {loading && !data ? <div className="panel accounting-loading"><LoaderCircle className="spin" /><strong>Consolidando información financiera</strong><span>Validando permisos, períodos y fuentes.</span></div> : null}

      {data ? (
        <>
          {activeView === "dashboard" ? <DashboardView data={data} navigate={navigate} /> : null}
          {activeView === "accounts" ? <AccountsView data={data} busy={busy} runAction={runAction} /> : null}
          {activeView === "ledger" ? <LedgerView data={data} busy={busy} runAction={runAction} /> : null}
          {activeView === "facto" ? <FactoView data={data} busy={busy} runAction={runAction} /> : null}
          {activeView === "banks" ? <BankImportView data={data} busy={busy} runAction={runAction} /> : null}
          {activeView === "reconcile" ? <ReconciliationView data={data} busy={busy} runAction={runAction} /> : null}
          {activeView === "receivables" ? <ReceivablesView rows={data.receivables} /> : null}
          {activeView === "payables" ? <PayablesView rows={data.payables} /> : null}
          {activeView === "checks" ? <ChecksView data={data} busy={busy} runAction={runAction} /> : null}
          {activeView === "periods" ? <PeriodsView data={data} isAdmin={user?.role === "administrador"} busy={busy} runAction={runAction} /> : null}
          {activeView === "reports" ? <ReportsView data={data} /> : null}
          {activeView === "controls" ? <ControlsView data={data} busy={busy} runAction={runAction} /> : null}
        </>
      ) : null}
    </section>
  );
}

function DashboardView({ data, navigate }: { data: AccountingBootstrap; navigate: (view: AccountingView) => void }) {
  const summary = data.summary;
  const available = number(summary.bank_clp) + number(summary.bank_usd_clp);
  const position = available + number(summary.receivables) + number(summary.checks_portfolio) - number(summary.payables);
  const cards: Array<{ label: string; value: string; detail: string; view: AccountingView; tone?: string }> = [
    { label: "Disponible CLP", value: clp(summary.bank_clp), detail: "Caja, bancos y Mercado Pago contabilizados", view: "banks" },
    { label: "Banco USD", value: clp(summary.bank_usd_clp), detail: "Equivalente CLP, conserva moneda original", view: "banks" },
    { label: "Por cobrar", value: clp(summary.receivables), detail: `${clp(summary.receivables_overdue)} vencido`, view: "receivables", tone: summary.receivables_overdue ? "warning" : "" },
    { label: "Por pagar", value: clp(summary.payables), detail: `${clp(summary.payables_overdue)} vencido`, view: "payables", tone: summary.payables_overdue ? "warning" : "" },
    { label: "Cheques en cartera", value: clp(summary.checks_portfolio), detail: "No se consideran banco disponible", view: "checks" },
    { label: "Posición financiera", value: clp(position), detail: "Disponible + por cobrar + cheques - por pagar", view: "reports", tone: position < 0 ? "danger" : "positive" },
  ];
  return (
    <div className="accounting-view-stack">
      <section className="accounting-kpi-grid">
        {cards.map((card) => (
          <button key={card.label} className={`accounting-kpi ${card.tone || ""}`} type="button" onClick={() => navigate(card.view)}>
            <span>{card.label}</span><strong>{card.value}</strong><small>{card.detail}</small>
          </button>
        ))}
      </section>
      <div className="accounting-dashboard-grid">
        <section className="panel accounting-overview-card">
          <div className="accounting-panel-heading"><div><p>Estado de consolidación</p><h2>Control operativo</h2></div><span className={`accounting-quality ${summary.provisional ? "review" : "ok"}`}>{summary.provisional ? "Provisional" : "Período cerrado"}</span></div>
          <div className="accounting-control-summary">
            <button type="button" onClick={() => navigate("reconcile")}><strong>{summary.unmatched_bank}</strong><span>movimientos sin conciliar</span></button>
            <button type="button" onClick={() => navigate("ledger")}><strong>{summary.pending_entries}</strong><span>asientos pendientes</span></button>
            <button type="button" onClick={() => navigate("controls")}><strong>{summary.open_controls}</strong><span>controles abiertos</span></button>
          </div>
          <p className="accounting-explanation">Los indicadores nacen de asientos contabilizados y submayores normalizados. Un documento Facto sin asiento puede aparecer en cobranza, pero no altera el balance hasta su contabilización.</p>
        </section>
        <section className="panel accounting-source-card">
          <div className="accounting-panel-heading"><div><p>Fuentes conectadas</p><h2>Evidencia consolidada</h2></div><BadgeDollarSign size={24} /></div>
          <div className="accounting-source-list">
            <button type="button" onClick={() => navigate("facto")}><span>Facto</span><strong>{data.sources.filter((row) => row.source_type === "FACTO").length} documentos</strong></button>
            <button type="button" onClick={() => navigate("banks")}><span>Bancos y Mercado Pago</span><strong>{data.bankTransactions.length} movimientos</strong></button>
            <button type="button" onClick={() => navigate("banks")}><span>Archivos originales</span><strong>{data.batches.length} cargas</strong></button>
          </div>
        </section>
      </div>
    </div>
  );
}

function AccountsView({ data, busy, runAction }: ActionViewProps) {
  const [search, setSearch] = useState("");
  const [showForm, setShowForm] = useState(false);
  const rows = data.accounts.filter((row) => normalize(`${row.code} ${row.name} ${row.classification}`).includes(normalize(search)));
  return (
    <div className="accounting-view-stack"><section className="panel">
      <div className="accounting-panel-heading"><div><p>Estructura central</p><h2>Plan de Cuentas Maestro</h2><span>Cuentas Facto y cuentas exclusivas del CRM pueden mapearse sin duplicarse.</span></div><div className="accounting-source-actions"><SearchField value={search} onChange={setSearch} placeholder="Buscar código o cuenta" />{data.profile.role === "administrador" ? <button className="primary-button" type="button" onClick={() => setShowForm(true)}><Plus size={17} /> Nueva cuenta</button> : null}</div></div>
      <Table headers={["Código", "Cuenta", "Tipo", "Clasificación", "Moneda", "Movimiento"]}>
        {rows.map((row) => <tr key={row.id}><td data-label="Código"><strong>{row.code}</strong></td><td data-label="Cuenta">{row.name}</td><td data-label="Tipo">{accountType(row.account_type)}</td><td data-label="Clasificación">{humanize(row.classification)}</td><td data-label="Moneda">{row.currency || data.entity.functional_currency}</td><td data-label="Movimiento"><Status value={row.allows_posting ? "Imputable" : "Agrupadora"} tone={row.allows_posting ? "success" : "neutral"} /></td></tr>)}
      </Table>
    </section>{showForm ? <AccountDialog data={data} busy={busy} close={() => setShowForm(false)} runAction={runAction} /> : null}</div>
  );
}

function AccountDialog({ data, busy, close, runAction }: ActionViewProps & { close: () => void }) {
  const [form, setForm] = useState({ code: "", name: "", parentId: "", accountType: "asset" as AccountingAccount["account_type"], classification: "other", currency: "", allowsPosting: true });
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (await runAction("create-account", () => createAccountingAccount({ entityId: data.entity.id, ...form }), "Cuenta contable creada y registrada en auditoría.")) close();
  }
  return <div className="accounting-modal-backdrop"><form className="accounting-modal" onSubmit={(event) => void submit(event)}><div className="accounting-modal-heading"><div><p>Configuración administrativa</p><h2>Nueva cuenta contable</h2></div><button className="icon-button" aria-label="Cerrar" type="button" onClick={close}><X /></button></div><div className="accounting-form-grid"><label>Código<input required maxLength={40} placeholder="Ej. 6.1.04" value={form.code} onChange={(event) => setForm({ ...form, code: event.target.value })} /></label><label>Nombre<input required maxLength={160} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label><label className="wide">Cuenta padre<select value={form.parentId} onChange={(event) => setForm({ ...form, parentId: event.target.value })}><option value="">Sin cuenta padre</option>{data.accounts.map((account) => <option key={account.id} value={account.id}>{account.code} · {account.name}</option>)}</select></label><label>Tipo<select value={form.accountType} onChange={(event) => setForm({ ...form, accountType: event.target.value as AccountingAccount["account_type"] })}>{(["asset","liability","equity","income","cost","expense","result"] as AccountingAccount["account_type"][]).map((type) => <option key={type} value={type}>{accountType(type)}</option>)}</select></label><label>Clasificación<input required placeholder="Ej. arriendos" value={form.classification} onChange={(event) => setForm({ ...form, classification: event.target.value })} /></label><label>Moneda<input maxLength={3} placeholder={data.entity.functional_currency} value={form.currency} onChange={(event) => setForm({ ...form, currency: event.target.value.toUpperCase() })} /></label><label className="accounting-check-option"><input checked={form.allowsPosting} type="checkbox" onChange={(event) => setForm({ ...form, allowsPosting: event.target.checked })} /> Permite registrar movimientos</label></div><div className="accounting-modal-actions"><button className="ghost-button" type="button" onClick={close}>Cancelar</button><button className="primary-button" disabled={busy === "create-account"} type="submit">{busy === "create-account" ? "Guardando…" : "Crear cuenta"}</button></div></form></div>;
}

function LedgerView({ data, busy, runAction }: ActionViewProps) {
  const [showForm, setShowForm] = useState(false);
  async function reverse(entry: AccountingJournalEntry) {
    const reason = window.prompt("Motivo de la reversa contable:")?.trim();
    if (!reason) return;
    const reversalDate = window.prompt("Fecha de reversa (AAAA-MM-DD):", today())?.trim();
    if (!reversalDate) return;
    await runAction(`reverse-${entry.id}`, () => reverseAccountingEntry(entry.id, reversalDate, reason), "Asiento reversado mediante un nuevo comprobante compensatorio.");
  }
  return (
    <div className="accounting-view-stack">
      <section className="panel">
        <div className="accounting-panel-heading"><div><p>Libro central</p><h2>Asientos contables</h2><span>Los asientos contabilizados son inmutables; una corrección genera una reversa.</span></div><button className="primary-button" type="button" onClick={() => setShowForm(true)}><Plus size={17} /> Nuevo asiento</button></div>
        <Table headers={["N.º", "Fecha", "Glosa", "Referencia", "Origen", "Estado", "Acción"]}>
          {data.entries.map((entry) => <tr key={entry.id}><td data-label="N.º">{entry.entry_number}</td><td data-label="Fecha">{date(entry.entry_date)}</td><td data-label="Glosa"><strong>{entry.description}</strong></td><td data-label="Referencia">{entry.reference || "—"}</td><td data-label="Origen">{entry.source_type}</td><td data-label="Estado"><Status value={journalStatus(entry.status)} tone={entry.status === "posted" ? "success" : entry.status === "reversed" ? "danger" : "review"} /></td><td data-label="Acción">{["validated", "pending_review", "draft", "suggested"].includes(entry.status) ? <button className="small-command" disabled={Boolean(busy)} type="button" onClick={() => void runAction(`post-${entry.id}`, () => postAccountingEntry(entry.id), "Asiento contabilizado y auditado.")}>{busy === `post-${entry.id}` ? "Contabilizando…" : "Contabilizar"}</button> : entry.status === "posted" ? <button className="small-command danger" disabled={Boolean(busy)} type="button" onClick={() => void reverse(entry)}>{busy === `reverse-${entry.id}` ? "Reversando…" : "Reversar"}</button> : "—"}</td></tr>)}
        </Table>
      </section>
      {showForm ? <JournalDialog data={data} busy={busy} close={() => setShowForm(false)} runAction={runAction} /> : null}
    </div>
  );
}

function JournalDialog({ data, busy, close, runAction }: ActionViewProps & { close: () => void }) {
  const postingAccounts = data.accounts.filter((account) => account.allows_posting && account.active);
  const initialAccount = postingAccounts[0]?.id || "";
  const [draft, setDraft] = useState<AccountingJournalDraft>({
    entity_id: data.entity.id, entry_date: today(), description: "", reference: "", currency: "CLP", exchange_rate: 1, status: "pending_review",
    lines: [{ account_id: initialAccount, debit_clp: 0, credit_clp: 0 }, { account_id: initialAccount, debit_clp: 0, credit_clp: 0 }],
  });
  const debit = draft.lines.reduce((sum, line) => sum + number(line.debit_clp), 0);
  const credit = draft.lines.reduce((sum, line) => sum + number(line.credit_clp), 0);
  function updateLine(index: number, changes: Partial<AccountingJournalDraft["lines"][number]>) { setDraft((current) => ({ ...current, lines: current.lines.map((line, lineIndex) => lineIndex === index ? { ...line, ...changes } : line) })); }
  async function submit(event: FormEvent) {
    event.preventDefault();
    await runAction("create-entry", () => createAccountingEntry(draft), "Asiento guardado para revisión.");
    close();
  }
  return <div className="accounting-modal-backdrop" role="presentation"><form className="accounting-modal" onSubmit={(event) => void submit(event)}><div className="accounting-modal-heading"><div><p>Registro auditable</p><h2>Nuevo asiento contable</h2></div><button className="icon-button" type="button" aria-label="Cerrar" onClick={close}><X /></button></div><div className="accounting-form-grid"><label>Fecha<input required type="date" value={draft.entry_date} onChange={(event) => setDraft({ ...draft, entry_date: event.target.value })} /></label><label>Referencia<input value={draft.reference} onChange={(event) => setDraft({ ...draft, reference: event.target.value })} /></label><label className="wide">Glosa<input required minLength={3} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label></div><div className="accounting-entry-lines">{draft.lines.map((line, index) => <div className="accounting-entry-line" key={index}><label>Cuenta<select required value={line.account_id} onChange={(event) => updateLine(index, { account_id: event.target.value })}>{postingAccounts.map((account) => <option key={account.id} value={account.id}>{account.code} · {account.name}</option>)}</select></label><label>Debe CLP<input min="0" step="0.01" type="number" value={line.debit_clp || ""} onChange={(event) => updateLine(index, { debit_clp: Number(event.target.value), credit_clp: 0 })} /></label><label>Haber CLP<input min="0" step="0.01" type="number" value={line.credit_clp || ""} onChange={(event) => updateLine(index, { credit_clp: Number(event.target.value), debit_clp: 0 })} /></label>{draft.lines.length > 2 ? <button className="icon-button" type="button" aria-label="Eliminar línea" onClick={() => setDraft((current) => ({ ...current, lines: current.lines.filter((_, lineIndex) => lineIndex !== index) }))}><X size={17} /></button> : null}</div>)}</div><button className="small-command" type="button" onClick={() => setDraft((current) => ({ ...current, lines: [...current.lines, { account_id: initialAccount, debit_clp: 0, credit_clp: 0 }] }))}><Plus size={15} /> Agregar línea</button><div className={`accounting-balance-check ${debit > 0 && debit === credit ? "ok" : "review"}`}><span>Debe {clp(debit)}</span><span>Haber {clp(credit)}</span><strong>{debit > 0 && debit === credit ? "Cuadrado" : `Diferencia ${clp(debit - credit)}`}</strong></div><div className="accounting-modal-actions"><button className="ghost-button" type="button" onClick={close}>Cancelar</button><button className="primary-button" disabled={busy === "create-entry" || debit <= 0 || debit !== credit} type="submit">{busy === "create-entry" ? "Guardando…" : "Guardar para revisión"}</button></div></form></div>;
}

function FactoView({ data, busy, runAction }: ActionViewProps) {
  const sources = data.sources.filter((row) => row.source_type === "FACTO" || row.source_type === "COMERCIO_EXTERIOR");
  return <section className="panel"><div className="accounting-panel-heading"><div><p>Integraciones solo lectura</p><h2>Documentos financieros normalizados</h2><span>Facto y Comercio Exterior aportan evidencia sin modificar el origen ni contabilizar estimaciones automáticamente.</span></div><div className="accounting-source-actions"><button className="ghost-button" disabled={Boolean(busy)} type="button" onClick={() => void runAction("foreign-trade", syncAccountingForeignTrade, "Comercio Exterior sincronizado como evidencia; ningún costo fue contabilizado automáticamente.")}><RefreshCw className={busy === "foreign-trade" ? "spin" : ""} size={17} /> Comercio Exterior</button><button className="primary-button" disabled={Boolean(busy)} type="button" onClick={() => void runAction("facto", syncAccountingFacto, "Facto sincronizado; documentos, cuentas por cobrar y pagar fueron consolidados.")}><RefreshCw className={busy === "facto" ? "spin" : ""} size={17} /> Facto</button></div></div><div className="accounting-inline-stats"><span><strong>{sources.filter((row) => row.source_type === "FACTO").length}</strong> Facto</span><span><strong>{sources.filter((row) => row.source_type === "COMERCIO_EXTERIOR").length}</strong> Comercio Exterior</span><span><strong>{sources.filter((row) => row.status === "inconsistent").length}</strong> requieren revisión</span><span><strong>{sources.filter((row) => row.status === "posted").length}</strong> contabilizados</span></div><Table headers={["Fuente", "Fecha", "Documento", "Contraparte", "Total", "Calidad", "Estado"]}>{sources.map((row) => <tr key={row.id}><td data-label="Fuente"><Status value={row.source_type === "FACTO" ? "Facto" : "Comercio Exterior"} tone="neutral" /></td><td data-label="Fecha">{date(row.issued_on)}</td><td data-label="Documento"><strong>{humanize(row.document_type)} {row.folio || ""}</strong></td><td data-label="Contraparte">{row.counterpart_name || "Sin identificar"}<small>{row.counterpart_tax_id || ""}</small></td><td data-label="Total">{clp(row.total_clp)}<small>{row.currency !== "CLP" ? `${money(row.total_amount)} ${row.currency}` : ""}</small></td><td data-label="Calidad"><Status value={humanize(row.data_quality)} tone={row.data_quality === "validated" ? "success" : "review"} /></td><td data-label="Estado">{humanize(row.status)}</td></tr>)}</Table></section>;
}

function BankImportView({ data, busy, runAction }: ActionViewProps) {
  const [file, setFile] = useState<File | null>(null);
  const [profile, setProfile] = useState<"auto" | "scotiabank" | "banco_estado" | "mercado_pago">("auto");
  const [preview, setPreview] = useState<AccountingImportPreview | null>(null);
  const [localError, setLocalError] = useState("");
  async function prepare() {
    if (!file) return;
    setLocalError("");
    try {
      const storagePath = await uploadAccountingEvidence(data.entity.id, file);
      setPreview(await previewAccountingImport({ entityId: data.entity.id, profile, storagePath, fileName: file.name }));
    } catch (caught) { setLocalError(caught instanceof Error ? caught.message : "No se pudo analizar la cartola."); }
  }
  return <div className="accounting-bank-layout"><section className="panel accounting-import-card"><div className="accounting-panel-heading"><div><p>Evidencia original</p><h2>Importar cartola</h2><span>Scotiabank, BancoEstado y Mercado Pago tienen lectores independientes.</span></div><Upload size={24} /></div><label>Institución / formato<select value={profile} onChange={(event) => setProfile(event.target.value as typeof profile)}><option value="auto">Detectar automáticamente</option><option value="scotiabank">Scotiabank</option><option value="banco_estado">BancoEstado</option><option value="mercado_pago">Mercado Pago</option></select></label><label className="accounting-file-drop"><FileSpreadsheet size={30} /><strong>{file?.name || "Selecciona una cartola Excel"}</strong><span>XLS, XLSX o CSV · se conserva el original</span><input accept=".xls,.xlsx,.csv" type="file" onChange={(event) => setFile(event.target.files?.[0] || null)} /></label>{localError ? <div className="accounting-local-error"><AlertTriangle size={16} />{localError}</div> : null}<button className="primary-button" disabled={!file || Boolean(busy)} type="button" onClick={() => void prepare()}><Search size={17} /> Previsualizar y validar</button></section><section className="panel accounting-import-history"><div className="accounting-panel-heading"><div><p>Auditoría de cargas</p><h2>Últimos archivos</h2></div></div>{data.batches.length ? <div className="accounting-history-list">{data.batches.map((batch) => <article key={batch.id}><FileSpreadsheet size={18} /><div><strong>{batch.file_name}</strong><span>{humanize(batch.source_type)} · {dateTime(batch.created_at)}</span></div><small>{batch.new_count} nuevos · {batch.duplicate_count} duplicados</small><Status value={humanize(batch.status)} tone={batch.status === "imported" ? "success" : "review"} /></article>)}</div> : <Empty icon={FileSpreadsheet} text="Aún no hay cartolas importadas." />}</section>{preview ? <ImportPreviewDialog preview={preview} busy={busy} close={() => setPreview(null)} runAction={runAction} /> : null}</div>;
}

function ImportPreviewDialog({ preview, busy, close, runAction }: { preview: AccountingImportPreview; busy: string; close: () => void; runAction: ActionRunner }) {
  const [exchangeRate, setExchangeRate] = useState("");
  async function confirm() { await runAction("confirm-import", () => confirmAccountingImport(preview.batch.id, exchangeRate ? Number(exchangeRate) : undefined), "Cartola importada sin duplicar movimientos existentes."); close(); }
  return <div className="accounting-modal-backdrop"><section className="accounting-modal wide"><div className="accounting-modal-heading"><div><p>Revisión obligatoria</p><h2>Previsualizar cartola</h2></div><button className="icon-button" type="button" onClick={close}><X /></button></div><div className="accounting-preview-kpis"><span><strong>{preview.summary.total}</strong>Total</span><span className="positive"><strong>{preview.summary.new}</strong>Nuevos</span><span><strong>{preview.summary.duplicates}</strong>Duplicados</span><span className="warning"><strong>{preview.summary.errors}</strong>Errores</span></div>{preview.bankAccount.currency !== "CLP" ? <label className="accounting-rate-field">Tipo de cambio a CLP<input min="1" required type="number" value={exchangeRate} onChange={(event) => setExchangeRate(event.target.value)} /></label> : null}<Table headers={["Fila", "Fecha", "Descripción", "Referencia", "Cargo", "Abono", "Saldo", "Validación"]}>{preview.rows.slice(0, 100).map((row) => <tr key={`${row.row_number}-${row.fingerprint}`}><td data-label="Fila">{row.row_number}</td><td data-label="Fecha">{date(row.transaction_date)}</td><td data-label="Descripción">{row.description}</td><td data-label="Referencia">{row.operation_number || row.reference || "—"}</td><td data-label="Cargo">{money(row.debit)}</td><td data-label="Abono">{money(row.credit)}</td><td data-label="Saldo">{row.balance === null ? "—" : money(row.balance)}</td><td data-label="Validación"><Status value={row.errors.length ? row.errors.join(", ") : "Correcto"} tone={row.errors.length ? "danger" : "success"} /></td></tr>)}</Table><div className="accounting-modal-actions"><button className="ghost-button" type="button" onClick={close}>Cancelar</button><button className="primary-button" disabled={busy === "confirm-import" || preview.summary.new === 0 || (preview.bankAccount.currency !== "CLP" && !exchangeRate)} type="button" onClick={() => void confirm()}>{busy === "confirm-import" ? "Importando…" : `Importar ${preview.summary.new} movimientos`}</button></div></section></div>;
}

function ReconciliationView({ data, busy, runAction }: ActionViewProps) {
  const unmatched = data.bankTransactions.filter((row) => row.reconciliation_status !== "matched" && row.reconciliation_status !== "ignored");
  const [selected, setSelected] = useState<AccountingBankTransaction | null>(unmatched[0] || null);
  const [candidates, setCandidates] = useState<AccountingReconciliationCandidate[]>([]);
  const [candidateBusy, setCandidateBusy] = useState(false);
  const [localError, setLocalError] = useState("");
  async function propose(transaction: AccountingBankTransaction) { setSelected(transaction); setCandidateBusy(true); setLocalError(""); try { setCandidates((await proposeAccountingReconciliation(transaction.id)).candidates); } catch (caught) { setLocalError(caught instanceof Error ? caught.message : "No se pudieron calcular coincidencias."); } finally { setCandidateBusy(false); } }
  async function confirm(candidate: AccountingReconciliationCandidate) { if (!selected) return; await runAction("reconcile", () => confirmAccountingReconciliation({ transactionId: selected.id, links: [{ targetType: candidate.targetType, targetId: candidate.targetId, amount: candidate.suggestedAmount }] }), "Movimiento conciliado y saldo actualizado."); setCandidates([]); setSelected(null); }
  return <div className="accounting-reconcile-layout"><section className="panel"><div className="accounting-panel-heading"><div><p>Cartola normalizada</p><h2>Movimientos pendientes</h2><span>No se contabilizan automáticamente sin una regla aprobada.</span></div><Status value={`${unmatched.length} pendientes`} tone={unmatched.length ? "review" : "success"} /></div>{unmatched.length ? <div className="accounting-transaction-list">{unmatched.map((row) => <button className={selected?.id === row.id ? "active" : ""} key={row.id} type="button" onClick={() => void propose(row)}><span>{date(row.transaction_date)}</span><strong>{row.description}</strong><small>{row.reference || row.operation_number || "Sin referencia"}</small><b className={row.amount_clp >= 0 ? "positive" : "negative"}>{clp(row.amount_clp)}</b></button>)}</div> : <Empty icon={CheckCircle2} text="Todos los movimientos visibles están conciliados." />}</section><section className="panel"><div className="accounting-panel-heading"><div><p>Motor determinístico</p><h2>Coincidencias sugeridas</h2></div></div>{localError ? <div className="accounting-local-error">{localError}</div> : null}{candidateBusy ? <Empty icon={LoaderCircle} text="Comparando monto, fecha, RUT y referencia…" spinning /> : null}{!candidateBusy && selected && !candidates.length ? <Empty icon={Search} text="Selecciona el movimiento o no se encontraron coincidencias suficientes." /> : null}<div className="accounting-candidate-list">{candidates.map((candidate) => { const document = candidate.candidate as AccountingReceivable & AccountingPayable; return <article key={candidate.targetId}><div><Status value={confidence(candidate.confidence)} tone={candidate.confidence === "exact" ? "success" : "review"} /><strong>{candidate.targetType === "receivable" ? document.customer_name : document.supplier_name}</strong><span>{document.document_number} · saldo {clp(document.balance_clp)}</span></div><div><b>{Math.round(candidate.score * 100)}%</b><button className="small-command" disabled={busy === "reconcile"} type="button" onClick={() => void confirm(candidate)}>Conciliar {clp(candidate.suggestedAmount)}</button></div></article>; })}</div></section></div>;
}

function ReceivablesView({ rows }: { rows: AccountingReceivable[] }) {
  const [bucket, setBucket] = useState("all");
  const filtered = rows.filter((row) => bucket === "all" || agingBucket(row.due_on) === bucket);
  return <section className="panel"><div className="accounting-panel-heading"><div><p>Cobranza</p><h2>Cuentas por cobrar</h2><span>La factura crea una cuenta por cobrar; solo un pago conciliado reduce su saldo.</span></div><select aria-label="Filtrar antigüedad" value={bucket} onChange={(event) => setBucket(event.target.value)}><option value="all">Todos los vencimientos</option><option value="current">Por vencer</option><option value="1-30">1–30 días</option><option value="31-60">31–60 días</option><option value="61-90">61–90 días</option><option value="91-120">91–120 días</option><option value="120+">Más de 120 días</option></select></div><Table headers={["Cliente", "Documento", "Emisión", "Vencimiento", "Original", "Abonos", "Saldo", "Estado"]}>{filtered.map((row) => <tr key={row.id}><td data-label="Cliente"><strong>{row.customer_name}</strong><small>{row.customer_tax_id || ""}</small></td><td data-label="Documento">{row.document_number}</td><td data-label="Emisión">{date(row.issued_on)}</td><td data-label="Vencimiento">{date(row.due_on)}<small>{agingLabel(row.due_on)}</small></td><td data-label="Original">{clp(row.original_amount_clp)}</td><td data-label="Abonos">{clp(row.paid_amount_clp)}</td><td data-label="Saldo"><strong>{clp(row.balance_clp)}</strong></td><td data-label="Estado"><Status value={humanize(row.status)} tone={row.status === "paid" ? "success" : agingBucket(row.due_on) === "current" ? "neutral" : "review"} /></td></tr>)}</Table></section>;
}

function PayablesView({ rows }: { rows: AccountingPayable[] }) {
  return <section className="panel"><div className="accounting-panel-heading"><div><p>Obligaciones</p><h2>Cuentas por pagar</h2><span>Incluye documentos Facto y obligaciones vinculadas a fuentes verificables.</span></div><strong>{clp(rows.reduce((sum, row) => sum + number(row.balance_clp), 0))}</strong></div><Table headers={["Proveedor", "Documento", "Emisión", "Vencimiento", "Original", "Pagado", "Saldo", "Estado"]}>{rows.map((row) => <tr key={row.id}><td data-label="Proveedor"><strong>{row.supplier_name}</strong><small>{row.supplier_tax_id || ""}</small></td><td data-label="Documento">{row.document_number}</td><td data-label="Emisión">{date(row.issued_on)}</td><td data-label="Vencimiento">{date(row.due_on)}<small>{agingLabel(row.due_on)}</small></td><td data-label="Original">{clp(row.original_amount_clp)}</td><td data-label="Pagado">{clp(row.paid_amount_clp)}</td><td data-label="Saldo"><strong>{clp(row.balance_clp)}</strong></td><td data-label="Estado"><Status value={humanize(row.status)} tone={row.status === "paid" ? "success" : "review"} /></td></tr>)}</Table></section>;
}

function ChecksView({ data, busy, runAction }: ActionViewProps) {
  const [showForm, setShowForm] = useState(false);
  return <div className="accounting-view-stack"><section className="panel"><div className="accounting-panel-heading"><div><p>Documentos por cobrar</p><h2>Cheques en cartera</h2><span>Un cheque recibido no se considera efectivo disponible hasta que sea cobrado.</span></div><div className="accounting-source-actions"><strong>{clp(data.checks.filter((row) => row.status === "portfolio").reduce((sum, row) => sum + number(row.amount_clp), 0))}</strong><button className="primary-button" type="button" onClick={() => setShowForm(true)}><Plus size={17} /> Registrar cheque</button></div></div>{data.checks.length ? <Table headers={["Cliente", "Banco", "N.º cheque", "Recepción", "Vencimiento", "Monto", "Estado"]}>{data.checks.map((row) => <tr key={row.id}><td data-label="Cliente"><strong>{row.customer_name}</strong></td><td data-label="Banco">{row.bank_name}</td><td data-label="N.º cheque">{row.check_number}</td><td data-label="Recepción">{date(row.received_on)}</td><td data-label="Vencimiento">{date(row.due_on)}</td><td data-label="Monto">{clp(row.amount_clp)}</td><td data-label="Estado"><Status value={humanize(row.status)} tone={row.status === "collected" ? "success" : row.status === "protested" ? "danger" : "review"} /></td></tr>)}</Table> : <Empty icon={FileCheck2} text="No hay cheques en cartera registrados." />}</section>{showForm ? <CheckDialog data={data} busy={busy} close={() => setShowForm(false)} runAction={runAction} /> : null}</div>;
}

function CheckDialog({ data, busy, close, runAction }: ActionViewProps & { close: () => void }) {
  const [form, setForm] = useState({ receivableId: "", customerName: "", bankName: "", checkNumber: "", amountClp: "", receivedOn: today(), dueOn: "", notes: "" });
  const selectedReceivable = data.receivables.find((row) => row.id === form.receivableId);
  function selectReceivable(receivableId: string) {
    const receivable = data.receivables.find((row) => row.id === receivableId);
    setForm((current) => ({ ...current, receivableId, customerName: receivable?.customer_name || current.customerName, amountClp: receivable ? String(receivable.balance_clp) : current.amountClp }));
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    await runAction("create-check", () => createAccountingCheck({
      entityId: data.entity.id,
      receivableId: form.receivableId || undefined,
      customerName: form.customerName,
      bankName: form.bankName,
      checkNumber: form.checkNumber,
      amountClp: Number(form.amountClp),
      receivedOn: form.receivedOn,
      dueOn: form.dueOn || undefined,
      notes: form.notes || undefined,
    }), "Cheque registrado en cartera; aún no se considera dinero disponible.");
    close();
  }
  return <div className="accounting-modal-backdrop"><form className="accounting-modal" onSubmit={(event) => void submit(event)}><div className="accounting-modal-heading"><div><p>Ingreso manual trazable</p><h2>Registrar cheque en cartera</h2></div><button className="icon-button" aria-label="Cerrar" type="button" onClick={close}><X /></button></div><div className="accounting-form-grid"><label className="wide">Cuenta por cobrar (opcional)<select value={form.receivableId} onChange={(event) => selectReceivable(event.target.value)}><option value="">Sin vincular por ahora</option>{data.receivables.filter((row) => row.status !== "paid").map((row) => <option key={row.id} value={row.id}>{row.customer_name} · {row.document_number} · {clp(row.balance_clp)}</option>)}</select></label><label>Cliente<input required value={form.customerName} onChange={(event) => setForm({ ...form, customerName: event.target.value })} /></label><label>Banco<input required value={form.bankName} onChange={(event) => setForm({ ...form, bankName: event.target.value })} /></label><label>N.º cheque<input required value={form.checkNumber} onChange={(event) => setForm({ ...form, checkNumber: event.target.value })} /></label><label>Monto CLP<input min="1" required type="number" value={form.amountClp} onChange={(event) => setForm({ ...form, amountClp: event.target.value })} /></label><label>Fecha recepción<input required type="date" value={form.receivedOn} onChange={(event) => setForm({ ...form, receivedOn: event.target.value })} /></label><label>Fecha vencimiento<input type="date" value={form.dueOn} onChange={(event) => setForm({ ...form, dueOn: event.target.value })} /></label><label className="wide">Observaciones<textarea rows={3} value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} /></label></div>{selectedReceivable ? <div className="accounting-balance-check ok"><span>Documento {selectedReceivable.document_number}</span><span>Saldo {clp(selectedReceivable.balance_clp)}</span><strong>Vinculado</strong></div> : null}<div className="accounting-modal-actions"><button className="ghost-button" type="button" onClick={close}>Cancelar</button><button className="primary-button" disabled={busy === "create-check"} type="submit">{busy === "create-check" ? "Guardando…" : "Registrar en cartera"}</button></div></form></div>;
}

function PeriodsView({ data, isAdmin, busy, runAction }: ActionViewProps & { isAdmin: boolean }) {
  async function close(periodId: string) { const note = window.prompt("Observación de cierre (opcional):") || "Cierre revisado por Administración."; await runAction(`close-${periodId}`, () => closeAccountingPeriod(periodId, note), "Período cerrado. Las correcciones posteriores requieren asiento de ajuste."); }
  return <section className="panel"><div className="accounting-panel-heading"><div><p>Protección histórica</p><h2>Períodos contables</h2><span>Solo Administración puede cerrar. Finanzas puede revisar y contabilizar períodos abiertos.</span></div></div><div className="accounting-period-grid">{data.periods.map((period) => <article key={period.id}><div><strong>{periodLabel(period.starts_on)}</strong><span>{date(period.starts_on)} al {date(period.ends_on)}</span></div><Status value={period.status === "open" ? "Abierto" : period.status === "review" ? "En revisión" : "Cerrado"} tone={period.status === "closed" ? "success" : "review"} />{isAdmin && period.status !== "closed" ? <button className="small-command" disabled={Boolean(busy)} type="button" onClick={() => void close(period.id)}>{busy === `close-${period.id}` ? "Cerrando…" : "Cerrar período"}</button> : null}</article>)}</div></section>;
}

function ReportsView({ data }: { data: AccountingBootstrap }) {
  const [kind, setKind] = useState<"balance8" | "trial" | "journal" | "ledger">("balance8");
  const [from, setFrom] = useState(`${new Date().getFullYear()}-01-01`);
  const [to, setTo] = useState(today());
  const [accountId, setAccountId] = useState(data.accounts.find((row) => row.allows_posting)?.id || "");
  const [report, setReport] = useState<AccountingReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const title = reportTitle(kind);
  async function generate() { setBusy(true); setError(""); try { setReport(await getAccountingReport({ entityId: data.entity.id, kind, from, to, accountId: kind === "ledger" ? accountId : undefined })); } catch (caught) { setError(caught instanceof Error ? caught.message : "No se pudo generar el informe."); } finally { setBusy(false); } }
  return <div className="accounting-view-stack"><section className="panel accounting-report-controls"><div className="accounting-panel-heading"><div><p>Informes derivados del libro</p><h2>Centro de informes</h2><span>Las cifras no se ingresan manualmente: se reconstruyen desde asientos contabilizados y movimientos bancarios importados.</span></div></div><div className="accounting-form-grid report"><label>Informe<select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}><option value="balance8">Balance de 8 columnas</option><option value="trial">Balance de comprobación y saldos</option><option value="income">Estado de Resultados</option><option value="cashflow">Flujo de Caja bancario</option><option value="journal">Libro Diario</option><option value="ledger">Libro Mayor</option></select></label>{kind === "ledger" ? <label>Cuenta<select value={accountId} onChange={(event) => setAccountId(event.target.value)}>{data.accounts.filter((row) => row.allows_posting).map((row) => <option key={row.id} value={row.id}>{row.code} · {row.name}</option>)}</select></label> : null}<label>Desde<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label><label>Hasta<input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label><button className="primary-button" disabled={busy} type="button" onClick={() => void generate()}>{busy ? <LoaderCircle className="spin" size={17} /> : <Scale size={17} />} Generar</button></div>{error ? <div className="accounting-local-error">{error}</div> : null}</section>{report ? <section className="panel"><div className="accounting-panel-heading"><div><p>{date(from)} al {date(to)}</p><h2>{title}</h2><span className="accounting-provisional-note">Informe provisional mientras el período permanezca abierto.</span></div><div className="accounting-export-actions"><button className="ghost-button" type="button" onClick={() => void exportAccountingExcel(report, title)}><Download size={17} /> Excel</button><button className="ghost-button" type="button" onClick={() => void exportAccountingPdf(report, title)}><Download size={17} /> PDF</button></div></div><ReportTable report={report} /></section> : null}</div>;
}

function ControlsView({ data, busy, runAction }: ActionViewProps) {
  return <section className="panel"><div className="accounting-panel-heading"><div><p>Cuadratura automática</p><h2>Centro de Control Financiero</h2><span>Las inconsistencias quedan visibles hasta resolver su causa; no se ocultan.</span></div><button className="ghost-button" disabled={Boolean(busy)} type="button" onClick={() => void runAction("controls", () => refreshAccountingControls(data.entity.id), "Controles financieros actualizados.")}><RefreshCw className={busy === "controls" ? "spin" : ""} size={17} /> Ejecutar controles</button></div>{data.controls.length ? <div className="accounting-findings-list">{data.controls.map((finding) => <article className={finding.severity} key={finding.id}><span>{finding.severity === "error" ? <AlertTriangle /> : <Search />}</span><div><strong>{finding.title}</strong><p>{finding.detail || "Requiere revisión del origen."}</p><small>{humanize(finding.entity_type || "sistema")} · {dateTime(finding.detected_at)}</small></div>{finding.amount_clp ? <b>{clp(finding.amount_clp)}</b> : null}</article>)}</div> : <Empty icon={CheckCircle2} text="No hay hallazgos abiertos en este momento." />}</section>;
}

function ReportTable({ report }: { report: AccountingReport }) { const keys = Object.keys(report.rows[0] || {}); if (!report.rows.length) return <Empty icon={FileSpreadsheet} text="El período no tiene movimientos contabilizados para este informe." />; return <Table headers={keys.map(humanize)}>{report.rows.map((row, index) => <tr key={index}>{keys.map((key) => <td data-label={humanize(key)} key={key}>{typeof row[key] === "number" || /debit|credit|balance|assets|liabilit|loss|gain|amount|inflow|outflow|net_flow/i.test(key) ? clp(number(row[key])) : String(row[key] ?? "—")}</td>)}</tr>)}</Table>; }
function Table({ headers, children }: { headers: string[]; children: React.ReactNode }) { return <div className="accounting-table-wrap"><table className="accounting-center-table"><thead><tr>{headers.map((header) => <th key={header}>{header}</th>)}</tr></thead><tbody>{children}</tbody></table></div>; }
function Status({ value, tone }: { value: string; tone: "success" | "review" | "danger" | "neutral" }) { return <span className={`accounting-status ${tone}`}>{value}</span>; }
function Empty({ icon: Icon, text, spinning = false }: { icon: typeof Landmark; text: string; spinning?: boolean }) { return <div className="accounting-empty"><Icon className={spinning ? "spin" : ""} size={26} /><span>{text}</span></div>; }
function SearchField({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder: string }) { return <label className="accounting-search"><Search size={16} /><input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} /></label>; }

type ActionRunner = (key: string, action: () => Promise<unknown>, success: string) => Promise<boolean>;
type ActionViewProps = { data: AccountingBootstrap; busy: string; runAction: ActionRunner };
function number(value: unknown) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }
function clp(value: unknown) { return new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 }).format(number(value)); }
function money(value: unknown) { return new Intl.NumberFormat("es-CL", { maximumFractionDigits: 2 }).format(number(value)); }
function date(value: string | null | undefined) { if (!value) return "—"; const parsed = new Date(`${value.slice(0, 10)}T12:00:00`); return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString("es-CL"); }
function dateTime(value: string) { const parsed = new Date(value); return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString("es-CL", { dateStyle: "short", timeStyle: "short" }); }
function today() { return new Date().toISOString().slice(0, 10); }
function normalize(value: string) { return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase(); }
function humanize(value: string) { return value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function accountType(value: AccountingAccount["account_type"]) { return ({ asset: "Activo", liability: "Pasivo", equity: "Patrimonio", income: "Ingreso", cost: "Costo", expense: "Gasto", result: "Resultado" } as Record<string, string>)[value] || humanize(value); }
function journalStatus(value: AccountingJournalEntry["status"]) { return ({ draft: "Borrador", suggested: "Sugerido", pending_review: "Pendiente", validated: "Validado", posted: "Contabilizado", reversed: "Reversado", voided: "Anulado" } as Record<string, string>)[value]; }
function confidence(value: AccountingReconciliationCandidate["confidence"]) { return value === "exact" ? "Coincidencia exacta" : value === "high" ? "Alta probabilidad" : "Coincidencia posible"; }
function agingBucket(due: string | null) { if (!due) return "current"; const days = Math.floor((Date.now() - new Date(`${due}T12:00:00`).getTime()) / 86400000); if (days <= 0) return "current"; if (days <= 30) return "1-30"; if (days <= 60) return "31-60"; if (days <= 90) return "61-90"; if (days <= 120) return "91-120"; return "120+"; }
function agingLabel(due: string | null) { const bucket = agingBucket(due); return bucket === "current" ? "Por vencer" : `${bucket} días`; }
function periodLabel(value: string) { return new Date(`${value}T12:00:00`).toLocaleDateString("es-CL", { month: "long", year: "numeric" }); }
function reportTitle(kind: AccountingReport["kind"]) { return ({ balance8: "Balance de 8 columnas", trial: "Balance de comprobación y saldos", income: "Estado de Resultados", cashflow: "Flujo de Caja bancario", journal: "Libro Diario", ledger: "Libro Mayor" } as Record<string, string>)[kind]; }
