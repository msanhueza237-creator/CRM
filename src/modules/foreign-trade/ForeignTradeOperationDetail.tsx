import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Boxes,
  CheckCircle2,
  CircleDollarSign,
  Container,
  Edit3,
  Link2,
  LoaderCircle,
  PackageSearch,
  Plus,
  RefreshCw,
  Save,
  Scale,
  Trash2,
  X,
} from "lucide-react";
import {
  deleteForeignTradeCostLine,
  deleteForeignTradeOperationLine,
  searchForeignTradeCatalog,
  upsertForeignTradeCostLine,
  upsertForeignTradeOperationLine,
} from "../../lib/foreignTradeApi";
import type {
  ForeignTradeCatalogProduct,
  ForeignTradeCostCategory,
  ForeignTradeCostLine,
  ForeignTradeCostParameter,
  ForeignTradeDataSource,
  ForeignTradeOperation,
  ForeignTradeOperationLine,
  ForeignTradeOperationStatus,
  ForeignTradeSupplier,
  UpsertForeignTradeCostLineInput,
  UpsertForeignTradeOperationLineInput,
} from "../../types/foreignTrade";
import { useForeignTradeOperation } from "./useForeignTradeOperation";
import { ForeignTradeDocumentsPanel } from "./ForeignTradeDocumentsPanel";
import { ForeignTradeCostingPanel } from "./ForeignTradeCostingPanel";
import { ForeignTradeExpenseReconciliationPanel } from "./ForeignTradeExpenseReconciliationPanel";

type DetailTab = "summary" | "products" | "costs" | "reconciliation" | "costing" | "documents";

const costCategories: Array<{ value: ForeignTradeCostCategory; label: string }> = [
  { value: "origin", label: "Gastos en origen" },
  { value: "international_freight", label: "Flete internacional" },
  { value: "insurance", label: "Seguro" },
  { value: "chile_port", label: "Gastos portuarios Chile" },
  { value: "storage", label: "Almacenaje" },
  { value: "customs_agency", label: "Agencia de aduana" },
  { value: "national_transport", label: "Transporte a bodega" },
  { value: "inspection", label: "Inspección" },
  { value: "certificate", label: "Certificados" },
  { value: "duties", label: "Derechos" },
  { value: "taxes", label: "Impuestos" },
  { value: "supplier_charge", label: "Cargo de proveedor" },
  { value: "other", label: "Otro gasto" },
];

