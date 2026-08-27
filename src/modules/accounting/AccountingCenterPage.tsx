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
  confirmAccountingFactoExcel,
  confirmAccountingImport,
  confirmAccountingReconciliation,
  createAccountingAccount,
  createAccountingCheck,
  createAccountingEntry,
  downloadAccountingEvidence,
  exportAccountingExcel,
  exportAccountingPdf,
  getAccountingReport,
  postAccountingEntry,
  previewAccountingFactoExcel,
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
  AccountingFactoSyncResult,
  AccountingFactoExcelPreview,
  AccountingFactoExcelProfile,
  AccountingImportPreview,
  AccountingJournalDraft,
  AccountingJournalEntry,
  AccountingPayable,
  AccountingReceivable,
  AccountingReconciliationCandidate,
  AccountingReconciliationProposal,
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

const factoExcelProfiles: Array<{ id: AccountingFactoExcelProfile; label: string; help: string }> = [
  { id: "facto_unpaid_documents", label: "Documentos pendientes / impagos", help: "Actualiza saldos informados por Facto sin inventar pagos bancarios." },
  { id: "facto_checks_banco_estado", label: "Cheques Facto · flujo BancoEstado", help: "Conserva banco emisor y espera su cobro en la futura cartola BancoEstado." },
  { id: "facto_cash_scotiabank", label: "Movimientos Facto · Scotiabank", help: "Registra evidencia de cobros y pagos pendiente de cartola bancaria." },
  { id: "facto_cash_mercado_pago", label: "Movimientos Facto · Mercado Pago", help: "Registra eventos Facto pendientes de conciliación con Mercado Pago." },
  { id: "facto_cash", label: "Movimiento de caja general Facto", help: "Consolida todos los métodos y evita duplicar eventos ya presentes en archivos específicos." },
];

