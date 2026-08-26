import { useMemo, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  Calculator,
  CheckCircle2,
  CircleDollarSign,
  History,
  Landmark,
  LoaderCircle,
  PackageCheck,
  RotateCcw,
  Ship,
  WalletCards,
} from "lucide-react";
import { getForeignTradeOperationDetail } from "../../lib/foreignTradeApi";
import type {
  ForeignTradeCenterData,
  ForeignTradeCostCategory,
  ForeignTradeOperationDetail,
} from "../../types/foreignTrade";
import {
  calculateForeignTradeQuote,
  type ForeignTradePricingMethod,
  type ForeignTradeQuoteIncoterm,
} from "./foreignTradeCostEngine";

type QuoteForm = {
  productName: string;
  unitPriceUsd: string;
  quantity: string;
  exchangeRateClp: string;
  incoterm: ForeignTradeQuoteIncoterm;
  originPercent: string;
  internationalFreightPercent: string;
  insurancePercent: string;
  chilePortPercent: string;
  storagePercent: string;
  customsAgencyPercent: string;
  nationalTransportPercent: string;
  inspectionPercent: string;
  certificatePercent: string;
  otherExpensesPercent: string;
  fixedExpensesClp: string;
  dutyPercent: string;
  importVatPercent: string;
  importVatRecoverable: boolean;
  salesVatPercent: string;
  pricingMethod: ForeignTradePricingMethod;
  targetPercent: string;
};

const clpFormatter = new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 });
const numberFormatter = new Intl.NumberFormat("es-CL", { maximumFractionDigits: 2 });