export function ForeignTradeOperationDetail({
  operationId,
  statuses,
  suppliers,
  costParameters,
  onBack,
  onDelete,
  onChanged,
}: {
  operationId: string;
  statuses: ForeignTradeOperationStatus[];
  suppliers: ForeignTradeSupplier[];
  costParameters: ForeignTradeCostParameter[];
  onBack: () => void;
  onDelete: (operation: ForeignTradeOperation) => Promise<void>;
  onChanged: () => Promise<void>;
}) {
  const { detail, error, loading, refresh } = useForeignTradeOperation(operationId);
  const [tab, setTab] = useState<DetailTab>("summary");
  const [lineDialog, setLineDialog] = useState<ForeignTradeOperationLine | "new" | null>(null);
  const [costDialog, setCostDialog] = useState<ForeignTradeCostLine | "new" | null>(null);
  const [notice, setNotice] = useState("");

  async function changed(message: string) {
    setNotice(message);
    await Promise.all([refresh(), onChanged()]);
  }

  if (loading && !detail) return <div className="panel foreign-trade-loading"><LoaderCircle className="spin" size={28} /><strong>Cargando ficha operativa</strong><span>Productos, gastos y trazabilidad privada.</span></div>;
  if (error || !detail) return <div className="notice-banner error"><AlertTriangle size={18} /> {error || "No se encontró la operación."}</div>;

  const { operation, supplier, totals } = detail;
  const status = statuses.find((item) => item.code === operation.status);
  const missing = getMissingInputs(detail.lines, detail.costs, operation.exchange_rate_clp);
  const taxRecords = detail.costs.filter((cost) => cost.category === "duties" || cost.category === "taxes");
  const operatingCosts = detail.costs.filter((cost) => cost.category !== "duties" && cost.category !== "taxes");

  return (
    <div className="foreign-trade-view-stack">
      <header className="foreign-trade-detail-header">
        <button className="icon-button" type="button" title="Volver a operaciones" onClick={onBack}><ArrowLeft size={19} /></button>
        <div><span>{operation.reference}</span><h2>{operation.title}</h2><p>{supplier?.name || "Sin proveedor asignado"} · {operation.incoterm || "Incoterm pendiente"}</p></div>
        <div><span className={`foreign-trade-status ${status?.color || "neutral"}`}>{status?.name || operation.status}</span><button className="ghost-button" type="button" disabled={loading} onClick={() => void refresh()}><RefreshCw className={loading ? "spin" : ""} size={16} /> Actualizar</button><button className="icon-button danger" type="button" title="Eliminar operación y todos sus datos relacionados" onClick={() => void onDelete(operation)}><Trash2 size={17} /></button></div>
      </header>

      {notice ? <div className="notice-banner success"><CheckCircle2 size={18} /> {notice}</div> : null}
      {missing.length ? <div className="notice-banner warning foreign-trade-analysis-warning"><AlertTriangle size={18} /><div><strong>Análisis todavía incompleto</strong><span>{missing.join(" · ")}</span></div></div> : null}

      <nav className="foreign-trade-detail-tabs" aria-label="Ficha de operación">
        <button className={tab === "summary" ? "active" : ""} type="button" onClick={() => setTab("summary")}>Resumen</button>
        <button className={tab === "products" ? "active" : ""} type="button" onClick={() => setTab("products")}>Productos <span>{totals.line_count}</span></button>
        <button className={tab === "costs" ? "active" : ""} type="button" onClick={() => setTab("costs")}>Costos base <span>{detail.costs.length}</span></button>
        <button className={tab === "reconciliation" ? "active" : ""} type="button" onClick={() => setTab("reconciliation")}>Conciliación agencia</button>
        <button className={tab === "costing" ? "active" : ""} type="button" onClick={() => setTab("costing")}>Costeo y precio</button>
        <button className={tab === "documents" ? "active" : ""} type="button" onClick={() => setTab("documents")}>Documentos</button>
      </nav>

      {tab === "summary" ? (
        <div className="foreign-trade-detail-summary">
          <section className="foreign-trade-kpi-grid foreign-trade-detail-kpis">
            <DetailKpi icon={<CircleDollarSign />} label="Valor informado" value={formatMoney(operation.value_usd, operation.base_currency)} detail="Configurado en la operación" />
            <DetailKpi icon={<Boxes />} label="Mercadería registrada" value={formatMoney(totals.registered_merchandise, operation.base_currency)} detail="Suma de líneas; no es costo puesto" />
            <DetailKpi icon={<Container />} label="Volumen" value={`${formatDecimal(totals.total_cbm)} m³`} detail={`${formatDecimal(operation.target_container_cbm || 0)} m³ objetivo`} />
            <DetailKpi icon={<Scale />} label="Peso bruto" value={`${formatDecimal(totals.gross_weight_kg)} kg`} detail={`${formatDecimal(totals.units)} unidades`} />
            <DetailKpi icon={<CircleDollarSign />} label="Gastos convertidos" value={formatClp(totals.costs_clp)} detail={totals.costs_without_clp ? `${totals.costs_without_clp} sin conversión CLP` : "Conversión disponible"} />
          </section>
          <section className="foreign-trade-detail-columns">
            <article className="panel foreign-trade-facts-panel">
              <div className="panel-heading"><div><h2>Datos de la operación</h2><span>Supuestos congelados al registrarla</span></div></div>
              <dl>
                <Fact label="Tipo de cambio" value={operation.exchange_rate_clp ? `$${formatDecimal(operation.exchange_rate_clp)} CLP` : "Falta configurar"} />
                <Fact label="Origen" value={operation.origin_port || "No informado"} />
                <Fact label="Destino" value={operation.destination_port || "No informado"} />
                <Fact label="Transporte" value={operation.transport_type} />
                <Fact label="Salida estimada" value={formatDate(operation.estimated_departure)} />
                <Fact label="Llegada estimada" value={formatDate(operation.estimated_arrival)} />
              </dl>
              {operation.notes ? <p className="foreign-trade-internal-note">{operation.notes}</p> : null}
            </article>
            <article className="panel foreign-trade-facts-panel">
              <div className="panel-heading"><div><h2>Proveedor</h2><span>Información interna reutilizada</span></div></div>
              {supplier ? <dl><Fact label="Empresa" value={supplier.company_name || supplier.name} /><Fact label="País" value={`${supplier.country_code}${supplier.factory_city ? ` · ${supplier.factory_city}` : ""}`} /><Fact label="Contacto" value={supplier.contact_name || supplier.email || "Pendiente"} /><Fact label="Producción" value={`${supplier.default_production_days} días`} /><Fact label="Moneda" value={supplier.currency} /><Fact label="Incoterms" value={supplier.usual_incoterms.join(", ") || "Pendientes"} /></dl> : <EmptyDetail title="Proveedor pendiente" detail="Asigna un proveedor al crear la próxima operación o edita sus datos en una fase posterior." />}
            </article>
          </section>
        </div>
      ) : null}

      {tab === "products" ? (
        <section className="panel foreign-trade-detail-panel">
          <div className="foreign-trade-detail-panel-heading"><div><h2>Productos de la operación</h2><p>Vincula el catálogo oficial o registra un producto temporal en estudio.</p></div><button className="primary-button" type="button" onClick={() => setLineDialog("new")}><Plus size={17} /> Agregar producto</button></div>
          {detail.lines.length ? <>
            <div className="table-scroll foreign-trade-desktop-records"><table className="foreign-trade-detail-table"><thead><tr><th>Producto</th><th>Cantidad</th><th>Costo fábrica</th><th>Total registrado</th><th>CBM</th><th>Fuente</th><th aria-label="Acciones" /></tr></thead><tbody>{detail.lines.map((line) => <ProductRow key={line.id} line={line} onEdit={() => setLineDialog(line)} onDelete={async () => { if (!window.confirm(`¿Eliminar ${line.product_name} de esta operación?`)) return; await deleteForeignTradeOperationLine(line.id); await changed("Producto eliminado de la operación."); }} />)}</tbody></table></div>
            <div className="foreign-trade-mobile-records" role="list" aria-label="Productos de la operación">{detail.lines.map((line) => <MobileProductCard key={line.id} line={line} onEdit={() => setLineDialog(line)} onDelete={async () => { if (!window.confirm(`¿Eliminar ${line.product_name} de esta operación?`)) return; await deleteForeignTradeOperationLine(line.id); await changed("Producto eliminado de la operación."); }} />)}</div>
          </> : <EmptyDetail title="Aún no hay productos" detail="Agrega líneas vinculadas al catálogo o productos temporales para esta negociación." />}
        </section>
      ) : null}

      {tab === "costs" ? (
        <section className="panel foreign-trade-detail-panel">
          <div className="foreign-trade-detail-panel-heading"><div><h2>Gastos operativos</h2><p>Registra montos netos o brutos. El IVA recuperable se separa del costo económico.</p></div><button className="primary-button" type="button" onClick={() => setCostDialog("new")}><Plus size={17} /> Agregar registro</button></div>
          {operatingCosts.length ? <CostTable costs={operatingCosts} onEdit={setCostDialog} onChanged={changed} /> : <EmptyDetail title="No hay gastos operativos" detail="Agrega flete, seguro, costos en origen o Chile sin mezclar monedas." />}
          {taxRecords.length ? <div className="foreign-trade-tax-records"><div><strong>Tributos documentados</strong><span>No se tratan como gastos: sirven para conciliar el cálculo desde CIF.</span></div><CostTable costs={taxRecords} onEdit={setCostDialog} onChanged={changed} /></div> : null}
        </section>
      ) : null}

      {tab === "reconciliation" ? <ForeignTradeExpenseReconciliationPanel operationId={operationId} costs={detail.costs} onChanged={changed} /> : null}

      {tab === "costing" ? <ForeignTradeCostingPanel detail={detail} costParameters={costParameters} onSaved={changed} /> : null}

      {tab === "documents" ? <ForeignTradeDocumentsPanel operationId={operationId} supplierId={operation.supplier_id} suppliers={suppliers} onChanged={changed} /> : null}

      {lineDialog ? <OperationLineDialog operationId={operationId} supplierAvailable={Boolean(operation.supplier_id)} line={lineDialog === "new" ? null : lineDialog} onClose={() => setLineDialog(null)} onSaved={async () => { setLineDialog(null); await changed("Producto guardado con trazabilidad."); }} /> : null}
      {costDialog ? <CostLineDialog operationId={operationId} defaultRate={operation.exchange_rate_clp} cost={costDialog === "new" ? null : costDialog} lines={detail.lines} onClose={() => setCostDialog(null)} onSaved={async () => { setCostDialog(null); await changed("Gasto guardado en su moneda original."); }} /> : null}
    </div>
  );
}