function FactoView({ data, busy, runAction }: ActionViewProps) {
  const sources = data.sources.filter((row) => row.source_type === "FACTO" || row.source_type === "COMERCIO_EXTERIOR");
  const [fromDate, setFromDate] = useState("2026-01-01");
  const [toDate, setToDate] = useState(today());
  const [result, setResult] = useState<AccountingFactoSyncResult | null>(null);
  const [query, setQuery] = useState("");
  const [documentFrom, setDocumentFrom] = useState("2026-01-01");
  const [documentTo, setDocumentTo] = useState(today());
  const [sourceFilter, setSourceFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [profile, setProfile] = useState<AccountingFactoExcelProfile>("facto_unpaid_documents");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<AccountingFactoExcelPreview | null>(null);
  const [localError, setLocalError] = useState("");
  const selectedProfile = factoExcelProfiles.find((item) => item.id === profile)!;
  const supportBatches = data.batches.filter((batch) => ["COLLECTIONS", "CHECKS", "PAYMENTS"].includes(batch.source_type));
  const normalizedQuery = normalize(query);
  const filteredSources = sources.filter((row) => {
    const matchesQuery = !normalizedQuery || normalize([row.folio, row.counterpart_name, row.counterpart_tax_id, row.document_type].filter(Boolean).join(" ")).includes(normalizedQuery);
    const matchesFrom = !documentFrom || !row.issued_on || row.issued_on.slice(0, 10) >= documentFrom;
    const matchesTo = !documentTo || !row.issued_on || row.issued_on.slice(0, 10) <= documentTo;
    const matchesSource = sourceFilter === "all" || row.source_type === sourceFilter;
    const matchesStatus = statusFilter === "all" || row.status === statusFilter || row.data_quality === statusFilter;
    return matchesQuery && matchesFrom && matchesTo && matchesSource && matchesStatus;
  });

  async function syncFactoRange() {
    await runAction("facto", async () => {
      const response = await syncAccountingFacto({ fromDate, toDate });
      setResult(response);
      return response;
    }, "Carga histórica Facto terminada y respaldada en Finanzas.");
  }

  async function prepareFactoExcel() {
    if (!file) return;
    setLocalError("");
    try {
      const storagePath = await uploadAccountingEvidence(data.entity.id, file);
      setPreview(await previewAccountingFactoExcel({ entityId: data.entity.id, profile, storagePath, fileName: file.name }));
    } catch (caught) {
      setLocalError(caught instanceof Error ? caught.message : "No se pudo analizar el respaldo Facto.");
    }
  }

  return <div className="accounting-view-stack">
    <section className="panel accounting-facto-sync">
      <div className="accounting-panel-heading"><div><p>Integración Facto en solo lectura</p><h2>Carga histórica con respaldo</h2><span>Prioriza la API para documentos tributarios. No marca facturas como pagadas ni crea asientos sin evidencia conciliada.</span></div><button className="ghost-button" disabled={Boolean(busy)} type="button" onClick={() => void runAction("foreign-trade", syncAccountingForeignTrade, "Comercio Exterior sincronizado como evidencia; ningún costo fue contabilizado automáticamente.")}><RefreshCw className={busy === "foreign-trade" ? "spin" : ""} size={17} /> Comercio Exterior</button></div>
      <div className="accounting-facto-range"><label>Desde<input type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} /></label><label>Hasta<input type="date" max={today()} value={toDate} onChange={(event) => setToDate(event.target.value)} /></label><button className="primary-button" disabled={Boolean(busy) || !fromDate || !toDate || fromDate > toDate} type="button" onClick={() => void syncFactoRange()}><RefreshCw className={busy === "facto" ? "spin" : ""} size={17} /> {busy === "facto" ? "Consolidando…" : "Cargar desde Facto"}</button></div>
      {result ? <div className="accounting-facto-result"><strong>{result.accepted} documentos del período</strong><span>{result.inserted} nuevos · {result.updated} actualizados · {result.backups} respaldos de origen</span><small>{result.receivables} cuentas por cobrar · {result.payables} cuentas por pagar · {result.inconsistent} por revisar</small></div> : null}
      <div className="accounting-facto-history"><h3>Historial de sincronización API</h3>{data.factoSyncRuns.length ? data.factoSyncRuns.map((run) => <article key={run.id}><div><strong>{date(run.from_date)} al {date(run.to_date)}</strong><span>{dateTime(run.created_at)}</span></div><Status value={run.status === "completed" ? "Completada" : run.status === "partial" ? "Con observaciones" : run.status === "failed" ? "Fallida" : "En curso"} tone={run.status === "completed" ? "success" : run.status === "failed" ? "danger" : "review"} /><p>{run.in_range_records} documentos · {run.inserted_records} nuevos · {run.updated_records} actualizados · {run.inconsistent_records} observaciones</p>{run.error_message ? <small>{run.error_message}</small> : null}</article>) : <Empty icon={RefreshCw} text="Todavía no hay cargas históricas registradas." />}</div>
    </section>

    <div className="accounting-facto-support-grid">
      <section className="panel accounting-import-card">
        <div className="accounting-panel-heading"><div><p>Información complementaria</p><h2>Cargar Excel de Facto</h2><span>Se conserva el archivo original, se previsualiza y solo después de confirmar se integra.</span></div><FileSpreadsheet size={24} /></div>
        <label>Contenido del archivo<select value={profile} onChange={(event) => setProfile(event.target.value as AccountingFactoExcelProfile)}>{factoExcelProfiles.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        <p className="accounting-profile-help">{selectedProfile.help}</p>
        <label className="accounting-file-drop"><Upload size={30} /><strong>{file?.name || "Selecciona un archivo Excel"}</strong><span>XLS o XLSX · máximo 25 MB · original privado</span><input accept=".xls,.xlsx" type="file" onChange={(event) => setFile(event.target.files?.[0] || null)} /></label>
        {localError ? <div className="accounting-local-error"><AlertTriangle size={16} />{localError}</div> : null}
        <button className="primary-button" disabled={!file || Boolean(busy)} type="button" onClick={() => void prepareFactoExcel()}><Search size={17} /> Previsualizar y validar</button>
      </section>
      <section className="panel accounting-import-history">
        <div className="accounting-panel-heading"><div><p>Respaldo y trazabilidad</p><h2>Archivos complementarios</h2><span>No reemplazan cartolas bancarias ni crean ingresos duplicados.</span></div></div>
        {supportBatches.length ? <div className="accounting-history-list">{supportBatches.map((batch) => <article key={batch.id}><FileSpreadsheet className="accounting-history-icon" size={18} /><div className="accounting-history-main"><strong title={batch.file_name}>{batch.file_name}</strong><span>{factoProfileLabel(batch.import_profile)} · {dateTime(batch.created_at)}</span></div><small>{batch.new_count} nuevos · {batch.duplicate_count} duplicados · {batch.error_count} errores</small><div className="accounting-history-actions"><Status value={humanize(batch.status)} tone={batch.status === "imported" ? "success" : batch.status === "failed" ? "danger" : "review"} />{batch.storage_path ? <button aria-label={`Descargar ${batch.file_name}`} className="icon-button" title="Descargar original" type="button" onClick={() => void runAction(`download-${batch.id}`, () => downloadAccountingEvidence(batch.storage_path!, batch.file_name), "Respaldo descargado.")}><Download size={16} /></button> : null}</div></article>)}</div> : <Empty icon={FileSpreadsheet} text="Aún no hay archivos Facto complementarios." />}
      </section>
    </div>

    <section className="panel">
      <div className="accounting-panel-heading"><div><p>Evidencia normalizada</p><h2>Documentos financieros</h2><span>Busca por cliente, proveedor, RUT o folio y combina filtros de fecha, fuente y estado.</span></div><strong>{filteredSources.length} de {sources.length}</strong></div>
      <div className="accounting-filter-grid"><SearchField value={query} onChange={setQuery} placeholder="Nombre, RUT, folio o documento" /><label>Desde<input type="date" value={documentFrom} onChange={(event) => setDocumentFrom(event.target.value)} /></label><label>Hasta<input type="date" value={documentTo} onChange={(event) => setDocumentTo(event.target.value)} /></label><label>Fuente<select value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value)}><option value="all">Todas</option><option value="FACTO">Facto</option><option value="COMERCIO_EXTERIOR">Comercio Exterior</option></select></label><label>Estado<select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="all">Todos</option><option value="validated">Validado</option><option value="extracted">Extraído</option><option value="inconsistent">Inconsistente</option><option value="pending">Pendiente</option><option value="posted">Contabilizado</option></select></label></div>
      <div className="accounting-inline-stats"><span><strong>{sources.filter((row) => row.source_type === "FACTO").length}</strong> Facto</span><span><strong>{sources.filter((row) => row.source_type === "COMERCIO_EXTERIOR").length}</strong> Comercio Exterior</span><span><strong>{sources.filter((row) => row.status === "inconsistent").length}</strong> requieren revisión</span><span><strong>{data.paymentEvents.filter((row) => row.matching_status !== "reconciled").length}</strong> eventos de pago por conciliar</span></div>
      {filteredSources.length ? <Table headers={["Fuente", "Fecha", "Documento", "Contraparte", "Total", "Calidad", "Estado"]}>{filteredSources.map((row) => <tr key={row.id}><td data-label="Fuente"><Status value={row.source_type === "FACTO" ? "Facto" : "Comercio Exterior"} tone="neutral" /></td><td data-label="Fecha">{date(row.issued_on)}</td><td data-label="Documento"><strong>{humanize(row.document_type)} {row.folio || ""}</strong></td><td data-label="Contraparte">{row.counterpart_name || "Sin identificar"}<small>{row.counterpart_tax_id || ""}</small></td><td data-label="Total">{clp(row.total_clp)}<small>{row.currency !== "CLP" ? `${money(row.total_amount)} ${row.currency}` : ""}</small></td><td data-label="Calidad"><Status value={humanize(row.data_quality)} tone={row.data_quality === "validated" ? "success" : "review"} /></td><td data-label="Estado">{humanize(row.status)}</td></tr>)}</Table> : <Empty icon={Search} text="No hay documentos que coincidan con estos filtros." />}
    </section>
    {preview ? <FactoExcelPreviewDialog preview={preview} busy={busy} close={() => setPreview(null)} runAction={runAction} /> : null}
  </div>;
}

