import { useMemo, useRef, useState } from "react";
import { AlertTriangle, Calculator, CheckCircle2, ChevronLeft, ChevronRight, FileSpreadsheet, Landmark, PackageCheck, Save, WalletCards } from "lucide-react";
import { saveForeignTradeCostingScenario } from "../../lib/foreignTradeApi";
import type {
  ForeignTradeCostParameter,
  ForeignTradeCostingAssumptions,
  ForeignTradeOperationDetail,
  ForeignTradeScenario,
} from "../../types/foreignTrade";
import {
  calculateForeignTradeCosting,
  type ForeignTradeAllocationMethod,
  type ForeignTradePricingMethod,
} from "./foreignTradeCostEngine";
import { exportForeignTradeCostingExcel } from "./foreignTradeCostingExport";

type CostingForm = {
  exchangeRateClp: string;
  cifTotalOriginal: string;
  generalDutyPercent: string;
  importVatPercent: string;
  salesVatPercent: string;
  importVatRecoverable: boolean;
  pricingMethod: ForeignTradePricingMethod;
  targetPercent: string;
  allocationMethod: ForeignTradeAllocationMethod;
  lineDutyPercent: Record<string, string>;
  lineTargetPercent: Record<string, string>;
};

export function ForeignTradeCostingPanel({
  detail,
  costParameters,
  onSaved,
}: {
  detail: ForeignTradeOperationDetail;
  costParameters: ForeignTradeCostParameter[];
  onSaved: (message: string) => Promise<void>;
}) {
  const baseline = detail.scenarios.find((scenario) => scenario.status === "baseline") || detail.scenarios[0] || null;
  const [form, setForm] = useState<CostingForm>(() => initialForm(detail, baseline, costParameters));
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const costingTableScrollRef = useRef<HTMLDivElement>(null);

  const scrollCostingTable = (direction: -1 | 1) => {
    const container = costingTableScrollRef.current;
    if (!container) return;
    container.scrollBy({
      behavior: "smooth",
      left: direction * Math.max(480, container.clientWidth * 0.72),
    });
  };

  const settings = useMemo(() => ({
    exchangeRateClp: numberValue(form.exchangeRateClp),
    cifOverrideOriginal: form.cifTotalOriginal.trim() ? numberValue(form.cifTotalOriginal) : null,
    generalDutyPercent: numberValue(form.generalDutyPercent),
    importVatPercent: numberValue(form.importVatPercent),
    salesVatPercent: numberValue(form.salesVatPercent),
    importVatRecoverable: form.importVatRecoverable,
    pricingMethod: form.pricingMethod,
    targetPercent: numberValue(form.targetPercent),
    allocationMethod: form.allocationMethod,
    lineDutyPercent: numberRecord(form.lineDutyPercent),
    lineTargetPercent: numberRecord(form.lineTargetPercent),
  }), [form]);

  const result = useMemo(
    () => calculateForeignTradeCosting(detail.lines, detail.costs, settings),
    [detail.costs, detail.lines, settings],
  );
  const includedOperatingCosts = useMemo(() => detail.costs.filter((cost) => (
    !Boolean(cost.metadata?.excluded_from_costing)
    && !["merchandise", "duties", "taxes", "international_freight", "insurance"].includes(cost.category)
    && Number(cost.amount_clp || 0) > 0
  )), [detail.costs]);

  const hasConfiguredLegalRates = ["cl_general_ad_valorem", "cl_import_vat", "cl_sales_vat"]
    .every((code) => costParameters.some((parameter) => parameter.code === code && parameter.active));

  async function saveScenario() {
    setSaving(true);
    setError("");
    setSaved("");
    try {
      const assumptions: ForeignTradeCostingAssumptions = {
        cif_total_original: settings.cifOverrideOriginal,
        general_duty_percent: settings.generalDutyPercent,
        import_vat_percent: settings.importVatPercent,
        sales_vat_percent: settings.salesVatPercent,
        import_vat_recoverable: settings.importVatRecoverable,
        pricing_method: settings.pricingMethod,
        target_percent: settings.targetPercent,
        line_duty_percent: settings.lineDutyPercent,
        line_target_percent: settings.lineTargetPercent,
      };
      await saveForeignTradeCostingScenario({
        id: baseline?.id,
        operationId: detail.operation.id,
        name: baseline?.name || "Escenario base",
        status: "baseline",
        exchangeRateClp: settings.exchangeRateClp,
        exchangeRateSource: detail.operation.exchange_rate_source || "manual",
        allocationMethod: settings.allocationMethod,
        assumptions,
        merchandiseTotalOriginal: detail.totals.registered_merchandise,
        merchandiseTotalClp: detail.totals.registered_merchandise * settings.exchangeRateClp,
        logisticsTotalClp: result.operatingExpensesNetClp,
        dutiesTotalClp: result.dutyClp,
        taxesTotalClp: result.importVatClp,
        landedTotalClp: result.landedTotalClp,
        projectedSalesClp: result.projectedNetSalesClp,
        projectedProfitClp: result.projectedProfitClp,
        projectedMarginPercent: result.projectedMarginPercent,
        missingInputs: result.missingInputs,
      });
      setSaved("Escenario guardado con sus tasas, criterios y precios por producto.");
      await onSaved("Escenario de costos y precios guardado.");
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(/save_foreign_trade_costing_scenario|does not exist|404/i.test(message)
        ? "Falta ejecutar supabase/foreign_trade_center_phase4_costing.sql en Supabase."
        : message);
    } finally {
      setSaving(false);
    }
  }

  async function exportExcel() {
    setExporting(true);
    setError("");
    setSaved("");
    try {
      await exportForeignTradeCostingExcel({ detail, result, settings });
      setSaved(`Excel generado con ${result.lines.length} productos y ${detail.costs.length} registros de costos.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="foreign-trade-costing-stack">
      <section className="panel foreign-trade-costing-config">
        <div className="foreign-trade-detail-panel-heading">
          <div>
            <h2>Costeo puesto en bodega y precio de venta</h2>
            <p>Los tributos se calculan desde el CIF y se muestran separados de los gastos operativos.</p>
          </div>
          <Calculator size={22} />
        </div>

        {!hasConfiguredLegalRates ? (
          <div className="notice-banner warning"><AlertTriangle size={18} /><div><strong>Parámetros legales pendientes</strong><span>Ejecuta la migración de Fase 4 para cargar tasas oficiales versionadas. Revisa siempre tratado, origen y partida arancelaria.</span></div></div>
        ) : null}

        <div className="foreign-trade-costing-controls">
          <label><span>Tipo de cambio USD/CLP</span><input inputMode="decimal" value={form.exchangeRateClp} onChange={(event) => setForm({ ...form, exchangeRateClp: event.target.value })} /></label>
          <label><span>CIF total operación (USD)</span><input inputMode="decimal" placeholder="Se calcula si queda vacío" value={form.cifTotalOriginal} onChange={(event) => setForm({ ...form, cifTotalOriginal: event.target.value })} /></label>
          <label><span>Derecho ad valorem general</span><div className="foreign-trade-percent-input"><input inputMode="decimal" value={form.generalDutyPercent} onChange={(event) => setForm({ ...form, generalDutyPercent: event.target.value })} /><b>%</b></div></label>
          <label><span>IVA importación</span><div className="foreign-trade-percent-input"><input inputMode="decimal" value={form.importVatPercent} onChange={(event) => setForm({ ...form, importVatPercent: event.target.value })} /><b>%</b></div></label>
          <label><span>IVA de venta</span><div className="foreign-trade-percent-input"><input inputMode="decimal" value={form.salesVatPercent} onChange={(event) => setForm({ ...form, salesVatPercent: event.target.value })} /><b>%</b></div></label>
          <label><span>Distribuir CIF y costos por</span><select value={form.allocationMethod} onChange={(event) => setForm({ ...form, allocationMethod: event.target.value as ForeignTradeAllocationMethod })}><option value="fob_value">Valor FOB</option><option value="cif_value">Valor CIF</option><option value="units">Unidades</option><option value="weight">Peso bruto</option><option value="cbm">CBM</option><option value="combined">Combinación equilibrada</option></select></label>
        </div>

        <div className="foreign-trade-pricing-controls">
          <div className="foreign-trade-segmented" aria-label="Método de precio">
            <button className={form.pricingMethod === "markup_on_cost" ? "active" : ""} type="button" onClick={() => setForm({ ...form, pricingMethod: "markup_on_cost" })}>Markup sobre costo</button>
            <button className={form.pricingMethod === "margin_on_sale" ? "active" : ""} type="button" onClick={() => setForm({ ...form, pricingMethod: "margin_on_sale" })}>Margen sobre venta</button>
          </div>
          <label><span>Objetivo general</span><div className="foreign-trade-percent-input"><input inputMode="decimal" value={form.targetPercent} onChange={(event) => setForm({ ...form, targetPercent: event.target.value })} /><b>%</b></div></label>
          <label className="foreign-trade-checkbox-field"><input type="checkbox" checked={form.importVatRecoverable} onChange={(event) => setForm({ ...form, importVatRecoverable: event.target.checked })} /><span>IVA de importación recuperable como crédito fiscal</span></label>
        </div>

        <p className="foreign-trade-calculation-note">
          {form.pricingMethod === "markup_on_cost"
            ? "Ejemplo: 45% agrega 45% al costo. El margen sobre la venta resultante será menor."
            : "Ejemplo: 45% fija la utilidad como 45% del precio neto de venta."}
        </p>
        {result.cifAllocationEstimated ? <p className="foreign-trade-calculation-note warning"><AlertTriangle size={16} /> No todos los productos tienen CIF individual. La participación CIF se estima temporalmente con la proporción FOB hasta completar esos datos.</p> : null}
      </section>

      <section className="foreign-trade-costing-kpis">
        <CostingKpi label="CIF aduanero" value={formatClp(result.cifClp)} detail="Base costo + seguro + flete" />
        <CostingKpi label="Derechos" value={formatClp(result.dutyClp)} detail="Tributo no recuperable" tone="warning" />
        <CostingKpi label="IVA importación" value={formatClp(result.importVatClp)} detail={form.importVatRecoverable ? "Flujo de caja / crédito" : "Incorporado al costo"} tone="info" />
        <CostingKpi label="Costo en bodega" value={formatClp(result.landedTotalClp)} detail="Sin IVA recuperable" tone="success" />
        <CostingKpi label="Venta neta proyectada" value={formatClp(result.projectedNetSalesClp)} detail={`Utilidad ${formatClp(result.projectedProfitClp)}`} />
      </section>

      <section className="panel foreign-trade-costing-reconciliation">
        <div><Landmark size={20} /><span><b>Gastos operativos netos</b><strong>{formatClp(result.operatingExpensesNetClp)}</strong></span></div>
        <div><WalletCards size={20} /><span><b>IVA recuperable total</b><strong>{formatClp(result.recoverableVatClp)}</strong></span></div>
        <div><Calculator size={20} /><span><b>Fondos adicionales estimados</b><strong>{formatClp(result.customsFundingClp)}</strong><small>Derechos + IVA importación + gastos brutos</small></span></div>
        <div><WalletCards size={20} /><span><b>Necesidad total de caja</b><strong>{formatClp(result.totalCashRequirementClp)}</strong><small>Incluye CIF</small></span></div>
      </section>

      <section className="panel foreign-trade-cost-composition">
        <div className="foreign-trade-detail-panel-heading">
          <div><h2>Cómo se forma el costo del producto</h2><p>La tabla distribuye cada componente y evita sumar dos veces el flete internacional o el seguro.</p></div>
          <PackageCheck size={22} />
        </div>
        <div className="foreign-trade-cost-formula" aria-label="Fórmula de costo puesto en bodega">
          <CostFormulaStep label="CIF aduanero" value={formatClp(result.cifClp)} detail="Mercadería + flete internacional + seguro" />
          <span aria-hidden="true">+</span>
          <CostFormulaStep label="Derechos" value={formatClp(result.dutyClp)} detail="Calculados sobre CIF" />
          <span aria-hidden="true">+</span>
          <CostFormulaStep label="Gastos locales" value={formatClp(result.operatingExpensesEconomicClp)} detail="Neto + IVA no recuperable" />
          {!form.importVatRecoverable ? <><span aria-hidden="true">+</span><CostFormulaStep label="IVA importación" value={formatClp(result.importVatClp)} detail="Solo cuando no es recuperable" /></> : null}
          <span aria-hidden="true">=</span>
          <CostFormulaStep label="Costo en bodega" value={formatClp(result.landedTotalClp)} detail="Base de la rentabilidad y del precio" strong />
        </div>
        <div className="foreign-trade-cost-inclusion-note">
          <strong>{includedOperatingCosts.length ? "Sí, estos gastos están incluidos en los productos:" : "No hay gastos locales activos para distribuir."}</strong>
          {includedOperatingCosts.length ? <span>{summarizeCosts(includedOperatingCosts.map((cost) => cost.name))}</span> : null}
          <small>El IVA recuperable se muestra como necesidad de caja y crédito fiscal, pero no aumenta el costo económico ni reduce artificialmente el margen.</small>
        </div>
      </section>

      {result.documentedDutyClp || result.documentedImportVatClp ? (
        <section className="foreign-trade-tax-check">
          <strong>Control contra documento</strong>
          <span>Derecho documentado {formatClp(result.documentedDutyClp)} · calculado {formatClp(result.dutyClp)}</span>
          <span>IVA importación documentado {formatClp(result.documentedImportVatClp)} · calculado {formatClp(result.importVatClp)}</span>
          <small>Una diferencia puede deberse a tasas por partida, tratados o bases oficiales redondeadas. Debe revisarse antes de aprobar.</small>
        </section>
      ) : null}

      <section className="panel foreign-trade-costing-table-panel">
        <div className="foreign-trade-detail-panel-heading">
          <div><h2>Tabla dinámica por producto</h2><p>Ajusta derecho y rentabilidad individualmente. Los precios se recalculan de inmediato.</p></div>
          <div className="foreign-trade-table-navigation" aria-label="Desplazar columnas de la tabla">
            <button className="icon-button" type="button" title="Ver columnas anteriores" aria-label="Ver columnas anteriores" onClick={() => scrollCostingTable(-1)}><ChevronLeft size={18} /></button>
            <button className="icon-button" type="button" title="Ver columnas siguientes" aria-label="Ver columnas siguientes" onClick={() => scrollCostingTable(1)}><ChevronRight size={18} /></button>
          </div>
        </div>
        {result.lines.length ? (
          <div className="table-scroll foreign-trade-costing-table-scroll" ref={costingTableScrollRef} tabIndex={0} aria-label="Costeo completo por producto">
            <table className="foreign-trade-costing-table">
              <thead><tr><th>Producto</th><th>Cantidad</th><th>Costo factura</th><th>CIF asignado</th><th>Derecho</th><th>IVA import.</th><th>Gastos</th><th>Costo unitario</th><th>Venta proyectada</th><th>Objetivo</th><th>Precio neto</th><th>Margen</th></tr></thead>
              <tbody>{result.lines.map((line) => (
                <tr key={line.lineId}>
                  <td data-label="Producto"><strong>{line.productName}</strong><small>{line.sku || "Sin SKU"}</small></td>
                  <td data-label="Cantidad">{formatNumber(line.quantity)}</td>
                  <td data-label="Costo factura"><strong>{formatClp(line.invoiceUnitClp)}</strong><small>{formatClp(line.invoiceTotalClp)} total</small></td>
                  <td data-label="CIF asignado">{formatClp(line.cifClp)}<small>{formatClp(line.quantity ? line.cifClp / line.quantity : 0)} por unidad</small></td>
                  <td data-label="Derecho"><div className="foreign-trade-table-percent"><input aria-label={`Derecho de ${line.productName}`} inputMode="decimal" value={form.lineDutyPercent[line.lineId] ?? form.generalDutyPercent} onChange={(event) => setForm({ ...form, lineDutyPercent: { ...form.lineDutyPercent, [line.lineId]: event.target.value } })} /><b>%</b></div><small>{formatClp(line.dutyClp)}</small></td>
                  <td data-label="IVA importación">{formatClp(line.importVatClp)}<small>{form.importVatRecoverable ? "Crédito" : "Costo"}</small></td>
                  <td data-label="Gastos">{formatClp(line.allocatedExpensesClp)}<small>{formatClp(line.quantity ? line.allocatedExpensesClp / line.quantity : 0)} por unidad</small></td>
                  <td data-label="Costo unitario"><strong>{formatClp(line.landedUnitClp)}</strong></td>
                  <td data-label="Venta proyectada"><strong>{formatClp(line.finalSaleUnitClp)}</strong><small>Precio final con IVA</small></td>
                  <td data-label="Objetivo"><div className="foreign-trade-table-percent"><input aria-label={`Objetivo de ${line.productName}`} inputMode="decimal" value={form.lineTargetPercent[line.lineId] ?? form.targetPercent} onChange={(event) => setForm({ ...form, lineTargetPercent: { ...form.lineTargetPercent, [line.lineId]: event.target.value } })} /><b>%</b></div></td>
                  <td data-label="Precio neto">{formatClp(line.netSaleUnitClp)}<small>Utilidad {formatClp(line.profitUnitClp)}</small></td>
                  <td data-label="Margen">{formatPercent(line.marginPercent)}<small>Markup {formatPercent(line.markupPercent)}</small></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        ) : <div className="empty-state"><Calculator size={26} /><strong>Agrega productos para calcular</strong><span>La distribución y el precio se mostrarán aquí.</span></div>}
      </section>

      {result.missingInputs.length ? <div className="notice-banner warning"><AlertTriangle size={18} /><div><strong>Datos pendientes</strong><span>{result.missingInputs.join(" ")}</span></div></div> : null}
      {error ? <div className="notice-banner error"><AlertTriangle size={18} /> {error}</div> : null}
      {saved ? <div className="notice-banner success"><CheckCircle2 size={18} /> {saved}</div> : null}
      <div className="foreign-trade-costing-actions" style={{ flexWrap: "wrap", gap: ".65rem" }}>
        <button className="ghost-button" style={{ flex: "1 1 190px", justifyContent: "center" }} type="button" disabled={saving || exporting || !result.lines.length} onClick={() => void exportExcel()}><FileSpreadsheet size={17} /> {exporting ? "Generando Excel..." : "Exportar Excel"}</button>
        <button className="primary-button" type="button" disabled={saving || exporting || !settings.exchangeRateClp} onClick={() => void saveScenario()}><Save size={17} /> {saving ? "Guardando..." : "Guardar escenario"}</button>
      </div>
    </div>
  );
}

function initialForm(
  detail: ForeignTradeOperationDetail,
  scenario: ForeignTradeScenario | null,
  parameters: ForeignTradeCostParameter[],
): CostingForm {
  const saved = scenario?.assumptions?.costing || {};
  const explicitCif = detail.lines.length && detail.lines.every((line) => Number(line.cif_total || 0) > 0)
    ? detail.lines.reduce((sum, line) => sum + Number(line.cif_total || 0), 0)
    : null;
  return {
    exchangeRateClp: valueString(scenario?.exchange_rate_clp ?? detail.operation.exchange_rate_clp),
    cifTotalOriginal: valueString(saved.cif_total_original ?? explicitCif),
    generalDutyPercent: valueString(saved.general_duty_percent ?? parameterValue(parameters, "cl_general_ad_valorem")),
    importVatPercent: valueString(saved.import_vat_percent ?? parameterValue(parameters, "cl_import_vat")),
    salesVatPercent: valueString(saved.sales_vat_percent ?? parameterValue(parameters, "cl_sales_vat")),
    importVatRecoverable: saved.import_vat_recoverable ?? true,
    pricingMethod: saved.pricing_method || "markup_on_cost",
    targetPercent: valueString(saved.target_percent ?? 45),
    allocationMethod: normalizeAllocation(scenario?.allocation_method),
    lineDutyPercent: stringRecord(saved.line_duty_percent),
    lineTargetPercent: stringRecord(saved.line_target_percent),
  };
}

function CostingKpi({ label, value, detail, tone = "neutral" }: { label: string; value: string; detail: string; tone?: string }) {
  return <article className={tone}><span>{label}</span><strong>{value}</strong><small>{detail}</small></article>;
}

function CostFormulaStep({ label, value, detail, strong = false }: { label: string; value: string; detail: string; strong?: boolean }) {
  return <div className={strong ? "total" : ""}><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>;
}

function summarizeCosts(names: string[]) {
  const unique = [...new Set(names.map((name) => name.trim()).filter(Boolean))];
  const visible = unique.slice(0, 5);
  return `${visible.join(", ")}${unique.length > visible.length ? ` y ${unique.length - visible.length} más` : ""}.`;
}

function parameterValue(parameters: ForeignTradeCostParameter[], code: string) {
  return parameters.find((parameter) => parameter.code === code && parameter.active)?.numeric_value ?? 0;
}

function normalizeAllocation(value?: ForeignTradeScenario["allocation_method"]): ForeignTradeAllocationMethod {
  return value && ["fob_value", "cif_value", "units", "weight", "cbm", "combined"].includes(value)
    ? value as ForeignTradeAllocationMethod
    : "fob_value";
}

function numberRecord(value?: Record<string, string | number>) {
  return Object.fromEntries(Object.entries(value || {}).map(([key, item]) => [key, numberValue(item)]));
}

function stringRecord(value?: Record<string, number>) {
  return Object.fromEntries(Object.entries(value || {}).map(([key, item]) => [key, valueString(item)]));
}

function numberValue(value: string | number | null | undefined) {
  const parsed = Number(String(value ?? "").replace(",", "."));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function valueString(value: number | null | undefined) {
  return value === null || value === undefined || !Number.isFinite(Number(value)) ? "" : String(value);
}

const clpFormatter = new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 });
const numberFormatter = new Intl.NumberFormat("es-CL", { maximumFractionDigits: 3 });
function formatClp(value: number) { return clpFormatter.format(Number(value || 0)); }
function formatNumber(value: number) { return numberFormatter.format(Number(value || 0)); }
function formatPercent(value: number) { return `${numberFormatter.format(Number(value || 0))}%`; }