function OperationLineDialog({ operationId, supplierAvailable, line, onClose, onSaved }: { operationId: string; supplierAvailable: boolean; line: ForeignTradeOperationLine | null; onClose: () => void; onSaved: () => Promise<void> }) {
  const [mode, setMode] = useState<"catalog" | "temporary">(line?.temporary_product ? "temporary" : "catalog");
  const [catalog, setCatalog] = useState<ForeignTradeCatalogProduct[]>([]);
  const [catalogSearch, setCatalogSearch] = useState("");
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [selected, setSelected] = useState<ForeignTradeCatalogProduct | null>(null);
  const [form, setForm] = useState<UpsertForeignTradeOperationLineInput>({
    id: line?.id,
    operationId,
    contentProductId: line?.content_product_id || "",
    supplierProductId: line?.supplier_product_id || "",
    productName: line?.product_name || "",
    sku: line?.sku || "",
    supplierSku: line?.supplier_sku || "",
    supplierModel: line?.supplier_model || "",
    description: line?.description || "",
    temporaryProduct: line?.temporary_product ?? false,
    rememberLink: line?.linked_manually ?? false,
    quantity: valueString(line?.quantity, "0"),
    quantityPerBox: valueString(line?.quantity_per_box),
    boxCount: valueString(line?.box_count),
    currency: line?.currency || "USD",
    unitFactoryCost: valueString(line?.unit_factory_cost),
    exwTotal: valueString(line?.exw_total),
    fobTotal: valueString(line?.fob_total),
    cifTotal: valueString(line?.cif_total),
    discountTotal: valueString(line?.discount_total),
    supplierChargesTotal: valueString(line?.supplier_charges_total),
    unitWeightKg: valueString(line?.unit_weight_kg),
    grossWeightKg: valueString(line?.gross_weight_kg),
    netWeightKg: valueString(line?.net_weight_kg),
    boxLengthCm: valueString(line?.box_length_cm),
    boxWidthCm: valueString(line?.box_width_cm),
    boxHeightCm: valueString(line?.box_height_cm),
    cbmPerBox: valueString(line?.cbm_per_box),
    cbmTotal: valueString(line?.cbm_total),
    hsCode: line?.hs_code || "",
    countryOfOrigin: line?.country_of_origin || "",
    dataSource: line?.data_source || "configured",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => { if (!line) void loadCatalog(""); }, [line]);

  async function loadCatalog(search: string) {
    setCatalogLoading(true);
    try { setCatalog(await searchForeignTradeCatalog(search)); }
    catch (loadError) { setError(loadError instanceof Error ? loadError.message : "No se pudo consultar el catálogo."); }
    finally { setCatalogLoading(false); }
  }

  function chooseProduct(product: ForeignTradeCatalogProduct) {
    setSelected(product);
    setForm({ ...form, contentProductId: product.id, productName: product.name, sku: product.sku || "", temporaryProduct: false });
  }

  function changeMode(next: "catalog" | "temporary") {
    setMode(next);
    if (next === "temporary") setForm({ ...form, contentProductId: "", supplierProductId: "", rememberLink: false, temporaryProduct: true });
    else setForm({ ...form, temporaryProduct: false });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (mode === "catalog" && !form.contentProductId) throw new Error("Selecciona un producto del catálogo.");
      await upsertForeignTradeOperationLine({ ...form, temporaryProduct: mode === "temporary" });
      await onSaved();
    } catch (submitError) {
      setError(submitError instanceof Error ? humanizeWriteError(submitError.message) : "No se pudo guardar el producto.");
    } finally { setBusy(false); }
  }

  return (
    <div className="foreign-trade-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <form className="foreign-trade-operation-dialog foreign-trade-line-dialog" role="dialog" aria-modal="true" aria-labelledby="foreign-trade-line-title" onSubmit={submit}>
        <div className="foreign-trade-dialog-heading"><div><span>Línea histórica</span><h2 id="foreign-trade-line-title">{line ? "Editar producto" : "Agregar producto"}</h2></div><button className="icon-button" type="button" title="Cerrar" onClick={onClose}><X size={18} /></button></div>
        {!line ? <div className="foreign-trade-mode-switch"><button className={mode === "catalog" ? "active" : ""} type="button" onClick={() => changeMode("catalog")}><Link2 size={16} /> Catálogo CRM</button><button className={mode === "temporary" ? "active" : ""} type="button" onClick={() => changeMode("temporary")}><PackageSearch size={16} /> Producto temporal</button></div> : null}
        {mode === "catalog" && !line ? <section className="foreign-trade-catalog-picker"><div><input value={catalogSearch} onChange={(event) => setCatalogSearch(event.target.value)} placeholder="Buscar por SKU, nombre, categoría o marca" /><button className="ghost-button" type="button" onClick={() => void loadCatalog(catalogSearch)}>{catalogLoading ? <LoaderCircle className="spin" size={16} /> : <PackageSearch size={16} />} Buscar</button></div><div>{catalog.map((product) => <button className={form.contentProductId === product.id ? "selected" : ""} type="button" key={product.id} onClick={() => chooseProduct(product)}>{product.primary_image_url ? <img src={product.primary_image_url} alt="" /> : <span className="foreign-trade-product-placeholder"><Boxes size={18} /></span>}<span><strong>{product.name}</strong><small>{product.sku || "Sin SKU"} · {product.category || "Sin categoría"}</small></span><em>{product.sync_status === "synced" ? "Sincronizado" : product.sync_status}</em></button>)}</div></section> : null}
        {selected ? <div className="foreign-trade-selected-product"><CheckCircle2 size={18} /><div><strong>{selected.name}</strong><span>Catálogo oficial · no se importan costos desde el precio de venta.</span></div></div> : null}
        <div className="foreign-trade-form-grid">
          <label className="wide-field"><span>Producto</span><input required maxLength={240} value={form.productName} onChange={(event) => setForm({ ...form, productName: event.target.value })} readOnly={mode === "catalog" && Boolean(form.contentProductId)} /></label>
          <label><span>SKU CRM</span><input value={form.sku} onChange={(event) => setForm({ ...form, sku: event.target.value })} /></label>
          <label><span>SKU proveedor</span><input value={form.supplierSku} onChange={(event) => setForm({ ...form, supplierSku: event.target.value })} /></label>
          <label><span>Cantidad</span><input required inputMode="decimal" value={form.quantity} onChange={(event) => setForm({ ...form, quantity: event.target.value })} /></label>
          <label><span>Costo fábrica por unidad</span><div className="foreign-trade-money-input"><input inputMode="decimal" value={form.unitFactoryCost} onChange={(event) => setForm({ ...form, unitFactoryCost: event.target.value })} placeholder="0" /><input aria-label="Moneda" maxLength={3} value={form.currency} onChange={(event) => setForm({ ...form, currency: event.target.value.toUpperCase() })} /></div></label>
          <label><span>Unidades por caja</span><input inputMode="decimal" value={form.quantityPerBox} onChange={(event) => setForm({ ...form, quantityPerBox: event.target.value })} /></label>
          <label><span>Cantidad de cajas</span><input inputMode="decimal" value={form.boxCount} onChange={(event) => setForm({ ...form, boxCount: event.target.value })} /></label>
          <label><span>CBM total</span><input inputMode="decimal" value={form.cbmTotal} onChange={(event) => setForm({ ...form, cbmTotal: event.target.value })} /></label>
          <label><span>Peso bruto kg</span><input inputMode="decimal" value={form.grossWeightKg} onChange={(event) => setForm({ ...form, grossWeightKg: event.target.value })} /></label>
          <label><span>Modelo proveedor</span><input value={form.supplierModel} onChange={(event) => setForm({ ...form, supplierModel: event.target.value })} /></label>
          <label><span>País de origen</span><input maxLength={3} value={form.countryOfOrigin} onChange={(event) => setForm({ ...form, countryOfOrigin: event.target.value.toUpperCase() })} placeholder="CN" /></label>
          <label><span>HS Code</span><input value={form.hsCode} onChange={(event) => setForm({ ...form, hsCode: event.target.value })} /></label>
          <label><span>Origen del dato</span><SourceSelect value={form.dataSource} onChange={(dataSource) => setForm({ ...form, dataSource })} /></label>
          <details className="foreign-trade-advanced-fields wide-field"><summary>Dimensiones y totales avanzados</summary><div className="foreign-trade-form-grid"><label><span>Largo caja cm</span><input inputMode="decimal" value={form.boxLengthCm} onChange={(event) => setForm({ ...form, boxLengthCm: event.target.value })} /></label><label><span>Ancho caja cm</span><input inputMode="decimal" value={form.boxWidthCm} onChange={(event) => setForm({ ...form, boxWidthCm: event.target.value })} /></label><label><span>Alto caja cm</span><input inputMode="decimal" value={form.boxHeightCm} onChange={(event) => setForm({ ...form, boxHeightCm: event.target.value })} /></label><label><span>CBM por caja</span><input inputMode="decimal" value={form.cbmPerBox} onChange={(event) => setForm({ ...form, cbmPerBox: event.target.value })} /></label><label><span>Total EXW</span><input inputMode="decimal" value={form.exwTotal} onChange={(event) => setForm({ ...form, exwTotal: event.target.value })} /></label><label><span>Total FOB</span><input inputMode="decimal" value={form.fobTotal} onChange={(event) => setForm({ ...form, fobTotal: event.target.value })} /></label><label><span>Total CIF</span><input inputMode="decimal" value={form.cifTotal} onChange={(event) => setForm({ ...form, cifTotal: event.target.value })} /></label><label><span>Descuento</span><input inputMode="decimal" value={form.discountTotal} onChange={(event) => setForm({ ...form, discountTotal: event.target.value })} /></label><label><span>Cargos proveedor</span><input inputMode="decimal" value={form.supplierChargesTotal} onChange={(event) => setForm({ ...form, supplierChargesTotal: event.target.value })} /></label></div></details>
          <label className="wide-field"><span>Descripción o nota de negociación</span><textarea value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} /></label>
          {supplierAvailable && mode === "catalog" ? <label className="foreign-trade-checkbox-field wide-field"><input type="checkbox" checked={form.rememberLink} onChange={(event) => setForm({ ...form, rememberLink: event.target.checked })} /><span>Recordar vínculo SKU proveedor ↔ producto CRM para próximas proformas</span></label> : null}
        </div>
        {error ? <div className="notice-banner error"><AlertTriangle size={17} /> {error}</div> : null}
        <div className="foreign-trade-dialog-actions"><button className="ghost-button" type="button" onClick={onClose}>Cancelar</button><button className="primary-button" type="submit" disabled={busy}><Save size={17} /> {busy ? "Guardando..." : "Guardar producto"}</button></div>
      </form>
    </div>
  );
}