function FactoExcelPreviewDialog({ preview, busy, close, runAction }: { preview: AccountingFactoExcelPreview; busy: string; close: () => void; runAction: ActionRunner }) {
  const columns = factoPreviewColumns(preview.profile);
  async function confirm() {
    const completed = await runAction("confirm-facto-excel", () => confirmAccountingFactoExcel(preview.batch.id), "Archivo Facto respaldado e integrado sin duplicar documentos ni pagos.");
    if (completed) close();
  }
  return <div className="accounting-modal-backdrop"><section className="accounting-modal wide"><div className="accounting-modal-heading"><div><p>Revisión humana obligatoria</p><h2>{factoProfileLabel(preview.profile)}</h2><span>{preview.batch.file_name}</span></div><button className="icon-button" aria-label="Cerrar" type="button" onClick={close}><X /></button></div><div className="accounting-preview-kpis"><span><strong>{preview.summary.total}</strong>Filas</span><span className="positive"><strong>{preview.summary.new}</strong>Nuevas</span><span><strong>{preview.summary.duplicates}</strong>Duplicadas</span><span className="warning"><strong>{preview.summary.errors}</strong>Con errores</span></div>{preview.warnings.map((warning) => <div className="accounting-review-note" key={warning}><AlertTriangle size={16} />{warning}</div>)}<Table headers={["Fila", ...columns.headers, "Validación"]}>{preview.rows.slice(0, 200).map((row) => <tr key={`${row.row_number}-${row.fingerprint}`}><td data-label="Fila">{row.row_number}</td>{columns.values(row.data).map((cell, index) => <td data-label={columns.headers[index]} key={`${row.fingerprint}-${columns.headers[index]}`}>{cell}</td>)}<td data-label="Validación"><Status value={row.errors.length ? row.errors.join(" ") : "Correcto"} tone={row.errors.length ? "danger" : "success"} /></td></tr>)}</Table>{preview.rows.length > 200 ? <p className="accounting-table-note">Se muestran 200 de {preview.rows.length} filas; al confirmar se procesará el archivo completo.</p> : null}<div className="accounting-modal-actions"><button className="ghost-button" type="button" onClick={close}>Cancelar</button><button className="primary-button" disabled={busy === "confirm-facto-excel" || Number(preview.summary.new) === 0} type="button" onClick={() => void confirm()}>{busy === "confirm-facto-excel" ? "Integrando…" : `Confirmar ${preview.summary.new} registros`}</button></div></section></div>;
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
  const bankBatches = data.batches.filter((batch) => ["SCOTIABANK", "BANCO_ESTADO", "MERCADO_PAGO"].includes(batch.source_type));
  return <div className="accounting-bank-layout">
    <section className="panel accounting-import-card">
      <div className="accounting-panel-heading">
        <div>
          <p>Evidencia bancaria original</p>
          <h2>Importar cartola real</h2>
          <span>Scotiabank, BancoEstado y Mercado Pago tienen lectores independientes. Los movimientos de caja Facto se cargan en Fuentes.</span>
        </div>
        <Upload size={24} />
      </div>
      <label>Institución / formato
        <select value={profile} onChange={(event) => setProfile(event.target.value as typeof profile)}>
          <option value="auto">Detectar automáticamente</option>
          <option value="scotiabank">Scotiabank</option>
          <option value="banco_estado">BancoEstado</option>
          <option value="mercado_pago">Mercado Pago</option>
        </select>
      </label>
      <label className="accounting-file-drop">
        <FileSpreadsheet size={30} />
        <strong>{file?.name || "Selecciona una cartola Excel"}</strong>
        <span>XLS, XLSX o CSV · se conserva el original</span>
        <input accept=".xls,.xlsx,.csv" type="file" onChange={(event) => setFile(event.target.files?.[0] || null)} />
      </label>
      {localError ? <div className="accounting-local-error"><AlertTriangle size={16} />{localError}</div> : null}
      <button className="primary-button" disabled={!file || Boolean(busy)} type="button" onClick={() => void prepare()}><Search size={17} /> Previsualizar y validar</button>
    </section>

    <section className="panel accounting-import-history accounting-bank-history">
      <div className="accounting-panel-heading">
        <div><p>Auditoría bancaria</p><h2>Cartolas importadas</h2></div>
      </div>
      {bankBatches.length ? <div className="accounting-history-list">{bankBatches.map((batch) => <article key={batch.id}>
        <FileSpreadsheet className="accounting-history-icon" size={18} />
        <div className="accounting-history-main">
          <strong title={batch.file_name}>{batch.file_name}</strong>
          <span>{humanize(batch.source_type)} · {dateTime(batch.created_at)}</span>
        </div>
        <small>{batch.new_count} nuevos · {batch.duplicate_count} duplicados</small>
        <div className="accounting-history-actions">
          <Status value={humanize(batch.status)} tone={batch.status === "imported" ? "success" : batch.status === "failed" ? "danger" : "review"} />
          {batch.storage_path ? <button aria-label={`Descargar ${batch.file_name}`} className="icon-button" title="Descargar cartola original" type="button" onClick={() => void runAction(`download-${batch.id}`, () => downloadAccountingEvidence(batch.storage_path!, batch.file_name), "Cartola descargada.")}><Download size={16} /></button> : null}
        </div>
      </article>)}</div> : <Empty icon={FileSpreadsheet} text="Aún no hay cartolas bancarias importadas." />}
    </section>
    {preview ? <ImportPreviewDialog preview={preview} busy={busy} close={() => setPreview(null)} runAction={runAction} /> : null}
  </div>;
}

