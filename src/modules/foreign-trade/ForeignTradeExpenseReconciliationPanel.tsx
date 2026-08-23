import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  FileCheck2,
  Landmark,
  LoaderCircle,
  Plus,
  ReceiptText,
  RefreshCw,
  Save,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import {
  applyForeignTradeExpenseReconciliation,
  autoFinalizeForeignTradeOperation,
  getForeignTradeDocuments,
  getForeignTradeExpenseReconciliations,
  saveForeignTradeExpenseReconciliation,
} from "../../lib/foreignTradeApi";
import type {
  ForeignTradeCostCategory,
  ForeignTradeCostLine,
  ForeignTradeDocument,
  ForeignTradeExpenseReconciliation,
  ForeignTradeReconciliationLineType,
  SaveForeignTradeExpenseReconciliationInput,
} from "../../types/foreignTrade";
import { calculateForeignTradeReconciliation } from "./foreignTradeReconciliationEngine";

type DraftLine = SaveForeignTradeExpenseReconciliationInput["lines"][number];
type Draft = Omit<SaveForeignTradeExpenseReconciliationInput, "lines"> & { lines: DraftLine[] };

const lineTypes: Array<{ value: ForeignTradeReconciliationLineType; label: string; category: ForeignTradeCostCategory }> = [
  { value: "operating_expense", label: "Gasto operativo", category: "chile_port" },
  { value: "agency_fee", label: "Honorario / gasto agencia", category: "customs_agency" },
  { value: "customs_duty", label: "Derecho aduanero", category: "duties" },
  { value: "import_vat", label: "IVA importación", category: "taxes" },
  { value: "adjustment", label: "Ajuste documentado", category: "other" },
];

const costCategories: Array<{ value: ForeignTradeCostCategory; label: string }> = [
  { value: "origin", label: "Origen" },
  { value: "international_freight", label: "Flete internacional" },
  { value: "insurance", label: "Seguro" },
  { value: "chile_port", label: "Puerto Chile" },
  { value: "storage", label: "Almacenaje" },
  { value: "customs_agency", label: "Agencia de aduana" },
  { value: "national_transport", label: "Transporte a bodega" },
  { value: "inspection", label: "Inspección" },
  { value: "certificate", label: "Certificados" },
  { value: "duties", label: "Derechos" },
  { value: "taxes", label: "Impuestos" },
  { value: "supplier_charge", label: "Cargo proveedor" },
  { value: "other", label: "Otro" },
];