function CostLineDialog({ operationId, defaultRate, cost, lines, onClose, onSaved }: { operationId: string; defaultRate: number | null; cost: ForeignTradeCostLine | null; lines: ForeignTradeOperationLine[]; onClose: () => void; onSaved: () => Promise<void> }) {
  const [form, setForm] = useState<UpsertForeignTradeCostLineInput>({
    id: cost?.id,
    operationId,
    scenarioId: cost?.scenario_id || "",
    operationLineId: cost?.operation_line_id || "",
    category: cost?.category || "international_freight",
    name: cost?.name || "",
    amountOriginal: valueString(cost?.amount_original, "0"),
    currency: cost?.currency || "USD",
    exchangeRateClp: valueString(cost?.exchange_rate_clp ?? defaultRate),
    allocationMethod: cost?.allocation_method || "operation",
    sourceType: cost?.source_type || "configured",
    recoverableTax: cost?.recoverable_tax ?? false,
    amountBasis: cost?.metadata?.amount_basis || "net",
    vatRatePercent: valueString(cost?.metadata?.vat_rate_percent as number | undefined, "0"),
    notes: cost?.notes || "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const previewClp = useMemo(() => form.currency.toUpperCase() === "CLP" ? Number(normalizeDecimal(form.amountOriginal)) : Number(normalizeDecimal(form.amountOriginal)) * Number(normalizeDecimal(form.exchangeRateClp)), [form.amountOriginal, form.currency, form.exchangeRateClp]);

  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try { await upsertForeignTradeCostLine(form); await onSaved(); }
    catch (submitError) { setError(submitError instanceof Error ? humanizeWriteError(submitError.message) : "No se pudo guardar el gasto."); }
    finally { setBusy(false); }
  }

  return <div className="foreign-trade-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><form className="foreign-trade-operation-dialog" role="dialog" aria-modal="true" aria-labelledby="foreign-trade-cost-title" onSubmit={submit}>
    <div className="foreign-trade-dialog-heading"><div><span>Costo privado</span><h2 id="foreign-trade-cost-title">{cost ? "Editar gasto" : "Agregar gasto"}</h2></div><button className="icon-button" type="button" title="Cerrar" onClick={onClose}><X size={18} /></button></div>
    <div className="foreign-trade-form-grid">
      <label className="wide-field"><span>Concepto</span><input autoFocus required maxLength={180} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Ej. Flete marítimo cotizado" /></label>
      <label><span>Categoría</span><select value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value as ForeignTradeCostCategory })}>{costCategories.map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}</select></label>
      <label><span>Producto asociado, opcional</span><select value={form.operationLineId} onChange={(event) => setForm({ ...form, operationLineId: event.target.value })}><option value="">Toda la operación</option>{lines.map((line) => <option value={line.id} key={line.id}>{line.product_name}</option>)}</select></label>
      <label><span>Monto original</span><div className="foreign-trade-money-input"><input required inputMode="decimal" value={form.amountOriginal} onChange={(event) => setForm({ ...form, amountOriginal: event.target.value })} /><input aria-label="Moneda" required maxLength={3} value={form.currency} onChange={(event) => setForm({ ...form, currency: event.target.value.toUpperCase() })} /></div></label>
      <label><span>Tipo de cambio a CLP</span><input inputMode="decimal" disabled={form.currency.toUpperCase() === "CLP"} value={form.exchangeRateClp} onChange={(event) => setForm({ ...form, exchangeRateClp: event.target.value })} /></label>
      <label><span>Base del monto</span><select value={form.amountBasis} onChange={(event) => setForm({ ...form, amountBasis: event.target.value as "net" | "gross" })}><option value="net">Neto, sin IVA</option><option value="gross">Bruto, IVA incluido</option></select></label>
      <label><span>IVA asociado al gasto</span><div className="foreign-trade-percent-input"><input inputMode="decimal" value={form.vatRatePercent} onChange={(event) => setForm({ ...form, vatRatePercent: event.target.value })} /><b>%</b></div></label>
      <label><span>Método de distribución</span><select value={form.allocationMethod} onChange={(event) => setForm({ ...form, allocationMethod: event.target.value as ForeignTradeCostLine["allocation_method"] })}><option value="operation">Usar criterio general</option><option value="fob_value">Por valor FOB</option><option value="cif_value">Por valor CIF</option><option value="units">Por unidades</option><option value="weight">Por peso</option><option value="cbm">Por CBM</option><option value="manual">Manual</option><option value="combined">Combinado</option></select></label>
      <label><span>Origen del dato</span><SourceSelect value={form.sourceType} onChange={(sourceType) => setForm({ ...form, sourceType })} /></label>
      <label className="wide-field"><span>Notas</span><textarea value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} /></label>
      <label className="foreign-trade-checkbox-field wide-field"><input type="checkbox" checked={form.recoverableTax} onChange={(event) => setForm({ ...form, recoverableTax: event.target.checked })} /><span>El IVA de este gasto es recuperable como crédito fiscal</span></label>
    </div>
    <div className="foreign-trade-cost-preview"><CircleDollarSign size={18} /><div><span>Conversión operativa</span><strong>{Number.isFinite(previewClp) && previewClp > 0 ? formatClp(previewClp) : "Pendiente de tipo de cambio"}</strong><small>No es costo puesto en bodega.</small></div></div>
    {error ? <div className="notice-banner error"><AlertTriangle size={17} /> {error}</div> : null}
    <div className="foreign-trade-dialog-actions"><button className="ghost-button" type="button" onClick={onClose}>Cancelar</button><button className="primary-button" type="submit" disabled={busy}><Save size={17} /> {busy ? "Guardando..." : "Guardar gasto"}</button></div>
  </form></div>;
}