function ImportPreviewDialog({ preview, busy, close, runAction }: { preview: AccountingImportPreview; busy: string; close: () => void; runAction: ActionRunner }) {
  const foreignCurrency = preview.bankAccount.currency !== "CLP";
  const suggestedRate = number(preview.suggestedExchangeRate?.rate);
  const [exchangeRate, setExchangeRate] = useState(suggestedRate > 0 ? String(suggestedRate) : "");
  const parsedRate = parseLocalizedNumber(exchangeRate);
  const validRate = !foreignCurrency || parsedRate > 0;
  const sampleAmount = Math.abs(preview.rows.find((row) => row.amount !== 0)?.amount || 0);
  async function confirm() {
    const completed = await runAction(
      "confirm-import",
      () => confirmAccountingImport(preview.batch.id, foreignCurrency ? parsedRate : undefined),
      "Cartola importada sin duplicar movimientos existentes.",
    );
    if (completed) close();
  }
  return <div className="accounting-modal-backdrop"><section className="accounting-modal wide"><div className="accounting-modal-heading"><div><p>Revisión obligatoria</p><h2>Previsualizar cartola</h2><span>{preview.batch.file_name} · cuenta {preview.bankAccount.currency}</span></div><button aria-label="Cerrar" className="icon-button" type="button" onClick={close}><X /></button></div><div className="accounting-preview-kpis"><span><strong>{preview.summary.total}</strong>Total</span><span className="positive"><strong>{preview.summary.new}</strong>Nuevos</span><span><strong>{preview.summary.duplicates}</strong>Duplicados</span><span className="warning"><strong>{preview.summary.errors}</strong>Errores</span></div>{foreignCurrency ? <div className="accounting-currency-conversion"><div><strong>Cartola detectada en {preview.bankAccount.currency}</strong><span>Se conservará el monto original y se guardará su equivalente contable en CLP.</span></div><label className="accounting-rate-field"><span>Tipo de cambio {preview.bankAccount.currency}/CLP</span><input aria-invalid={!validRate} inputMode="decimal" placeholder="Ej.: 990,50" required type="text" value={exchangeRate} onChange={(event) => setExchangeRate(event.target.value)} /><small>{preview.suggestedExchangeRate ? `Sugerido: ${money(preview.suggestedExchangeRate.rate)} · ${date(preview.suggestedExchangeRate.rate_date)} · ${preview.suggestedExchangeRate.source}` : "Ingresa el tipo de cambio contable aplicable a esta cartola."}</small>{validRate && sampleAmount > 0 ? <small>Referencia: {currencyMoney(sampleAmount, preview.bankAccount.currency)} = {clp(sampleAmount * parsedRate)}</small> : null}</label></div> : null}<Table headers={["Fila", "Fecha", "Descripción", "Referencia", "Cargo", "Abono", "Saldo", "Validación"]}>{preview.rows.slice(0, 100).map((row) => <tr key={`${row.row_number}-${row.fingerprint}`}><td data-label="Fila">{row.row_number}</td><td data-label="Fecha">{date(row.transaction_date)}</td><td data-label="Descripción">{row.description}</td><td data-label="Referencia">{row.operation_number || row.reference || "—"}</td><td data-label="Cargo">{currencyMoney(row.debit, row.currency)}</td><td data-label="Abono">{currencyMoney(row.credit, row.currency)}</td><td data-label="Saldo">{row.balance === null ? "—" : currencyMoney(row.balance, row.currency)}</td><td data-label="Validación"><Status value={row.errors.length ? row.errors.join(", ") : "Correcto"} tone={row.errors.length ? "danger" : "success"} /></td></tr>)}</Table><div className="accounting-modal-actions"><button className="ghost-button" type="button" onClick={close}>Cancelar</button><button className="primary-button" disabled={busy === "confirm-import" || preview.summary.new === 0 || !validRate} type="button" onClick={() => void confirm()}>{busy === "confirm-import" ? "Importando…" : `Importar ${preview.summary.new} movimientos`}</button></div></section></div>;
}