export function ForeignTradeQuoteCalculator({ data }: { data: ForeignTradeCenterData }) {
  const initialForm = useMemo(() => createInitialForm(data), [data]);
  const [form, setForm] = useState<QuoteForm>(initialForm);
  const [referenceId, setReferenceId] = useState("");
  const [referenceLabel, setReferenceLabel] = useState("Parámetros manuales");
  const [referenceStatus, setReferenceStatus] = useState("");
  const [loadingReference, setLoadingReference] = useState(false);

  const result = useMemo(() => calculateForeignTradeQuote({
    unitPriceUsd: numberValue(form.unitPriceUsd),
    quantity: numberValue(form.quantity),
    exchangeRateClp: numberValue(form.exchangeRateClp),
    incoterm: form.incoterm,
    originPercent: numberValue(form.originPercent),
    internationalFreightPercent: numberValue(form.internationalFreightPercent),
    insurancePercent: numberValue(form.insurancePercent),
    chilePortPercent: numberValue(form.chilePortPercent),
    storagePercent: numberValue(form.storagePercent),
    customsAgencyPercent: numberValue(form.customsAgencyPercent),
    nationalTransportPercent: numberValue(form.nationalTransportPercent),
    inspectionPercent: numberValue(form.inspectionPercent),
    certificatePercent: numberValue(form.certificatePercent),
    otherExpensesPercent: numberValue(form.otherExpensesPercent),
    fixedExpensesClp: numberValue(form.fixedExpensesClp),
    dutyPercent: numberValue(form.dutyPercent),
    importVatPercent: numberValue(form.importVatPercent),
    importVatRecoverable: form.importVatRecoverable,
    salesVatPercent: numberValue(form.salesVatPercent),
    pricingMethod: form.pricingMethod,
    targetPercent: numberValue(form.targetPercent),
  }), [form]);

  function update<K extends keyof QuoteForm>(key: K, value: QuoteForm[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function loadHistoricalReference() {
    if (!referenceId) {
      setForm((current) => ({ ...createInitialForm(data), productName: current.productName, unitPriceUsd: current.unitPriceUsd, quantity: current.quantity }));
      setReferenceLabel("Parámetros manuales");
      setReferenceStatus("Se restablecieron los parámetros configurados.");
      return;
    }
    setLoadingReference(true);
    setReferenceStatus("");
    try {
      const detail = await getForeignTradeOperationDetail(referenceId);
      const preset = historicalPreset(detail, form);
      setForm((current) => ({ ...current, ...preset }));
      setReferenceLabel(`${detail.operation.reference} · ${detail.operation.title}`);
      setReferenceStatus("Proporciones históricas cargadas. Puedes modificar cada valor.");
    } catch (error) {
      setReferenceStatus(error instanceof Error ? error.message : "No se pudo cargar la operación histórica.");
    } finally {
      setLoadingReference(false);
    }
  }

  return (
    <div className="foreign-trade-view-stack foreign-trade-quote-calculator">
      <section className="panel foreign-trade-calculator-heading">
        <div>
          <span className="foreign-trade-calculator-eyebrow"><Calculator size={16} /> Cotización rápida</span>
          <h2>Calculadora de costo puesto en bodega</h2>
          <p>{form.productName.trim() || "Producto en estudio"} · referencia {referenceLabel}</p>
        </div>
        <button className="ghost-button" type="button" onClick={() => { setForm(initialForm); setReferenceId(""); setReferenceLabel("Parámetros manuales"); setReferenceStatus(""); }}>
          <RotateCcw size={17} /> Restablecer
        </button>
      </section>

      <section className="foreign-trade-calculator-layout">
        <div className="foreign-trade-calculator-form">
          <section className="panel foreign-trade-calculator-section">
            <div className="foreign-trade-calculator-section-heading"><History size={19} /><div><h3>Referencia de costos</h3><span>Opcional</span></div></div>
            <div className="foreign-trade-calculator-reference">
              <label><span>Operación histórica</span><select value={referenceId} onChange={(event) => setReferenceId(event.target.value)}><option value="">Parámetros configurados</option>{data.operations.map((operation) => <option value={operation.id} key={operation.id}>{operation.reference} · {operation.title}</option>)}</select></label>
              <button className="ghost-button" type="button" disabled={loadingReference} onClick={() => void loadHistoricalReference()}>{loadingReference ? <LoaderCircle className="spin" size={17} /> : <History size={17} />} Aplicar referencia</button>
            </div>
            {referenceStatus ? <div className={`foreign-trade-calculator-status ${referenceStatus.includes("No se pudo") ? "error" : ""}`}><CheckCircle2 size={16} /> {referenceStatus}</div> : null}
          </section>

          <section className="panel foreign-trade-calculator-section">
            <div className="foreign-trade-calculator-section-heading"><CircleDollarSign size={19} /><div><h3>Producto y moneda</h3><span>Valores editables</span></div></div>
            <div className="foreign-trade-calculator-fields">
              <QuoteField label="Producto o referencia" wide><input value={form.productName} onChange={(event) => update("productName", event.target.value)} placeholder="Ej. Bomba de vacío modelo X" /></QuoteField>
              <QuoteField label="Precio unitario cotizado" suffix="USD"><input inputMode="decimal" value={form.unitPriceUsd} onChange={(event) => update("unitPriceUsd", event.target.value)} /></QuoteField>
              <QuoteField label="Cantidad" suffix="un."><input inputMode="numeric" value={form.quantity} onChange={(event) => update("quantity", event.target.value)} /></QuoteField>
              <QuoteField label="Tipo de cambio" suffix="CLP/USD"><input inputMode="decimal" value={form.exchangeRateClp} onChange={(event) => update("exchangeRateClp", event.target.value)} /></QuoteField>
            </div>
            <div className="foreign-trade-calculator-choice" role="group" aria-label="Incoterm del precio cotizado">
              {(["EXW", "FOB", "CIF"] as const).map((incoterm) => <button className={form.incoterm === incoterm ? "active" : ""} type="button" key={incoterm} onClick={() => update("incoterm", incoterm)}>{incoterm}</button>)}
            </div>
          </section>

          <section className="panel foreign-trade-calculator-section">
            <div className="foreign-trade-calculator-section-heading"><Ship size={19} /><div><h3>Logística internacional</h3><span>Porcentaje sobre la base indicada</span></div></div>
            <div className="foreign-trade-calculator-fields">
              <PercentField label="Origen EXW → FOB" value={form.originPercent} disabled={form.incoterm !== "EXW"} onChange={(value) => update("originPercent", value)} />
              <PercentField label="Flete internacional" value={form.internationalFreightPercent} disabled={form.incoterm === "CIF"} onChange={(value) => update("internationalFreightPercent", value)} />
              <PercentField label="Seguro" value={form.insurancePercent} disabled={form.incoterm === "CIF"} onChange={(value) => update("insurancePercent", value)} />
            </div>
          </section>

          <section className="panel foreign-trade-calculator-section">
            <div className="foreign-trade-calculator-section-heading"><Landmark size={19} /><div><h3>Gastos en Chile</h3><span>Porcentaje sobre CIF</span></div></div>
            <div className="foreign-trade-calculator-fields">
              <PercentField label="Puerto y desconsolidación" value={form.chilePortPercent} onChange={(value) => update("chilePortPercent", value)} />
              <PercentField label="Almacenaje" value={form.storagePercent} onChange={(value) => update("storagePercent", value)} />
              <PercentField label="Agencia de aduana" value={form.customsAgencyPercent} onChange={(value) => update("customsAgencyPercent", value)} />
              <PercentField label="Transporte a bodega" value={form.nationalTransportPercent} onChange={(value) => update("nationalTransportPercent", value)} />
              <PercentField label="Inspecciones" value={form.inspectionPercent} onChange={(value) => update("inspectionPercent", value)} />
              <PercentField label="Certificados" value={form.certificatePercent} onChange={(value) => update("certificatePercent", value)} />
              <PercentField label="Otros gastos" value={form.otherExpensesPercent} onChange={(value) => update("otherExpensesPercent", value)} />
              <QuoteField label="Gastos fijos del lote" suffix="CLP"><input inputMode="numeric" value={form.fixedExpensesClp} onChange={(event) => update("fixedExpensesClp", event.target.value)} /></QuoteField>
            </div>
          </section>

          <section className="panel foreign-trade-calculator-section">
            <div className="foreign-trade-calculator-section-heading"><WalletCards size={19} /><div><h3>Tributos y precio</h3><span>Parámetros del escenario</span></div></div>
            <div className="foreign-trade-calculator-fields">
              <PercentField label="Derecho aduanero" value={form.dutyPercent} onChange={(value) => update("dutyPercent", value)} />
              <PercentField label="IVA importación" value={form.importVatPercent} onChange={(value) => update("importVatPercent", value)} />
              <PercentField label="IVA venta" value={form.salesVatPercent} onChange={(value) => update("salesVatPercent", value)} />
              <PercentField label="Objetivo" value={form.targetPercent} onChange={(value) => update("targetPercent", value)} />
            </div>
            <label className="foreign-trade-calculator-toggle"><input type="checkbox" checked={form.importVatRecoverable} onChange={(event) => update("importVatRecoverable", event.target.checked)} /><span>IVA de importación recuperable</span></label>
            <div className="foreign-trade-calculator-choice" role="group" aria-label="Método para calcular el precio">
              <button className={form.pricingMethod === "markup_on_cost" ? "active" : ""} type="button" onClick={() => update("pricingMethod", "markup_on_cost")}>Markup sobre costo</button>
              <button className={form.pricingMethod === "margin_on_sale" ? "active" : ""} type="button" onClick={() => update("pricingMethod", "margin_on_sale")}>Margen sobre venta</button>
            </div>
          </section>
        </div>

        <aside className="foreign-trade-calculator-results">
          <section className="foreign-trade-calculator-result-primary">
            <span>Precio final sugerido</span>
            <strong>{formatClp(result.finalSaleUnitClp)}</strong>
            <small>{formatClp(result.netSaleUnitClp)} neto + {formatClp(result.salesVatUnitClp)} IVA</small>
          </section>

          <section className="panel foreign-trade-calculator-result-grid">
            <ResultMetric icon={<PackageCheck />} label="Costo en bodega" value={formatClp(result.landedUnitClp)} detail="por unidad" />
            <ResultMetric icon={<WalletCards />} label="Caja necesaria" value={formatClp(result.cashRequirementUnitClp)} detail="por unidad" />
            <ResultMetric icon={<CircleDollarSign />} label="Utilidad neta" value={formatClp(result.profitUnitClp)} detail="por unidad" />
            <ResultMetric icon={<Calculator />} label="Margen / markup" value={`${numberFormatter.format(result.marginPercent)}%`} detail={`${numberFormatter.format(result.markupPercent)}% markup`} />
          </section>

          <section className="panel foreign-trade-calculator-breakdown">
            <h3>Desglose por unidad</h3>
            <dl>
              <Breakdown label={`Valor ${form.incoterm} cotizado`} value={result.quotedUnitClp} />
              {form.incoterm === "EXW" ? <Breakdown label="Costo origen" value={result.originTotalClp / Math.max(numberValue(form.quantity), 1)} /> : null}
              {form.incoterm !== "CIF" ? <Breakdown label="Flete internacional" value={result.internationalFreightTotalClp / Math.max(numberValue(form.quantity), 1)} /> : null}
              {form.incoterm !== "CIF" ? <Breakdown label="Seguro" value={result.insuranceTotalClp / Math.max(numberValue(form.quantity), 1)} /> : null}
              <Breakdown label="CIF" value={result.cifUnitClp} strong />
              <Breakdown label="Derecho aduanero" value={result.dutyUnitClp} />
              <Breakdown label="Gastos operativos" value={result.operatingExpensesUnitClp} />
              <Breakdown label="IVA importación" value={result.importVatUnitClp} note={form.importVatRecoverable ? "Crédito recuperable" : "Se incorpora al costo"} />
              <Breakdown label="Costo puesto en bodega" value={result.landedUnitClp} strong />
            </dl>
          </section>

          <section className="panel foreign-trade-calculator-batch">
            <h3>Escenario completo</h3>
            <div><span>Inversión económica</span><strong>{formatClp(result.landedTotalClp)}</strong></div>
            <div><span>Caja requerida</span><strong>{formatClp(result.cashRequirementTotalClp)}</strong></div>
            <div><span>Venta final proyectada</span><strong>{formatClp(result.projectedFinalSalesClp)}</strong></div>
            <div><span>Utilidad proyectada</span><strong>{formatClp(result.projectedProfitClp)}</strong></div>
          </section>

          {result.warnings.length ? <div className="notice-banner warning"><AlertTriangle size={18} /><div>{result.warnings.map((warning) => <span key={warning}>{warning}</span>)}</div></div> : null}
        </aside>
      </section>
    </div>
  );
}

function QuoteField({ label, suffix, wide = false, children }: { label: string; suffix?: string; wide?: boolean; children: ReactNode }) {
  return <label className={wide ? "wide" : ""}><span>{label}</span><div className="foreign-trade-calculator-input">{children}{suffix ? <small>{suffix}</small> : null}</div></label>;
}

function PercentField({ label, value, disabled = false, onChange }: { label: string; value: string; disabled?: boolean; onChange: (value: string) => void }) {
  return <QuoteField label={label} suffix="%"><input inputMode="decimal" disabled={disabled} value={value} onChange={(event) => onChange(event.target.value)} /></QuoteField>;
}

function ResultMetric({ icon, label, value, detail }: { icon: ReactNode; label: string; value: string; detail: string }) {
  return <div>{icon}<span>{label}</span><strong>{value}</strong><small>{detail}</small></div>;
}

function Breakdown({ label, value, note, strong = false }: { label: string; value: number; note?: string; strong?: boolean }) {
  return <div className={strong ? "strong" : ""}><dt>{label}{note ? <small>{note}</small> : null}</dt><dd>{formatClp(value)}</dd></div>;
}

function createInitialForm(data: ForeignTradeCenterData): QuoteForm {
  const latestExchangeRate = data.operations.find((operation) => operation.exchange_rate_clp && operation.exchange_rate_clp > 0)?.exchange_rate_clp || 950;
  return {
    productName: "",
    unitPriceUsd: "5",
    quantity: "1",
    exchangeRateClp: valueString(latestExchangeRate),
    incoterm: "FOB",
    originPercent: "2",
    internationalFreightPercent: "10",
    insurancePercent: "1",
    chilePortPercent: "3",
    storagePercent: "0.5",
    customsAgencyPercent: "1.5",
    nationalTransportPercent: "2",
    inspectionPercent: "0",
    certificatePercent: "0",
    otherExpensesPercent: "1",
    fixedExpensesClp: "0",
    dutyPercent: valueString(parameterValue(data, "cl_general_ad_valorem", 6)),
    importVatPercent: valueString(parameterValue(data, "cl_import_vat", 19)),
    importVatRecoverable: true,
    salesVatPercent: valueString(parameterValue(data, "cl_sales_vat", 19)),
    pricingMethod: "margin_on_sale",
    targetPercent: "45",
  };
}

function parameterValue(data: ForeignTradeCenterData, code: string, fallback: number) {
  const value = data.costParameters.find((parameter) => parameter.code === code && parameter.active)?.numeric_value;
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function historicalPreset(detail: ForeignTradeOperationDetail, current: QuoteForm): Partial<QuoteForm> {
  const exchangeRate = detail.operation.exchange_rate_clp || detail.costs.find((cost) => cost.exchange_rate_clp)?.exchange_rate_clp || numberValue(current.exchangeRateClp) || 950;
  const merchandise = detail.lines.reduce((sum, line) => {
    const original = Math.max(line.fob_total || 0, line.exw_total || 0, (line.unit_factory_cost || 0) * (line.quantity || 0));
    return sum + (line.currency.toUpperCase() === "CLP" ? original : original * exchangeRate);
  }, 0);
  const categoryTotal = (category: ForeignTradeCostCategory) => detail.costs
    .filter((cost) => cost.category === category && !cost.metadata?.excluded_from_costing)
    .reduce((sum, cost) => sum + costClp(cost.amount_clp, cost.amount_original, cost.currency, cost.exchange_rate_clp || exchangeRate), 0);
  const freight = categoryTotal("international_freight");
  const insurance = categoryTotal("insurance");
  const documentedCif = detail.lines.reduce((sum, line) => sum + (line.cif_total ? (line.currency.toUpperCase() === "CLP" ? line.cif_total : line.cif_total * exchangeRate) : 0), 0);
  const cif = Math.max(documentedCif, merchandise + freight + insurance, 1);
  const duty = categoryTotal("duties");
  const importVat = categoryTotal("taxes");
  const basisWithDuty = cif + duty;
  const ratio = (amount: number, basis: number) => valueString(basis > 0 ? amount / basis * 100 : 0);
  return {
    exchangeRateClp: valueString(exchangeRate),
    originPercent: ratio(categoryTotal("origin"), Math.max(merchandise, 1)),
    internationalFreightPercent: ratio(freight, Math.max(merchandise, 1)),
    insurancePercent: ratio(insurance, Math.max(merchandise, 1)),
    chilePortPercent: ratio(categoryTotal("chile_port"), cif),
    storagePercent: ratio(categoryTotal("storage"), cif),
    customsAgencyPercent: ratio(categoryTotal("customs_agency"), cif),
    nationalTransportPercent: ratio(categoryTotal("national_transport"), cif),
    inspectionPercent: ratio(categoryTotal("inspection"), cif),
    certificatePercent: ratio(categoryTotal("certificate"), cif),
    otherExpensesPercent: ratio(categoryTotal("other") + categoryTotal("supplier_charge"), cif),
    dutyPercent: duty > 0 ? ratio(duty, cif) : current.dutyPercent,
    importVatPercent: importVat > 0 ? ratio(importVat, basisWithDuty) : current.importVatPercent,
    fixedExpensesClp: "0",
  };
}

function costClp(amountClp: number | null, amountOriginal: number, currency: string, exchangeRate: number) {
  if (typeof amountClp === "number" && Number.isFinite(amountClp)) return amountClp;
  return currency.toUpperCase() === "CLP" ? amountOriginal : amountOriginal * exchangeRate;
}

function numberValue(value: string) {
  const parsed = Number(String(value).replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : 0;
}

function valueString(value: number) {
  return Number(value.toFixed(4)).toString();
}

function formatClp(value: number) {
  return clpFormatter.format(Number.isFinite(value) ? value : 0);
}