function ProductRow({ line, onEdit, onDelete }: { line: ForeignTradeOperationLine; onEdit: () => void; onDelete: () => Promise<void> }) {
  const total = getProductLineTotal(line);
  const cbmPerUnit = line.cbm_total !== null && line.quantity > 0 ? line.cbm_total / line.quantity : null;
  return <tr><td data-label="Producto"><div className="foreign-trade-product-cell">{line.primary_image_url ? <img src={line.primary_image_url} alt="" /> : <span><Boxes size={18} /></span>}<div><strong>{line.product_name}</strong><small>{line.sku || "Sin SKU"} · {line.temporary_product ? "Temporal" : "Catálogo CRM"}</small></div></div></td><td data-label="Cantidad">{formatDecimal(line.quantity)}</td><td data-label="Costo fábrica">{line.unit_factory_cost === null ? "Pendiente" : formatMoney(line.unit_factory_cost, line.currency)}</td><td data-label="Total registrado">{formatMoney(total, line.currency)}</td><td data-label="CBM">{line.cbm_total === null ? "Pendiente" : <><strong>{formatDecimal(line.cbm_total)} m³</strong>{cbmPerUnit !== null ? <small>{formatDecimal(cbmPerUnit)} m³ por unidad</small> : null}</>}</td><td data-label="Fuente"><SourceBadge source={line.data_source} /></td><td data-label="Acciones"><div className="foreign-trade-row-actions"><button className="icon-button" type="button" title="Editar producto" aria-label={`Editar ${line.product_name}`} onClick={onEdit}><Edit3 size={16} /></button><button className="icon-button danger" type="button" title="Eliminar producto" aria-label={`Eliminar ${line.product_name}`} onClick={() => void onDelete()}><Trash2 size={16} /></button></div></td></tr>;
}