function ReconciliationView({ data, busy, runAction }: ActionViewProps) {
  const unmatched = data.bankTransactions.filter((row) => row.reconciliation_status !== "matched" && row.reconciliation_status !== "ignored");
  const [selected, setSelected] = useState<AccountingBankTransaction | null>(null);
  const [proposal, setProposal] = useState<AccountingReconciliationProposal | null>(null);
  const [allocations, setAllocations] = useState<Record<string, string>>({});
  const [candidateBusy, setCandidateBusy] = useState(false);
  const [localError, setLocalError] = useState("");
  const [movementQuery, setMovementQuery] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [candidateQuery, setCandidateQuery] = useState("");
  const [note, setNote] = useState("");
  const normalizedMovementQuery = normalize(movementQuery);
  const filteredTransactions = unmatched.filter((row) => {
    const text = normalize(`${row.description} ${row.reference || ""} ${row.operation_number || ""}`);
    return (!normalizedMovementQuery || text.includes(normalizedMovementQuery))
      && (!from || row.transaction_date >= from)
      && (!to || row.transaction_date <= to);
  });
  const candidates = proposal?.candidates || [];
  const normalizedCandidateQuery = normalize(candidateQuery);
  const visibleCandidates = candidates.filter((candidate) => {
    const document = candidate.candidate;
    const name = candidate.targetType === "receivable" ? (document as AccountingReceivable).customer_name : (document as AccountingPayable).supplier_name;
    const taxId = candidate.targetType === "receivable" ? (document as AccountingReceivable).customer_tax_id : (document as AccountingPayable).supplier_tax_id;
    return !normalizedCandidateQuery || normalize(`${name} ${taxId || ""} ${document.document_number}`).includes(normalizedCandidateQuery);
  });
  const selectedTotal = Object.values(allocations).reduce((sum, value) => sum + Math.max(0, parseLocalizedNumber(value)), 0);
  const remainingAmount = proposal?.remainingAmount || 0;
  const allocationErrors = candidates.some((candidate) => parseLocalizedNumber(allocations[candidate.targetId] || "0") > number(candidate.candidate.balance_clp) + 0.5);
  const invalidTotal = selectedTotal > remainingAmount + 0.5;

  function applySuggestedPlan(nextProposal: AccountingReconciliationProposal) {
    const next: Record<string, string> = {};
    for (const link of nextProposal.suggestedPlan?.links || []) next[link.targetId] = String(Math.round(link.amount));
    setAllocations(next);
  }

  async function propose(transaction: AccountingBankTransaction) {
    setSelected(transaction);
    setCandidateBusy(true);
    setLocalError("");
    setCandidateQuery("");
    setNote("");
    setProposal(null);
    setAllocations({});
    try {
      const nextProposal = await proposeAccountingReconciliation(transaction.id);
      setProposal(nextProposal);
      applySuggestedPlan(nextProposal);
    } catch (caught) {
      setLocalError(caught instanceof Error ? caught.message : "No se pudieron calcular coincidencias.");
    } finally {
      setCandidateBusy(false);
    }
  }

  function toggleCandidate(candidate: AccountingReconciliationCandidate, checked: boolean) {
    setAllocations((current) => {
      const next = { ...current };
      if (checked) next[candidate.targetId] = String(Math.round(candidate.suggestedAmount));
      else delete next[candidate.targetId];
      return next;
    });
  }

  async function confirm() {
    if (!selected || !proposal) return;
    const links = candidates.flatMap((candidate) => {
      const amount = parseLocalizedNumber(allocations[candidate.targetId] || "0");
      return amount > 0 ? [{ targetType: candidate.targetType, targetId: candidate.targetId, amount }] : [];
    });
    if (!links.length || invalidTotal || allocationErrors) return;
    const completed = await runAction(
      "reconcile",
      () => confirmAccountingReconciliation({ transactionId: selected.id, links, note }),
      links.length > 1 ? "Pago distribuido y saldos actualizados." : "Movimiento conciliado y saldo actualizado.",
    );
    if (completed) {
      setProposal(null);
      setAllocations({});
      setSelected(null);
      setNote("");
    }
  }

  return <div className="accounting-reconcile-layout">
    <section className="panel accounting-reconcile-movements">
      <div className="accounting-panel-heading"><div><p>Cartola normalizada</p><h2>Movimientos pendientes</h2><span>Busca por nombre, RUT, referencia o fecha.</span></div><Status value={`${unmatched.length} pendientes`} tone={unmatched.length ? "review" : "success"} /></div>
      <div className="accounting-reconcile-filters">
        <label><span>Buscar movimiento</span><input placeholder="Nombre, RUT o referencia" type="search" value={movementQuery} onChange={(event) => setMovementQuery(event.target.value)} /></label>
        <label><span>Desde</span><input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
        <label><span>Hasta</span><input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label>
      </div>
      <small className="accounting-filter-count">Mostrando {filteredTransactions.length} de {unmatched.length} pendientes.</small>
      {filteredTransactions.length ? <div className="accounting-transaction-list">{filteredTransactions.map((row) => <button className={selected?.id === row.id ? "active" : ""} key={row.id} type="button" onClick={() => void propose(row)}><span>{date(row.transaction_date)} {row.reconciliation_status === "partial" ? "· Parcial" : ""}</span><strong>{row.description}</strong><small>{row.reference || row.operation_number || "Sin referencia"}</small><b className={row.amount_clp >= 0 ? "positive" : "negative"}>{clp(row.amount_clp)}</b></button>)}</div> : <Empty icon={unmatched.length ? Search : CheckCircle2} text={unmatched.length ? "No hay movimientos que coincidan con los filtros." : "Todos los movimientos visibles están conciliados."} />}
    </section>

    <section className="panel accounting-reconcile-candidates">
      <div className="accounting-panel-heading"><div><p>Propuesta auditable</p><h2>Asignar documentos</h2><span>Permite pagos parciales, varias facturas por pago y varios abonos por factura.</span></div></div>
      {localError ? <div className="accounting-local-error">{localError}</div> : null}
      {candidateBusy ? <Empty icon={LoaderCircle} text="Comparando RUT, nombre, fecha, folio y monto…" spinning /> : null}
      {!candidateBusy && !selected ? <Empty icon={Search} text="Selecciona un movimiento bancario para buscar coincidencias." /> : null}
      {!candidateBusy && proposal ? <>
        <div className="accounting-allocation-summary">
          <div><span>Movimiento</span><strong>{clp(Math.abs(number(selected?.amount_clp)))}</strong></div>
          <div><span>Ya conciliado</span><strong>{clp(proposal.allocatedAmount)}</strong></div>
          <div><span>Disponible</span><strong>{clp(proposal.remainingAmount)}</strong></div>
          <div className={invalidTotal ? "invalid" : ""}><span>Asignado ahora</span><strong>{clp(selectedTotal)}</strong></div>
          <div><span>Restará</span><strong>{clp(Math.max(proposal.remainingAmount - selectedTotal, 0))}</strong></div>
        </div>
        {proposal.suggestedPlan ? <div className="accounting-suggested-plan"><div><strong>Sugerencia del motor</strong><span>{proposal.suggestedPlan.explanation}</span></div><button className="ghost-button" type="button" onClick={() => applySuggestedPlan(proposal)}>Usar propuesta</button></div> : null}
        <label className="accounting-candidate-search"><span>Filtrar documentos</span><input placeholder="Cliente, proveedor, RUT o folio" type="search" value={candidateQuery} onChange={(event) => setCandidateQuery(event.target.value)} /></label>
        {!candidates.length ? <Empty icon={Search} text="No se encontraron documentos suficientemente relacionados. Ajusta la búsqueda o revisa que Facto tenga el RUT y nombre correctos." /> : null}
        <div className="accounting-candidate-list">{visibleCandidates.map((candidate) => {
          const document = candidate.candidate;
          const receivable = candidate.targetType === "receivable";
          const name = receivable ? (document as AccountingReceivable).customer_name : (document as AccountingPayable).supplier_name;
          const taxId = receivable ? (document as AccountingReceivable).customer_tax_id : (document as AccountingPayable).supplier_tax_id;
          const checked = parseLocalizedNumber(allocations[candidate.targetId] || "0") > 0;
          const amount = parseLocalizedNumber(allocations[candidate.targetId] || "0");
          const overBalance = amount > number(document.balance_clp) + 0.5;
          return <article className={checked ? "selected" : ""} key={candidate.targetId}>
            <label className="accounting-candidate-check"><input checked={checked} type="checkbox" onChange={(event) => toggleCandidate(candidate, event.target.checked)} /><span className="sr-only">Seleccionar {name}</span></label>
            <div className="accounting-candidate-details">
              <div className="accounting-candidate-heading"><Status value={confidence(candidate.confidence)} tone={candidate.confidence === "exact" ? "success" : "review"} /><b>{Math.round(candidate.score * 100)}%</b></div>
              <strong>{name}</strong>
              <span>{taxId || "Sin RUT"} · Documento {document.document_number}</span>
              <span>Emitido {date(document.issued_on)} · vence {date(document.due_on)} · saldo {clp(document.balance_clp)}</span>
              <div className="accounting-match-evidence">{candidate.evidence.map((item) => <small key={item}>{item}</small>)}</div>
            </div>
            <label className={`accounting-allocation-input ${overBalance ? "invalid" : ""}`}><span>Monto a asignar</span><input aria-invalid={overBalance} inputMode="numeric" type="text" value={allocations[candidate.targetId] || ""} placeholder={String(Math.round(candidate.suggestedAmount))} onChange={(event) => setAllocations((current) => ({ ...current, [candidate.targetId]: event.target.value }))} /><small>{overBalance ? "Supera el saldo" : candidate.signals.amount === "partial" ? "Abono parcial" : "Editable"}</small></label>
          </article>;
        })}</div>
        {candidates.length ? <div className="accounting-reconcile-confirm">
          <label><span>Nota de conciliación</span><input maxLength={500} placeholder="Opcional" type="text" value={note} onChange={(event) => setNote(event.target.value)} /></label>
          {(invalidTotal || allocationErrors) ? <div className="accounting-local-error">Revisa los montos: no pueden superar el saldo del movimiento ni el saldo de cada documento.</div> : null}
          <button className="primary-button" disabled={busy === "reconcile" || selectedTotal <= 0 || invalidTotal || allocationErrors} type="button" onClick={() => void confirm()}>{busy === "reconcile" ? "Confirmando…" : `Confirmar ${candidates.filter((candidate) => parseLocalizedNumber(allocations[candidate.targetId] || "0") > 0).length} asignación(es)`}</button>
        </div> : null}
      </> : null}
    </section>
  </div>;
}