export function ForeignTradeExpenseReconciliationPanel({
  operationId,
  costs,
  onChanged,
}: {
  operationId: string;
  costs: ForeignTradeCostLine[];
  onChanged: (message: string) => Promise<void>;
}) {
  const [reconciliations, setReconciliations] = useState<ForeignTradeExpenseReconciliation[]>([]);
  const [documents, setDocuments] = useState<ForeignTradeDocument[]>([]);
  const [draft, setDraft] = useState<Draft>(() => emptyDraft(operationId, costs));
  const [selectedId, setSelectedId] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"save" | "apply" | "sync" | "">("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const automaticSyncAttempt = useRef("");

  const load = useCallback(async (preferredId?: string) => {
    setLoading(true);
    try {
      const [nextReconciliations, nextDocuments] = await Promise.all([
        getForeignTradeExpenseReconciliations(operationId),
        getForeignTradeDocuments(operationId),
      ]);
      setReconciliations(nextReconciliations);
      setDocuments(nextDocuments);
      const targetId = preferredId || selectedId;
      const target = nextReconciliations.find((item) => item.id === targetId);
      if (target) {
        setSelectedId(target.id);
        setDraft(draftFromReconciliation(target));
      }
      setError("");
      return nextReconciliations;
    } catch (loadError) {
      setError(humanizeError(loadError));
      return [];
    } finally {
      setLoading(false);
    }
  }, [operationId, selectedId]);

  useEffect(() => { void load(); }, [operationId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (automaticSyncAttempt.current === operationId) return;
    automaticSyncAttempt.current = operationId;
    void synchronizeDocuments(true);
  }, [operationId]); // eslint-disable-line react-hooks/exhaustive-deps

  const calculation = useMemo(() => calculateForeignTradeReconciliation(
    draft.remittance_amount_clp,
    draft.refund_received_clp,
    draft.lines,
  ), [draft.lines, draft.refund_received_clp, draft.remittance_amount_clp]);

  const referencesDiffer = Boolean(
    draft.provision_reference?.trim() &&
    draft.final_reference?.trim() &&
    draft.provision_reference.trim().toLowerCase() !== draft.final_reference.trim().toLowerCase(),
  );
  const estimateCandidates = costs.filter((cost) =>
    !["duties", "taxes"].includes(cost.category) &&
    (!cost.metadata?.excluded_from_costing || cost.id === draft.general_estimate_cost_line_id),
  );

  function startNew() {
    setSelectedId("");
    setDraft(emptyDraft(operationId, costs));
    setError("");
    setMessage("");
  }

  function selectReconciliation(item: ForeignTradeExpenseReconciliation) {
    setSelectedId(item.id);
    setDraft(draftFromReconciliation(item));
    setError("");
    setMessage("");
  }

  function updateLine(index: number, patch: Partial<DraftLine>) {
    setDraft((current) => ({
      ...current,
      lines: current.lines.map((line, lineIndex) => {
        if (lineIndex !== index) return line;
        const next = { ...line, ...patch };
        if ("actual_net_clp" in patch || "actual_vat_clp" in patch) {
          next.actual_total_clp = sumMoney(next.actual_net_clp, next.actual_vat_clp);
        }
        if ("provision_net_clp" in patch || "provision_vat_clp" in patch) {
          next.provision_total_clp = sumMoney(next.provision_net_clp, next.provision_vat_clp);
        }
        return next;
      }),
    }));
  }

  function updateLineCurrency(index: number, side: "provision" | "actual", currency: string) {
    const normalized = cleanCurrency(currency);
    updateLine(index, side === "provision"
      ? { provision_currency: normalized, provision_exchange_rate_clp: normalized === "CLP" ? "1" : "" }
      : { actual_currency: normalized, actual_exchange_rate_clp: normalized === "CLP" ? "1" : "" });
  }

  function changeLineType(index: number, type: ForeignTradeReconciliationLineType) {
    const definition = lineTypes.find((item) => item.value === type)!;
    updateLine(index, {
      line_type: type,
      cost_category: definition.category,
      recoverable_tax: type === "import_vat",
    });
  }

  function addLine(type: ForeignTradeReconciliationLineType) {
    setDraft((current) => ({ ...current, lines: [...current.lines, emptyLine(type, current.lines.length)] }));
  }

  function removeLine(index: number) {
    setDraft((current) => ({ ...current, lines: current.lines.filter((_, lineIndex) => lineIndex !== index) }));
  }

  function validate() {
    if (draft.title.trim().length < 2) throw new Error("Escribe un nombre para la conciliación.");
    if (!draft.lines.length) throw new Error("Agrega al menos un gasto o tributo documentado.");
    if (draft.lines.some((line) => line.concept.trim().length < 2)) throw new Error("Cada fila necesita un concepto identificable.");
    if (draft.lines.some((line) => requiresExchangeRateOrDeclaredTotal(line, "actual"))) {
      throw new Error("Para cada monto real en moneda extranjera ingresa el tipo de cambio del documento o el total CLP declarado.");
    }
    if (draft.lines.some((line) => requiresExchangeRateOrDeclaredTotal(line, "provision"))) {
      throw new Error("Para cada provisión en moneda extranjera ingresa el tipo de cambio o el total CLP declarado.");
    }
    if (referencesDiffer && !draft.identity_confirmed) throw new Error("Las referencias no coinciden. Confirma expresamente la identidad antes de continuar.");
  }

  async function persist() {
    validate();
    const id = await saveForeignTradeExpenseReconciliation({ ...draft, status: "reviewed" });
    setSelectedId(id);
    setDraft((current) => ({ ...current, id }));
    return id;
  }

  async function save() {
    setBusy("save"); setError(""); setMessage("");
    try {
      const id = await persist();
      await load(id);
      setMessage("Conciliación guardada. Los costos oficiales todavía no fueron reemplazados.");
    } catch (saveError) { setError(humanizeError(saveError)); }
    finally { setBusy(""); }
  }

  async function applyActualValues() {
    if (!window.confirm("¿Aplicar los valores reales? La estimación general seleccionada quedará excluida del costeo, pero conservará su historial.")) return;
    setBusy("apply"); setError(""); setMessage("");
    try {
      const id = await persist();
      const result = await applyForeignTradeExpenseReconciliation(id);
      await load(id);
      await onChanged(`Rendición aplicada: ${result.applied_lines} concepto(s) reales. Saldo por devolver: ${formatClp(result.refund_due_clp)}.`);
      setMessage("Valores reales aplicados con trazabilidad. La provisión histórica permanece disponible.");
    } catch (applyError) { setError(humanizeError(applyError)); }
    finally { setBusy(""); }
  }

  async function synchronizeDocuments(silent = false) {
    if (!silent) { setBusy("sync"); setError(""); setMessage(""); }
    try {
      const result = await autoFinalizeForeignTradeOperation(operationId);
      const next = await load(selectedId);
      if (result.applied_reconciliations > 0) {
        const targetId = result.results[result.results.length - 1]?.reconciliation_id;
        const target = next.find((item) => item.id === targetId) || next[0];
        if (target) { setSelectedId(target.id); setDraft(draftFromReconciliation(target)); }
        await onChanged(`Conciliación automática completada: ${result.applied_lines} costo(s) real(es) incorporados al costeo y precios recalculados.`);
      }
      if (!silent || result.processed_reconciliations > 0) {
        setMessage(result.processed_reconciliations > 0
          ? `${result.processed_reconciliations} conciliación(es) actualizadas desde sus documentos confirmados.`
          : "Las conciliaciones ya están sincronizadas con sus documentos.");
      }
    } catch (syncError) {
      const text = humanizeError(syncError);
      if (!silent || !text.includes("Fase 8")) setError(text);
    } finally {
      if (!silent) setBusy("");
    }
  }

  if (loading && !reconciliations.length) {
    return <div className="panel foreign-trade-loading"><LoaderCircle className="spin" size={25} /><strong>Cargando conciliación</strong><span>Provisiones, respaldos y valores reales.</span></div>;
  }

  return <div className="foreign-trade-reconciliation-layout">
    <aside className="panel foreign-trade-reconciliation-list">
      <header><div><span>Rendiciones</span><strong>Historial de conciliaciones</strong></div><button className="icon-button" type="button" title="Actualizar" onClick={() => void load()}><RefreshCw className={loading ? "spin" : ""} size={16} /></button></header>
      <button className="primary-button" type="button" onClick={startNew}><Plus size={16} /> Nueva conciliación</button>
      <div>
        {reconciliations.map((item) => <button className={selectedId === item.id ? "active" : ""} type="button" key={item.id} onClick={() => selectReconciliation(item)}>
          <span><strong>{item.title}</strong><small>{item.agency_invoice_number ? `Factura ${item.agency_invoice_number}` : "Sin factura final"}</small></span>
          <em className={`foreign-trade-reconciliation-status ${item.status}`}>{statusLabel(item.status)}</em>
          <b>{item.totals.refund_due_clp > 0 ? `${formatClp(item.totals.refund_due_clp)} por devolver` : formatClp(item.totals.actual_total_clp)}</b>
        </button>)}
        {!reconciliations.length ? <p>Aún no hay rendiciones. Crea una para comparar el depósito con los documentos finales.</p> : null}
      </div>
    </aside>

    <section className="foreign-trade-reconciliation-main">
      <article className="panel foreign-trade-reconciliation-header">
        <div className="foreign-trade-detail-panel-heading"><div><h2>Provisión versus rendición final</h2><p>Los gastos operativos y los tributos se concilian por separado.</p></div><div><button className="ghost-button" type="button" disabled={Boolean(busy)} onClick={() => void synchronizeDocuments()}>{busy === "sync" ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />} Actualizar desde documentos</button><span className="foreign-trade-private-badge"><FileCheck2 size={15} /> Auditable</span></div></div>
        <div className="foreign-trade-reconciliation-form">
          <label className="wide"><span>Nombre</span><input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
          <label><span>Agencia</span><input value={draft.agency_name || ""} onChange={(event) => setDraft({ ...draft, agency_name: event.target.value })} /></label>
          <label><span>Factura final</span><input value={draft.agency_invoice_number || ""} onChange={(event) => setDraft({ ...draft, agency_invoice_number: event.target.value })} /></label>
          <label><span>Referencia provisión</span><input value={draft.provision_reference || ""} onChange={(event) => setDraft({ ...draft, provision_reference: event.target.value, identity_confirmed: false })} placeholder="Despacho / referencia" /></label>
          <label><span>Referencia final</span><input value={draft.final_reference || ""} onChange={(event) => setDraft({ ...draft, final_reference: event.target.value, identity_confirmed: false })} placeholder="Despacho / referencia" /></label>
          <label><span>Solicitud de fondos</span><select value={draft.provision_document_id || ""} onChange={(event) => setDraft({ ...draft, provision_document_id: event.target.value || null })}><option value="">Sin vincular</option>{documents.filter((document) => document.document_type === "fund_request" || document.document_type === "other").map((document) => <option key={document.id} value={document.id}>{document.original_file_name}</option>)}</select></label>
          <label><span>Rendición / factura final</span><select value={draft.final_document_id || ""} onChange={(event) => setDraft({ ...draft, final_document_id: event.target.value || null })}><option value="">Sin vincular</option>{documents.filter((document) => ["agency_settlement", "commercial_invoice", "other"].includes(document.document_type)).map((document) => <option key={document.id} value={document.id}>{document.original_file_name}</option>)}</select></label>
          <label><span>Gasto general que reemplaza</span><select value={draft.general_estimate_cost_line_id || ""} onChange={(event) => setDraft({ ...draft, general_estimate_cost_line_id: event.target.value || null })}><option value="">No reemplazar automáticamente</option>{estimateCandidates.map((cost) => <option key={cost.id} value={cost.id}>{cost.name} · {cost.amount_clp === null ? "sin CLP" : formatClp(cost.amount_clp)}</option>)}</select></label>
          <label><span>Fecha depósito</span><input type="date" value={draft.remittance_date || ""} onChange={(event) => setDraft({ ...draft, remittance_date: event.target.value || null })} /></label>
          <label><span>Fecha rendición</span><input type="date" value={draft.final_invoice_date || ""} onChange={(event) => setDraft({ ...draft, final_invoice_date: event.target.value || null })} /></label>
          <label><span>Monto depositado CLP</span><input inputMode="decimal" value={draft.remittance_amount_clp} onChange={(event) => setDraft({ ...draft, remittance_amount_clp: cleanMoney(event.target.value) })} /></label>
          <label><span>Devolución ya recibida CLP</span><input inputMode="decimal" value={draft.refund_received_clp} onChange={(event) => setDraft({ ...draft, refund_received_clp: cleanMoney(event.target.value) })} /></label>
          <label><span>Fecha devolución</span><input type="date" value={draft.refund_received_at || ""} onChange={(event) => setDraft({ ...draft, refund_received_at: event.target.value || null })} /></label>
          <label className="wide"><span>Notas internas</span><textarea value={draft.notes || ""} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} /></label>
        </div>
        {referencesDiffer ? <div className="notice-banner warning"><ShieldAlert size={18} /><div><strong>Las referencias no coinciden</strong><span>No apliques la rendición hasta comprobar que ambos documentos pertenecen al mismo despacho.</span><label className="foreign-trade-checkbox-field"><input type="checkbox" checked={draft.identity_confirmed} onChange={(event) => setDraft({ ...draft, identity_confirmed: event.target.checked })} /><span>Verifiqué manualmente que corresponden a la misma operación</span></label></div></div> : null}
      </article>

      <section className="foreign-trade-reconciliation-kpis">
        <ReconciliationKpi icon={<Landmark />} label="Depósito" value={formatClp(Number(draft.remittance_amount_clp || 0))} detail="Fondos entregados a la agencia" />
        <ReconciliationKpi icon={<ReceiptText />} label="Gastos reales" value={formatClp(calculation.actualExpensesClp)} detail={`Provisión: ${formatClp(calculation.provisionExpensesClp)}`} />
        <ReconciliationKpi icon={<FileCheck2 />} label="Tributos reales" value={formatClp(calculation.actualTaxesClp)} detail="Derechos e IVA importación" />
        <ReconciliationKpi icon={calculation.refundDueClp > 0 ? <AlertTriangle /> : <CheckCircle2 />} label={calculation.additionalPaymentClp > 0 ? "Pago adicional" : "Saldo por devolver"} value={formatClp(calculation.additionalPaymentClp || calculation.refundDueClp)} detail={calculation.refundReceivedClp ? `${formatClp(calculation.refundReceivedClp)} ya recibido` : "Pendiente de conciliación"} warning={calculation.refundDueClp > 0 || calculation.additionalPaymentClp > 0} />
      </section>

      <article className="panel foreign-trade-reconciliation-table-panel">
        <header className="foreign-trade-detail-panel-heading"><div><h2>Detalle ajustable</h2><p>Cada fila conserva proveedor, factura y página de respaldo.</p></div><div><button className="ghost-button" type="button" onClick={() => addLine("operating_expense")}><Plus size={15} /> Gasto</button><button className="ghost-button" type="button" onClick={() => addLine("customs_duty")}><Plus size={15} /> Tributo</button></div></header>
        <datalist id="foreign-trade-currencies"><option value="CLP" /><option value="USD" /><option value="EUR" /><option value="CNY" /></datalist>
        <div className="table-scroll"><table className="foreign-trade-reconciliation-table"><thead><tr><th>Concepto y respaldo</th><th>Clasificación</th><th>Provisión y origen</th><th>Neto real CLP</th><th>IVA real CLP</th><th>Total real y origen</th><th>Diferencia</th><th>Costeo</th><th aria-label="Acciones" /></tr></thead><tbody>
          {draft.lines.map((line, index) => <tr key={line.id || `new-${index}`} className={isTax(line.line_type) ? "tax" : "expense"}>
            <td><input className="concept" value={line.concept} onChange={(event) => updateLine(index, { concept: event.target.value })} placeholder="Ej. movilización puerto" /><div className="foreign-trade-reconciliation-source"><input value={line.provider_name || ""} onChange={(event) => updateLine(index, { provider_name: event.target.value })} placeholder="Proveedor" /><input value={line.document_number || ""} onChange={(event) => updateLine(index, { document_number: event.target.value })} placeholder="Factura" /><input inputMode="numeric" value={line.source_page ?? ""} onChange={(event) => updateLine(index, { source_page: event.target.value })} placeholder="Pág." /></div></td>
            <td><select value={line.line_type} onChange={(event) => changeLineType(index, event.target.value as ForeignTradeReconciliationLineType)}>{lineTypes.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select><select value={line.cost_category} onChange={(event) => updateLine(index, { cost_category: event.target.value as ForeignTradeCostCategory })}>{costCategories.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></td>
            <SourceMoneyCell
              totalClp={line.provision_total_clp}
              amountOriginal={line.provision_amount_original}
              currency={line.provision_currency}
              exchangeRateClp={line.provision_exchange_rate_clp}
              convertedClp={calculation.lineConversions[index]?.provisionConvertedClp ?? null}
              impliedExchangeRateClp={calculation.lineConversions[index]?.provisionImpliedExchangeRateClp ?? null}
              onTotalChange={(value) => updateLine(index, { provision_total_clp: value })}
              onAmountChange={(value) => updateLine(index, { provision_amount_original: value })}
              onCurrencyChange={(value) => updateLineCurrency(index, "provision", value)}
              onRateChange={(value) => updateLine(index, { provision_exchange_rate_clp: value })}
            />
            <MoneyCell value={line.actual_net_clp} onChange={(value) => updateLine(index, { actual_net_clp: value })} />
            <MoneyCell value={line.actual_vat_clp} onChange={(value) => updateLine(index, { actual_vat_clp: value })} />
            <SourceMoneyCell
              totalClp={line.actual_total_clp}
              amountOriginal={line.actual_amount_original}
              currency={line.actual_currency}
              exchangeRateClp={line.actual_exchange_rate_clp}
              convertedClp={calculation.lineConversions[index]?.actualConvertedClp ?? null}
              impliedExchangeRateClp={calculation.lineConversions[index]?.actualImpliedExchangeRateClp ?? null}
              appliedTotalClp={calculation.lineConversions[index]?.actualAppliedTotalClp ?? 0}
              conversionVarianceClp={calculation.lineConversions[index]?.conversionVarianceClp ?? null}
              onTotalChange={(value) => updateLine(index, { actual_total_clp: value })}
              onAmountChange={(value) => updateLine(index, { actual_amount_original: value })}
              onCurrencyChange={(value) => updateLineCurrency(index, "actual", value)}
              onRateChange={(value) => updateLine(index, { actual_exchange_rate_clp: value })}
              strong
            />
            <td className={calculation.lineDifferences[index] < 0 ? "negative" : "positive"}><strong>{formatClp(calculation.lineDifferences[index] || 0)}</strong><small>{calculation.lineDifferences[index] < 0 ? "Mayor gasto real" : "Saldo favorable"}</small></td>
            <td><label className="foreign-trade-mini-check"><input type="checkbox" checked={line.include_in_costing} onChange={(event) => updateLine(index, { include_in_costing: event.target.checked })} /> Incluir</label>{!isTax(line.line_type) ? <label className="foreign-trade-mini-check"><input type="checkbox" checked={line.recoverable_tax} onChange={(event) => updateLine(index, { recoverable_tax: event.target.checked })} /> IVA recuperable</label> : <small>Tributo separado</small>}</td>
            <td><button className="icon-button danger" type="button" title="Eliminar fila" onClick={() => removeLine(index)}><Trash2 size={15} /></button></td>
          </tr>)}
        </tbody></table></div>
        {!draft.lines.length ? <div className="empty-state"><ReceiptText size={26} /><strong>Sin detalle</strong><span>Agrega los gastos y tributos indicados en la rendición.</span></div> : null}
        <footer className="foreign-trade-reconciliation-actions">
          <div><strong>Total rendido: {formatClp(calculation.actualTotalClp)}</strong><span>Gastos {formatClp(calculation.actualExpensesClp)} · tributos {formatClp(calculation.actualTaxesClp)}</span></div>
          <button className="ghost-button" type="button" disabled={Boolean(busy)} onClick={() => void save()}>{busy === "save" ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />} Guardar revisión</button>
          <button className="primary-button" type="button" disabled={Boolean(busy)} onClick={() => void applyActualValues()}>{busy === "apply" ? <LoaderCircle className="spin" size={16} /> : <FileCheck2 size={16} />} Aplicar valores reales</button>
        </footer>
        {message ? <div className="notice-banner success"><CheckCircle2 size={17} /> {message}</div> : null}
        {error ? <div className="notice-banner error"><AlertTriangle size={17} /> {error}</div> : null}
      </article>
    </section>
  </div>;
}

function MoneyCell({ value, onChange, strong = false }: { value: string | number; onChange: (value: string) => void; strong?: boolean }) {
  return <td><input className={strong ? "strong" : ""} inputMode="decimal" value={value} onChange={(event) => onChange(cleanMoney(event.target.value))} /></td>;
}

function SourceMoneyCell({
  totalClp,
  amountOriginal,
  currency,
  exchangeRateClp,
  convertedClp,
  impliedExchangeRateClp,
  appliedTotalClp,
  conversionVarianceClp,
  onTotalChange,
  onAmountChange,
  onCurrencyChange,
  onRateChange,
  strong = false,
}: {
  totalClp: string | number;
  amountOriginal: string | number;
  currency: string;
  exchangeRateClp?: string | number | null;
  convertedClp: number | null;
  impliedExchangeRateClp: number | null;
  appliedTotalClp?: number;
  conversionVarianceClp?: number | null;
  onTotalChange: (value: string) => void;
  onAmountChange: (value: string) => void;
  onCurrencyChange: (value: string) => void;
  onRateChange: (value: string) => void;
  strong?: boolean;
}) {
  const isClp = currency === "CLP";
  const hasVariance = conversionVarianceClp != null && Math.abs(conversionVarianceClp) >= 1;
  return <td className="foreign-trade-source-money-cell">
    <label><span>Total declarado CLP</span><input className={strong ? "strong" : ""} inputMode="decimal" value={totalClp} onChange={(event) => onTotalChange(cleanMoney(event.target.value))} /></label>
    <div className="foreign-trade-source-money-grid">
      <label><span>Monto original</span><input inputMode="decimal" value={amountOriginal} onChange={(event) => onAmountChange(cleanDecimal(event.target.value, 6))} /></label>
      <label><span>Moneda</span><input list="foreign-trade-currencies" maxLength={3} value={currency} onChange={(event) => onCurrencyChange(event.target.value)} /></label>
      <label><span>TC documento</span><input disabled={isClp} inputMode="decimal" value={isClp ? "1" : exchangeRateClp ?? ""} onChange={(event) => onRateChange(cleanDecimal(event.target.value, 6))} /></label>
    </div>
    {convertedClp !== null ? <small className={hasVariance ? "conversion-warning" : "conversion-ok"}>Calculado: {formatClp(convertedClp)}{conversionVarianceClp == null ? "" : hasVariance ? ` · diferencia ${formatClp(conversionVarianceClp || 0)}` : " · coincide"}</small> : null}
    {impliedExchangeRateClp !== null ? <small>TC implícito según total declarado: {formatExchangeRate(impliedExchangeRateClp)}</small> : null}
    {!Number(totalClp || 0) && appliedTotalClp ? <small>Se aplicará {formatClp(appliedTotalClp)} desde monto original y TC.</small> : null}
  </td>;
}

function ReconciliationKpi({ icon, label, value, detail, warning = false }: { icon: React.ReactNode; label: string; value: string; detail: string; warning?: boolean }) {
  return <article className={warning ? "warning" : ""}><div>{icon}<span>{label}</span></div><strong>{value}</strong><small>{detail}</small></article>;
}

function emptyDraft(operationId: string, costs: ForeignTradeCostLine[]): Draft {
  const likelyEstimate = costs.find((cost) => !["duties", "taxes"].includes(cost.category) && cost.source_type === "estimated" && !cost.metadata?.excluded_from_costing);
  return {
    operation_id: operationId,
    title: "Conciliación de agencia",
    agency_name: "",
    provision_document_id: null,
    final_document_id: null,
    general_estimate_cost_line_id: likelyEstimate?.id || null,
    provision_reference: "",
    final_reference: "",
    agency_invoice_number: "",
    remittance_date: null,
    final_invoice_date: null,
    remittance_amount_clp: "0",
    refund_received_clp: "0",
    refund_received_at: null,
    status: "draft",
    identity_confirmed: false,
    notes: "",
    metadata: {},
    lines: [emptyLine("operating_expense", 0)],
  };
}

function emptyLine(type: ForeignTradeReconciliationLineType, position: number): DraftLine {
  const definition = lineTypes.find((item) => item.value === type)!;
  return {
    position,
    line_type: type,
    cost_category: definition.category,
    concept: "",
    provider_name: "",
    document_number: "",
    document_date: null,
    source_page: null,
    provision_cost_line_id: null,
    provision_net_clp: "0",
    provision_vat_clp: "0",
    provision_total_clp: "0",
    provision_amount_original: "0",
    provision_currency: "CLP",
    provision_exchange_rate_clp: "1",
    actual_net_clp: "0",
    actual_vat_clp: "0",
    actual_total_clp: "0",
    actual_amount_original: "0",
    actual_currency: "CLP",
    actual_exchange_rate_clp: "1",
    recoverable_tax: type === "import_vat",
    include_in_costing: true,
    notes: "",
    metadata: {},
  };
}

function draftFromReconciliation(item: ForeignTradeExpenseReconciliation): Draft {
  return {
    id: item.id,
    operation_id: item.operation_id,
    title: item.title,
    agency_name: item.agency_name || "",
    provision_document_id: item.provision_document_id,
    final_document_id: item.final_document_id,
    general_estimate_cost_line_id: item.general_estimate_cost_line_id,
    provision_reference: item.provision_reference || "",
    final_reference: item.final_reference || "",
    agency_invoice_number: item.agency_invoice_number || "",
    remittance_date: item.remittance_date,
    final_invoice_date: item.final_invoice_date,
    remittance_amount_clp: String(item.remittance_amount_clp),
    refund_received_clp: String(item.refund_received_clp),
    refund_received_at: item.refund_received_at,
    status: item.status === "draft" ? "draft" : "reviewed",
    identity_confirmed: item.identity_confirmed,
    notes: item.notes || "",
    metadata: item.metadata || {},
    lines: item.lines.map((line) => ({
      id: line.id,
      position: line.position,
      line_type: line.line_type,
      cost_category: line.cost_category,
      concept: line.concept,
      provider_name: line.provider_name || "",
      document_number: line.document_number || "",
      document_date: line.document_date,
      source_page: line.source_page,
      provision_cost_line_id: line.provision_cost_line_id,
      provision_net_clp: String(line.provision_net_clp),
      provision_vat_clp: String(line.provision_vat_clp),
      provision_total_clp: String(line.provision_total_clp),
      provision_amount_original: String(line.provision_amount_original),
      provision_currency: line.provision_currency || "CLP",
      provision_exchange_rate_clp: line.provision_exchange_rate_clp === null ? "" : String(line.provision_exchange_rate_clp),
      actual_net_clp: String(line.actual_net_clp),
      actual_vat_clp: String(line.actual_vat_clp),
      actual_total_clp: String(line.actual_total_clp),
      actual_amount_original: String(line.actual_amount_original),
      actual_currency: line.actual_currency || "CLP",
      actual_exchange_rate_clp: line.actual_exchange_rate_clp === null ? "" : String(line.actual_exchange_rate_clp),
      recoverable_tax: line.recoverable_tax,
      include_in_costing: line.include_in_costing,
      notes: line.notes || "",
      metadata: line.metadata || {},
    })),
  };
}

function isTax(type: ForeignTradeReconciliationLineType) { return type === "customs_duty" || type === "import_vat"; }
function sumMoney(first: string | number, second: string | number) { return String(Number(first || 0) + Number(second || 0)); }
function cleanMoney(value: string) {
  const normalized = value.replace(/[^\d.,]/g, "").replace(/,/g, ".");
  const [integer = "", ...decimalParts] = normalized.split(".");
  return decimalParts.length ? `${integer}.${decimalParts.join("").slice(0, 2)}` : integer;
}
function cleanDecimal(value: string, scale: number) {
  const normalized = value.replace(/[^\d.,]/g, "").replace(/,/g, ".");
  const [integer = "", ...decimalParts] = normalized.split(".");
  return decimalParts.length ? `${integer}.${decimalParts.join("").slice(0, scale)}` : integer;
}
function cleanCurrency(value: string) { return value.replace(/[^a-zA-Z]/g, "").slice(0, 3).toUpperCase(); }
function requiresExchangeRateOrDeclaredTotal(line: DraftLine, side: "provision" | "actual") {
  const currency = side === "provision" ? line.provision_currency : line.actual_currency;
  const amount = Number(side === "provision" ? line.provision_amount_original : line.actual_amount_original);
  const rate = Number(side === "provision" ? line.provision_exchange_rate_clp : line.actual_exchange_rate_clp);
  const total = Number(side === "provision" ? line.provision_total_clp : line.actual_total_clp);
  return currency !== "CLP" && amount > 0 && rate <= 0 && total <= 0;
}
function statusLabel(status: ForeignTradeExpenseReconciliation["status"]) { return ({ draft: "Borrador", reviewed: "Revisada", applied: "Aplicada", refund_pending: "Devolución pendiente", settled: "Cerrada" })[status]; }
function humanizeError(error: unknown) { const message = error instanceof Error ? error.message : "No se pudo completar la conciliación."; if (message.includes("identity_mismatch")) return "Las referencias no coinciden. Verifica que la provisión y la factura final sean del mismo despacho."; if (message.includes("foreign_trade_forbidden")) return "Tu usuario no tiene permisos para modificar costos de Comercio Exterior."; if (message.includes("auto_finalize_foreign_trade") || message.includes("phase8")) return "Falta ejecutar la Fase 8 de conciliación automática en Supabase."; if (message.includes("phase5") || message.includes("does not exist") || message.includes("404")) return "Falta ejecutar supabase/foreign_trade_center_phase5_reconciliation.sql en Supabase."; if (message.includes("foreign_trade_invalid")) return "Revisa los documentos vinculados, conceptos y montos ingresados."; return message; }

const clpFormatter = new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 });
function formatClp(value: number) { return clpFormatter.format(Number(value || 0)); }
const exchangeRateFormatter = new Intl.NumberFormat("es-CL", { minimumFractionDigits: 0, maximumFractionDigits: 6 });
function formatExchangeRate(value: number) { return `$${exchangeRateFormatter.format(Number(value || 0))} CLP`; }