function MobileProductCard({ line, onEdit, onDelete }: { line: ForeignTradeOperationLine; onEdit: () => void; onDelete: () => Promise<void> }) {
  const total = getProductLineTotal(line);
  const cbmPerUnit = line.cbm_total !== null && line.quantity > 0 ? line.cbm_total / line.quantity : null;
  return <article className="foreign-trade-mobile-record-card" role="listitem">
    <header className="foreign-trade-mobile-record-header">
      {line.primary_image_url ? <img src={line.primary_image_url} alt="" /> : <span className="foreign-trade-mobile-record-icon"><Boxes size={20} /></span>}
      <div><strong>{line.product_name}</strong><small>{line.sku || "Sin SKU"} · {line.temporary_product ? "Temporal" : "Catálogo CRM"}</small></div>
      <div className="foreign-trade-mobile-record-actions"><button className="icon-button" type="button" title="Editar producto" aria-label={`Editar ${line.product_name}`} onClick={onEdit}><Edit3 size={17} /></button><button className="icon-button danger" type="button" title="Eliminar producto" aria-label={`Eliminar ${line.product_name}`} onClick={() => void onDelete()}><Trash2 size={17} /></button></div>
    </header>
    <div className="foreign-trade-mobile-record-metrics">
      <MobileMetric label="Cantidad" value={formatDecimal(line.quantity)} />
      <MobileMetric label="Costo fábrica" value={line.unit_factory_cost === null ? "Pendiente" : formatMoney(line.unit_factory_cost, line.currency)} />
      <MobileMetric label="Total registrado" value={formatMoney(total, line.currency)} />
      <MobileMetric label="Volumen" value={line.cbm_total === null ? "Pendiente" : `${formatDecimal(line.cbm_total)} m³`} detail={cbmPerUnit === null ? undefined : `${formatDecimal(cbmPerUnit)} m³ por unidad`} />
    </div>
    <footer><span>Fuente</span><SourceBadge source={line.data_source} /></footer>
  </article>;
}