function ReceivablesView({ rows }: { rows: AccountingReceivable[] }) {
  const [bucket, setBucket] = useState("all");
  const [query, setQuery] = useState("");
  const [from, setFrom] = useState("2026-01-01");
  const [to, setTo] = useState(today());
  const [status, setStatus] = useState("all");
  const filtered = rows.filter((row) => {
    const matchesQuery = !query || normalize(`${row.customer_name} ${row.customer_tax_id || ""} ${row.document_number}`).includes(normalize(query));
    const matchesDates = (!from || row.issued_on >= from) && (!to || row.issued_on <= to);
    return matchesQuery && matchesDates && (bucket === "all" || agingBucket(row.due_on) === bucket) && (status === "all" || row.status === status);
  });
  return <section className="panel"><div className="accounting-panel-heading"><div><p>Cobranza</p><h2>Cuentas por cobrar</h2><span>Saldo Facto es información operacional; saldo confirmado solo cambia con pagos bancarios conciliados.</span></div><strong>{clp(filtered.reduce((sum, row) => sum + number(row.reported_balance_clp ?? row.balance_clp), 0))}</strong></div><div className="accounting-filter-grid"><SearchField value={query} onChange={setQuery} placeholder="Cliente, RUT o documento" /><label>Emisión desde<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label><label>Emisión hasta<input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label><label>Antigüedad<select value={bucket} onChange={(event) => setBucket(event.target.value)}><option value="all">Todos los vencimientos</option><option value="current">Por vencer</option><option value="1-30">1–30 días</option><option value="31-60">31–60 días</option><option value="61-90">61–90 días</option><option value="91-120">91–120 días</option><option value="120+">Más de 120 días</option></select></label><label>Estado<select value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">Todos</option><option value="pending">Pendiente</option><option value="partial">Pago parcial</option><option value="paid">Pagada</option><option value="overdue">Vencida</option></select></label></div>{filtered.length ? <Table headers={["Cliente", "Documento", "Emisión", "Vencimiento", "Original", "Abonos", "Saldo operativo", "Estado"]}>{filtered.map((row) => { const reported = row.reported_balance_clp !== null; return <tr key={row.id}><td data-label="Cliente"><strong>{row.customer_name}</strong><small>{row.customer_tax_id || ""}</small></td><td data-label="Documento">{row.document_number}</td><td data-label="Emisión">{date(row.issued_on)}</td><td data-label="Vencimiento">{date(row.due_on)}<small>{agingLabel(row.due_on)}</small></td><td data-label="Original">{clp(row.original_amount_clp)}</td><td data-label="Abonos">{clp(reported ? row.reported_paid_amount_clp : row.paid_amount_clp)}<small>{reported ? `Confirmado banco: ${clp(row.paid_amount_clp)}` : "Confirmado"}</small></td><td data-label="Saldo operativo"><strong>{clp(reported ? row.reported_balance_clp : row.balance_clp)}</strong><small>{reported ? `Facto · confirmado: ${clp(row.balance_clp)}` : "Conciliado"}</small></td><td data-label="Estado"><Status value={reported ? "Informado por Facto" : humanize(row.status)} tone={row.status === "paid" ? "success" : agingBucket(row.due_on) === "current" ? "neutral" : "review"} /></td></tr>; })}</Table> : <Empty icon={Search} text="No hay cuentas por cobrar que coincidan con los filtros." />}</section>;
}