function CostTable({ costs, onEdit, onChanged }: { costs: ForeignTradeCostLine[]; onEdit: (cost: ForeignTradeCostLine) => void; onChanged: (message: string) => Promise<void> }) {
  return <>
    <div className="table-scroll foreign-trade-desktop-records"><table className="foreign-trade-detail-table"><thead><tr><th>Concepto</th><th>Categoría</th><th>Monto original</th><th>Conversión CLP</th><th>Distribución</th><th>Fuente</th><th aria-label="Acciones" /></tr></thead><tbody>{costs.map((cost) => <CostRow key={cost.id} cost={cost} onEdit={() => onEdit(cost)} onDelete={async () => { if (!window.confirm(`¿Eliminar el registro ${cost.name}?`)) return; await deleteForeignTradeCostLine(cost.id); await onChanged("Registro eliminado de la operación."); }} />)}</tbody></table></div>
    <div className="foreign-trade-mobile-records" role="list" aria-label="Costos base de la operación">{costs.map((cost) => <MobileCostCard key={cost.id} cost={cost} onEdit={() => onEdit(cost)} onDelete={async () => { if (!window.confirm(`¿Eliminar el registro ${cost.name}?`)) return; await deleteForeignTradeCostLine(cost.id); await onChanged("Registro eliminado de la operación."); }} />)}</div>
  </>;
}

function CostRow({ cost, onEdit, onDelete }: { cost: ForeignTradeCostLine; onEdit: () => void; onDelete: () => Promise<void> }) {
  const vatRate = Number(cost.metadata?.vat_rate_percent || 0);
  const reconciled = Boolean(cost.metadata?.reconciliation_id);
  const excluded = Boolean(cost.metadata?.excluded_from_costing);
  return <tr className={excluded ? "foreign-trade-cost-excluded" : ""}><td data-label="Concepto"><strong>{cost.name}</strong>{excluded ? <small>Estimación reemplazada · conservada en historial</small> : cost.notes ? <small>{cost.notes}</small> : null}</td><td data-label="Categoría">{costCategoryLabel(cost.category)}</td><td data-label="Monto original">{formatMoney(cost.amount_original, cost.currency)}<small>{cost.metadata?.amount_basis === "gross" ? "Monto bruto" : "Monto neto"}{vatRate ? ` · IVA ${formatDecimal(vatRate)}%${cost.recoverable_tax ? " recuperable" : ""}` : ""}</small></td><td data-label="Conversión CLP">{cost.amount_clp === null ? "Falta tipo de cambio" : formatClp(cost.amount_clp)}</td><td data-label="Distribución">{allocationLabel(cost.allocation_method)}</td><td data-label="Fuente">{excluded ? <span className="foreign-trade-source-badge estimated">Reemplazado</span> : <SourceBadge source={cost.source_type} />}</td><td data-label="Acciones"><div className="foreign-trade-row-actions">{reconciled || excluded ? <small>Editar en conciliación</small> : <><button className="icon-button" type="button" title="Editar registro" aria-label={`Editar ${cost.name}`} onClick={onEdit}><Edit3 size={16} /></button><button className="icon-button danger" type="button" title="Eliminar registro" aria-label={`Eliminar ${cost.name}`} onClick={() => void onDelete()}><Trash2 size={16} /></button></>}</div></td></tr>;
}

function MobileCostCard({ cost, onEdit, onDelete }: { cost: ForeignTradeCostLine; onEdit: () => void; onDelete: () => Promise<void> }) {
  const vatRate = Number(cost.metadata?.vat_rate_percent || 0);
  const reconciled = Boolean(cost.metadata?.reconciliation_id);
  const excluded = Boolean(cost.metadata?.excluded_from_costing);
  const amountDetail = `${cost.metadata?.amount_basis === "gross" ? "Monto bruto" : "Monto neto"}${vatRate ? ` · IVA ${formatDecimal(vatRate)}%${cost.recoverable_tax ? " recuperable" : ""}` : ""}`;
  return <article className={`foreign-trade-mobile-record-card foreign-trade-mobile-cost-card${excluded ? " excluded" : ""}`} role="listitem">
    <header className="foreign-trade-mobile-record-header">
      <span className="foreign-trade-mobile-record-icon"><CircleDollarSign size={20} /></span>
      <div><strong>{cost.name}</strong><small>{excluded ? "Estimación reemplazada · conservada en historial" : cost.notes || costCategoryLabel(cost.category)}</small></div>
      {!reconciled && !excluded ? <div className="foreign-trade-mobile-record-actions"><button className="icon-button" type="button" title="Editar registro" aria-label={`Editar ${cost.name}`} onClick={onEdit}><Edit3 size={17} /></button><button className="icon-button danger" type="button" title="Eliminar registro" aria-label={`Eliminar ${cost.name}`} onClick={() => void onDelete()}><Trash2 size={17} /></button></div> : null}
    </header>
    <div className="foreign-trade-mobile-record-metrics">
      <MobileMetric label="Categoría" value={costCategoryLabel(cost.category)} />
      <MobileMetric label="Distribución" value={allocationLabel(cost.allocation_method)} />
      <MobileMetric label="Monto original" value={formatMoney(cost.amount_original, cost.currency)} detail={amountDetail} />
      <MobileMetric label="Conversión CLP" value={cost.amount_clp === null ? "Falta tipo de cambio" : formatClp(cost.amount_clp)} />
    </div>
    <footer><span>{reconciled || excluded ? "Editar en conciliación" : "Fuente"}</span>{excluded ? <span className="foreign-trade-source-badge estimated">Reemplazado</span> : <SourceBadge source={cost.source_type} />}</footer>
  </article>;
}

function MobileMetric({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return <div><span>{label}</span><strong>{value}</strong>{detail ? <small>{detail}</small> : null}</div>;
}

function getProductLineTotal(line: ForeignTradeOperationLine) {
  return line.cif_total ?? line.fob_total ?? line.exw_total ?? ((line.unit_factory_cost || 0) * line.quantity - (line.discount_total || 0) + (line.supplier_charges_total || 0));
}

function DetailKpi({ icon, label, value, detail }: { icon: React.ReactNode; label: string; value: string; detail: string }) { return <article><div>{icon}<span>{label}</span></div><strong>{value}</strong><small>{detail}</small></article>; }
function Fact({ label, value }: { label: string; value: string }) { return <div><dt>{label}</dt><dd>{value}</dd></div>; }
function EmptyDetail({ title, detail }: { title: string; detail: string }) { return <div className="empty-state"><PackageSearch size={27} /><strong>{title}</strong><span>{detail}</span></div>; }
function SourceSelect({ value, onChange }: { value: ForeignTradeDataSource; onChange: (value: ForeignTradeDataSource) => void }) { return <select value={value} onChange={(event) => onChange(event.target.value as ForeignTradeDataSource)}><option value="real">Real confirmado</option><option value="document">Extraído de documento</option><option value="configured">Configurado</option><option value="estimated">Estimado</option><option value="simulated">Simulado</option></select>; }
function SourceBadge({ source }: { source: ForeignTradeDataSource }) { return <span className={`foreign-trade-source-badge ${source}`}>{({ real: "Real", document: "Documento", configured: "Configurado", estimated: "Estimado", simulated: "Simulado" })[source]}</span>; }

function getMissingInputs(lines: ForeignTradeOperationLine[], costs: ForeignTradeCostLine[], rate: number | null) {
  const missing: string[] = [];
  const activeCosts = costs.filter((cost) => !cost.metadata?.excluded_from_costing);
  if (!rate) missing.push("tipo de cambio pendiente");
  if (!lines.length) missing.push("sin productos");
  else {
    if (lines.some((line) => line.unit_factory_cost === null && line.exw_total === null && line.fob_total === null && line.cif_total === null)) missing.push("hay productos sin costo");
    if (lines.some((line) => line.cbm_total === null)) missing.push("hay productos sin CBM");
  }
  if (!activeCosts.length) missing.push("sin gastos logísticos");
  if (activeCosts.some((cost) => cost.amount_clp === null)) missing.push("hay gastos sin conversión CLP");
  return missing;
}

function humanizeWriteError(message: string) {
  if (message.includes("foreign_trade_forbidden")) return "Tu usuario no tiene permiso para modificar esta información.";
  if (message.includes("supplier_link_incomplete")) return "Para recordar el vínculo necesitas proveedor, producto de catálogo y SKU CRM.";
  if (message.includes("foreign_trade_invalid")) return "Revisa los campos obligatorios y los valores numéricos.";
  if (message.includes("not_found")) return "El registro ya no existe o no pertenece a esta operación.";
  return message;
}
function costCategoryLabel(category: ForeignTradeCostCategory) { return costCategories.find((item) => item.value === category)?.label || category; }
function allocationLabel(value: ForeignTradeCostLine["allocation_method"]) { return ({ operation: "Criterio general", fob_value: "Por FOB", cif_value: "Por CIF", units: "Por unidades", weight: "Por peso", cbm: "Por CBM", manual: "Manual", combined: "Combinado" })[value]; }
function valueString(value: number | null | undefined, fallback = "") { return value === null || value === undefined ? fallback : String(value); }
function normalizeDecimal(value?: string) { return String(value || "").trim().replace(",", ".") || "0"; }

const decimalFormatter = new Intl.NumberFormat("es-CL", { maximumFractionDigits: 3 });
const clpFormatter = new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 });
function formatDecimal(value: number) { return decimalFormatter.format(Number(value || 0)); }
function formatClp(value: number) { return clpFormatter.format(Number(value || 0)); }
function formatMoney(value: number, currency: string) { try { return new Intl.NumberFormat("es-CL", { style: "currency", currency: currency || "USD", maximumFractionDigits: 4 }).format(Number(value || 0)); } catch { return `${formatDecimal(value)} ${currency}`; } }
function formatDate(value: string | null) { return value ? new Intl.DateTimeFormat("es-CL", { dateStyle: "medium" }).format(new Date(value)) : "Sin fecha"; }