function PayablesView({ rows }: { rows: AccountingPayable[] }) {
  const [query, setQuery] = useState("");
  const [from, setFrom] = useState("2026-01-01");
  const [to, setTo] = useState(today());
  const [status, setStatus] = useState("all");
  const filtered = rows.filter((row) => (!query || normalize(`${row.supplier_name} ${row.supplier_tax_id || ""} ${row.document_number}`).includes(normalize(query))) && (!from || row.issued_on >= from) && (!to || row.issued_on <= to) && (status === "all" || row.status === status));
  return <section className="panel"><div className="accounting-panel-heading"><div><p>Obligaciones</p><h2>Cuentas por pagar</h2><span>Incluye documentos Facto y obligaciones verificables, manteniendo separado lo informado de lo conciliado.</span></div><strong>{clp(filtered.reduce((sum, row) => sum + number(row.reported_balance_clp ?? row.balance_clp), 0))}</strong></div><div className="accounting-filter-grid"><SearchField value={query} onChange={setQuery} placeholder="Proveedor, RUT o documento" /><label>Emisión desde<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label><label>Emisión hasta<input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label><label>Estado<select value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">Todos</option><option value="pending">Pendiente</option><option value="partial">Pago parcial</option><option value="paid">Pagada</option><option value="overdue">Vencida</option></select></label></div>{filtered.length ? <Table headers={["Proveedor", "Documento", "Emisión", "Vencimiento", "Original", "Pagado", "Saldo operativo", "Estado"]}>{filtered.map((row) => { const reported = row.reported_balance_clp !== null; return <tr key={row.id}><td data-label="Proveedor"><strong>{row.supplier_name}</strong><small>{row.supplier_tax_id || ""}</small></td><td data-label="Documento">{row.document_number}</td><td data-label="Emisión">{date(row.issued_on)}</td><td data-label="Vencimiento">{date(row.due_on)}<small>{agingLabel(row.due_on)}</small></td><td data-label="Original">{clp(row.original_amount_clp)}</td><td data-label="Pagado">{clp(reported ? row.reported_paid_amount_clp : row.paid_amount_clp)}<small>{reported ? `Confirmado banco: ${clp(row.paid_amount_clp)}` : "Confirmado"}</small></td><td data-label="Saldo operativo"><strong>{clp(reported ? row.reported_balance_clp : row.balance_clp)}</strong><small>{reported ? `Facto · confirmado: ${clp(row.balance_clp)}` : "Conciliado"}</small></td><td data-label="Estado"><Status value={reported ? "Informado por Facto" : humanize(row.status)} tone={row.status === "paid" ? "success" : "review"} /></td></tr>; })}</Table> : <Empty icon={Search} text="No hay cuentas por pagar que coincidan con los filtros." />}</section>;
}

function ChecksView({ data, busy, runAction }: ActionViewProps) {
  const [showForm, setShowForm] = useState(false);
  const [query, setQuery] = useState("");
  const [from, setFrom] = useState("2026-01-01");
  const [to, setTo] = useState(today());
  const [status, setStatus] = useState("all");
  const filtered = data.checks.filter((row) => (!query || normalize(`${row.customer_name} ${row.bank_name} ${row.check_number}`).includes(normalize(query))) && (!from || row.received_on >= from) && (!to || row.received_on <= to) && (status === "all" || row.status === status));
  return <div className="accounting-view-stack"><section className="panel"><div className="accounting-panel-heading"><div><p>Documentos por cobrar</p><h2>Cheques en cartera</h2><span>Banco emisor identifica el cheque; BancoEstado es la cuenta esperada de cobro. Solo la cartola confirmará disponibilidad.</span></div><div className="accounting-source-actions"><strong>{clp(filtered.filter((row) => row.status === "portfolio").reduce((sum, row) => sum + number(row.amount_clp), 0))}</strong><button className="primary-button" type="button" onClick={() => setShowForm(true)}><Plus size={17} /> Registrar cheque</button></div></div><div className="accounting-filter-grid"><SearchField value={query} onChange={setQuery} placeholder="Cliente, banco o número" /><label>Recepción desde<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label><label>Recepción hasta<input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label><label>Estado<select value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">Todos</option><option value="portfolio">En cartera</option><option value="deposited">Depositado</option><option value="collected">Cobrado</option><option value="protested">Protestado</option><option value="voided">Anulado</option></select></label></div>{filtered.length ? <Table headers={["Cliente", "Banco emisor", "Cobro esperado", "N.º cheque", "Recepción", "Vencimiento", "Monto", "Estado"]}>{filtered.map((row) => { const settlement = data.bankAccounts.find((account) => account.id === row.settlement_bank_account_id); return <tr key={row.id}><td data-label="Cliente"><strong>{row.customer_name}</strong></td><td data-label="Banco emisor">{row.bank_name}</td><td data-label="Cobro esperado">{settlement?.institution || (row.import_batch_id ? "BancoEstado" : "Sin asignar")}<small>{settlement?.account_name || "Pendiente de cartola"}</small></td><td data-label="N.º cheque">{row.check_number}</td><td data-label="Recepción">{date(row.received_on)}</td><td data-label="Vencimiento">{date(row.due_on)}</td><td data-label="Monto">{clp(row.amount_clp)}</td><td data-label="Estado"><Status value={row.source_status ? `${humanize(row.status)} · Facto ${row.source_status}` : humanize(row.status)} tone={row.status === "collected" ? "success" : row.status === "protested" ? "danger" : "review"} /></td></tr>; })}</Table> : <Empty icon={FileCheck2} text="No hay cheques que coincidan con los filtros." />}</section>{showForm ? <CheckDialog data={data} busy={busy} close={() => setShowForm(false)} runAction={runAction} /> : null}</div>;
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
function currencyMoney(value: unknown, currency: string) { return new Intl.NumberFormat("es-CL", { style: "currency", currency: currency || "CLP", currencyDisplay: "code", maximumFractionDigits: currency === "CLP" ? 0 : 2 }).format(number(value)); }
function parseLocalizedNumber(value: string) { let text = value.trim().replace(/[^\d,.-]/g, ""); if (!text) return 0; const comma = text.lastIndexOf(","); const dot = text.lastIndexOf("."); if (comma > dot) text = text.replace(/\./g, "").replace(",", "."); else if (dot > comma) text = text.replace(/,/g, ""); else if (comma >= 0) text = text.replace(",", "."); const parsed = Number(text); return Number.isFinite(parsed) ? parsed : 0; }
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
function factoProfileLabel(value: string) { return factoExcelProfiles.find((item) => item.id === value)?.label || humanize(value); }
function factoPreviewColumns(profile: AccountingFactoExcelProfile): { headers: string[]; values: (data: Record<string, unknown>) => React.ReactNode[] } {
  if (profile === "facto_unpaid_documents") return {
    headers: ["Documento", "Fecha", "Contraparte", "Total", "Pagado Facto", "Impago Facto"],
    values: (data) => [String(data.document_type_label || "—"), `${data.document_number || "—"}`, String(data.counterpart_name || "—"), clp(data.total_clp), clp(data.reported_paid_clp), clp(data.reported_balance_clp)],
  };
  if (profile === "facto_checks_banco_estado") return {
    headers: ["Cliente", "Banco emisor", "N.º cheque", "Cobro", "Monto", "Cuenta esperada"],
    values: (data) => [String(data.customer_name || "—"), String(data.issuer_bank || "—"), String(data.check_number || "—"), date(String(data.due_on || "")), clp(data.amount_clp), String(data.settlement_institution || "BancoEstado")],
  };
  return {
    headers: ["Fecha", "Documento", "Método", "Responsable", "Monto", "Cuenta esperada"],
    values: (data) => [date(String(data.event_date || "")), `${data.document_type_label || "Documento"} ${data.document_number || ""}`, String(data.payment_method || "—"), String(data.responsible || "—"), clp(data.signed_amount_clp), String(data.expected_institution || "Por determinar")],
  };
}
