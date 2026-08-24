import { FormEvent, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  AlertTriangle,
  Boxes,
  Calculator,
  CheckCircle2,
  CircleDollarSign,
  ClipboardList,
  Container,
  Edit3,
  Eye,
  FileSearch,
  History,
  Landmark,
  LoaderCircle,
  LockKeyhole,
  PackageOpen,
  Plus,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Ship,
  Trash2,
  UsersRound,
  X,
} from "lucide-react";
import { createForeignTradeOperation, deleteForeignTradeOperation } from "../../lib/foreignTradeApi";
import type {
  CreateForeignTradeOperationInput,
  ForeignTradeAuditEvent,
  ForeignTradeCenterData,
  ForeignTradeOperation,
  ForeignTradeOperationType,
  ForeignTradeSupplier,
} from "../../types/foreignTrade";
import { useForeignTradeCenter } from "./useForeignTradeCenter";
import { ForeignTradeOperationDetail } from "./ForeignTradeOperationDetail";
import { ForeignTradeSupplierDialog } from "./ForeignTradeSupplierDialog";

const views = [
  { id: "dashboard", label: "Resumen", icon: Landmark },
  { id: "operations", label: "Operaciones", icon: Ship },
  { id: "suppliers", label: "Proveedores", icon: UsersRound },
  { id: "settings", label: "Configuración", icon: Settings2 },
  { id: "audit", label: "Auditoría", icon: History },
] as const;

type ViewId = (typeof views)[number]["id"];

export function ForeignTradeCenterPage() {
  const { data, error, loading, refresh } = useForeignTradeCenter();
  const [params, setParams] = useSearchParams();
  const requestedView = params.get("view") as ViewId | null;
  const activeView = views.some((view) => view.id === requestedView) ? requestedView! : "dashboard";
  const selectedOperationId = params.get("operation");
  const [dialogType, setDialogType] = useState<ForeignTradeOperationType | null>(null);
  const [supplierDialog, setSupplierDialog] = useState<ForeignTradeSupplier | "new" | null>(null);
  const [notice, setNotice] = useState("");

  function navigate(view: ViewId) {
    setParams({ view });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function openOperationDetail(operationId: string) {
    setParams({ view: "operations", operation: operationId });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function openOperation(type: ForeignTradeOperationType) {
    setNotice("");
    setDialogType(type);
  }

  async function removeOperation(operation: ForeignTradeOperation) {
    const confirmation = window.prompt(
      `Esta acción eliminará la operación, sus productos, costos, conciliaciones y documentos privados.\n\nEscribe exactamente ${operation.reference} para confirmar:`,
    );
    if (confirmation === null) return;
    if (confirmation.trim().toLocaleUpperCase("es") !== operation.reference.trim().toLocaleUpperCase("es")) {
      window.alert("La referencia no coincide. No se eliminó la operación.");
      return;
    }
    try {
      const result = await deleteForeignTradeOperation(operation.id, confirmation);
      navigate("operations");
      await refresh();
      const counts = result.deleted_counts || {};
      const storageNotice = result.storage_cleanup_failed
        ? " Algunos archivos privados quedaron pendientes de limpieza en Storage."
        : "";
      setNotice(`Operación ${operation.reference} eliminada con ${counts.documents || 0} documento(s), ${counts.products || 0} producto(s) y ${counts.costs || 0} costo(s) relacionados.${storageNotice}`);
    } catch (deleteError) {
      const message = deleteError instanceof Error ? deleteError.message : "No se pudo eliminar la operación.";
      window.alert(humanizeOperationError(message));
    }
  }

  return (
    <section className="page-stack foreign-trade-center-page">
      <div className="page-heading foreign-trade-page-heading">
        <div>
          <p>Gestión privada de administración</p>
          <h1>Centro de Comercio Exterior</h1>
        </div>
        <div className="foreign-trade-heading-actions">
          <span className="foreign-trade-private-badge"><LockKeyhole size={15} /> Información gerencial</span>
          <button className="ghost-button" type="button" disabled={loading} onClick={() => void refresh()}>
            <RefreshCw className={loading ? "spin" : ""} size={17} /> Actualizar
          </button>
        </div>
      </div>

      <section className="foreign-trade-security-band">
        <ShieldCheck size={23} />
        <div>
          <strong>Aislamiento de costos activo</strong>
          <span>Acceso administrativo. El Agente Comercial no puede consultar costos, márgenes, proformas ni simulaciones; el contrato de agente autoriza exclusivamente a Comercio Exterior.</span>
        </div>
      </section>

      <nav className="content-module-tabs" aria-label="Secciones del Centro de Comercio Exterior">
        {views.map((view) => (
          <button className={activeView === view.id ? "active" : ""} type="button" key={view.id} onClick={() => navigate(view.id)}>
            <view.icon size={17} /><span>{view.label}</span>
          </button>
        ))}
      </nav>

      {loading && !data.operations.length ? (
        <div className="panel foreign-trade-loading"><LoaderCircle className="spin" size={28} /><strong>Preparando información privada</strong><span>Validando permisos, operaciones y parámetros históricos.</span></div>
      ) : null}
      {error ? <div className="notice-banner error"><AlertTriangle size={18} /> {error}</div> : null}
      {notice ? <div className="notice-banner success"><CheckCircle2 size={18} /> {notice}</div> : null}

      {!error ? (
        <>
          {activeView === "dashboard" ? <ForeignTradeOverview data={data} onNavigate={navigate} onNew={openOperation} onOpen={openOperationDetail} /> : null}
          {activeView === "operations" && selectedOperationId ? <ForeignTradeOperationDetail operationId={selectedOperationId} statuses={data.statuses} suppliers={data.suppliers} costParameters={data.costParameters} onBack={() => navigate("operations")} onDelete={removeOperation} onChanged={refresh} /> : null}
          {activeView === "operations" && !selectedOperationId ? <ForeignTradeOperations data={data} onNew={openOperation} onOpen={openOperationDetail} onDelete={removeOperation} /> : null}
          {activeView === "suppliers" ? <ForeignTradeSuppliers suppliers={data.suppliers} onNew={() => setSupplierDialog("new")} onEdit={setSupplierDialog} /> : null}
          {activeView === "settings" ? <ForeignTradeSettings data={data} /> : null}
          {activeView === "audit" ? <ForeignTradeAudit events={data.audit} /> : null}
        </>
      ) : null}

      {dialogType ? (
        <NewOperationDialog
          operationType={dialogType}
          data={data}
          onClose={() => setDialogType(null)}
          onCreated={async (operationId) => {
            setDialogType(null);
            setNotice(`Operación privada creada correctamente (${operationId.slice(0, 8)}).`);
            await refresh();
            navigate("operations");
          }}
        />
      ) : null}
      {supplierDialog ? <ForeignTradeSupplierDialog supplier={supplierDialog === "new" ? null : supplierDialog} onClose={() => setSupplierDialog(null)} onSaved={async () => { setSupplierDialog(null); setNotice("Proveedor guardado correctamente."); await refresh(); }} /> : null}
    </section>
  );
}

function ForeignTradeOverview({
  data,
  onNavigate,
  onNew,
  onOpen,
}: {
  data: ForeignTradeCenterData;
  onNavigate: (view: ViewId) => void;
  onNew: (type: ForeignTradeOperationType) => void;
  onOpen: (operationId: string) => void;
}) {
  const summary = data.summary;
  const recent = data.operations.slice(0, 6);
  return (
    <div className="foreign-trade-view-stack">
      <section className="foreign-trade-command-band">
        <div>
          <span>Inteligencia de importaciones</span>
          <h2>Decide antes de comprometer capital</h2>
          <p>Centraliza proveedores, mercadería, moneda, escenarios y evidencia histórica sin modificar precios comerciales ni ejecutar compras.</p>
        </div>
        <div>
          <button className="primary-button" type="button" onClick={() => onNew("simulation")}><Calculator size={18} /> Nueva simulación</button>
          <button className="ghost-button" type="button" onClick={() => onNew("proforma")}><FileSearch size={18} /> Registrar proforma</button>
        </div>
      </section>

      <section className="foreign-trade-quick-actions" aria-label="Accesos rápidos">
        <button type="button" onClick={() => onNew("shipment")}><Ship size={19} /><span>Nueva importación</span></button>
        <button type="button" onClick={() => onNew("quotation")}><ClipboardList size={19} /><span>Nueva cotización</span></button>
        <button type="button" onClick={() => onNavigate("operations")}><Boxes size={19} /><span>Comparar operaciones</span></button>
        <button type="button" onClick={() => onNavigate("suppliers")}><UsersRound size={19} /><span>Proveedores</span></button>
        <button type="button" onClick={() => onNavigate("audit")}><History size={19} /><span>Historial</span></button>
      </section>

      <section className="foreign-trade-kpi-grid">
        <TradeKpi icon={<ClipboardList />} label="En preparación" value={formatCount(summary.operations_in_preparation)} detail="Operaciones abiertas" />
        <TradeKpi icon={<FileSearch />} label="Proformas" value={formatCount(summary.proformas)} detail="Documentos registrados" />
        <TradeKpi icon={<PackageOpen />} label="Órdenes de compra" value={formatCount(summary.purchase_orders)} detail="Preparadas o emitidas" />
        <TradeKpi icon={<Ship />} label="Embarques activos" value={formatCount(summary.active_shipments)} detail="Producción a bodega" />
        <TradeKpi icon={<UsersRound />} label="Proveedores" value={formatCount(summary.suppliers)} detail="Activos" />
        <TradeKpi icon={<CircleDollarSign />} label="Valor comprado" value={formatUsd(summary.total_purchase_usd)} detail="Sin operaciones canceladas" />
        <TradeKpi icon={<Landmark />} label="Costo proyectado" value={formatClp(summary.projected_import_cost_clp)} detail="Escenarios base" />
        <TradeKpi icon={<Calculator />} label="Utilidad estimada" value={formatClp(summary.projected_profit_clp)} detail="No certificada" />
        <TradeKpi icon={<Container />} label="Volumen" value={`${formatDecimal(summary.total_cbm)} m³`} detail={`${formatCount(summary.product_lines)} líneas de producto`} />
        <TradeKpi icon={<AlertTriangle />} label="Alertas" value={formatCount(summary.open_alerts)} detail="Requieren revisión" tone={summary.open_alerts ? "warning" : "normal"} />
      </section>

      <section className="foreign-trade-overview-grid">
        <article className="panel foreign-trade-recent-panel">
          <div className="panel-heading"><div><h2>Últimas operaciones</h2><span>Simulaciones, proformas e importaciones</span></div><Ship size={21} /></div>
          <div className="foreign-trade-operation-list">
            {recent.map((operation) => <OperationRow key={operation.id} operation={operation} data={data} onOpen={() => onOpen(operation.id)} />)}
            {!recent.length ? <EmptyState icon={<Ship size={28} />} title="Aún no hay operaciones" detail="Crea una simulación para congelar sus supuestos iniciales." /> : null}
          </div>
          <button className="panel-link" type="button" onClick={() => onNavigate("operations")}>Ver todas las operaciones</button>
        </article>

        <article className="panel foreign-trade-control-panel">
          <div className="panel-heading"><div><h2>Calidad de información</h2><span>Lectura explícita de cada cifra</span></div><ShieldCheck size={21} /></div>
          <div className="foreign-trade-source-legend">
            <SourceLegend source="real" title="Real" detail="Confirmado por operación o documento final." />
            <SourceLegend source="document" title="Extraído" detail="Leído de archivo y pendiente de revisión humana." />
            <SourceLegend source="configured" title="Configurado" detail="Ingresado o aprobado por administración." />
            <SourceLegend source="estimated" title="Estimado" detail="Cálculo incompleto con faltantes visibles." />
            <SourceLegend source="simulated" title="Simulado" detail="Escenario que no altera el original." />
          </div>
        </article>
      </section>
    </div>
  );
}

function ForeignTradeOperations({ data, onNew, onOpen, onDelete }: { data: ForeignTradeCenterData; onNew: (type: ForeignTradeOperationType) => void; onOpen: (operationId: string) => void; onDelete: (operation: ForeignTradeOperation) => Promise<void> }) {
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const filtered = useMemo(() => data.operations.filter((operation) => {
    const matchesStatus = !status || operation.status === status;
    const term = search.trim().toLocaleLowerCase("es");
    const matchesSearch = !term || `${operation.reference} ${operation.title}`.toLocaleLowerCase("es").includes(term);
    return matchesStatus && matchesSearch;
  }), [data.operations, search, status]);

  return (
    <div className="foreign-trade-view-stack">
      <section className="foreign-trade-toolbar">
        <label><span>Buscar</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Referencia o nombre" /></label>
        <label><span>Estado</span><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">Todos</option>{data.statuses.filter((item) => item.active).map((item) => <option value={item.code} key={item.code}>{item.name}</option>)}</select></label>
        <button className="primary-button" type="button" onClick={() => onNew("simulation")}><Plus size={17} /> Nueva operación</button>
      </section>

      <section className="panel foreign-trade-table-panel">
        <div className="table-scroll"><table><thead><tr><th>Operación</th><th>Tipo</th><th>Proveedor</th><th>Estado</th><th>Valor</th><th>Tipo de cambio</th><th>Actualización</th><th aria-label="Acciones" /></tr></thead><tbody>
          {filtered.map((operation) => {
            const supplier = data.suppliers.find((item) => item.id === operation.supplier_id);
            const operationStatus = data.statuses.find((item) => item.code === operation.status);
            return <tr key={operation.id}><td><strong>{operation.title}</strong><span>{operation.reference}</span></td><td>{operationTypeLabel(operation.operation_type)}</td><td>{supplier?.name || "Sin proveedor"}</td><td><span className={`foreign-trade-status ${operationStatus?.color || "neutral"}`}>{operationStatus?.name || operation.status}</span></td><td>{formatUsd(operation.value_usd)}</td><td>{operation.exchange_rate_clp ? `$${formatDecimal(operation.exchange_rate_clp)} CLP` : "Falta configurar"}</td><td>{formatDate(operation.updated_at)}</td><td><div className="foreign-trade-row-actions"><button className="icon-button" type="button" title="Abrir ficha" onClick={() => onOpen(operation.id)}><Eye size={17} /></button><button className="icon-button danger" type="button" title="Eliminar operación y datos relacionados" onClick={() => void onDelete(operation)}><Trash2 size={17} /></button></div></td></tr>;
          })}
        </tbody></table></div>
        {!filtered.length ? <EmptyState icon={<ClipboardList size={28} />} title="Sin operaciones para este filtro" detail="Crea una simulación o cambia los criterios de búsqueda." /> : null}
      </section>
    </div>
  );
}

function ForeignTradeSuppliers({ suppliers, onNew, onEdit }: { suppliers: ForeignTradeSupplier[]; onNew: () => void; onEdit: (supplier: ForeignTradeSupplier) => void }) {
  return (
    <div className="foreign-trade-view-stack">
      <section className="panel foreign-trade-section-heading"><div><h2>Proveedores</h2><p>Fichas existentes del Agent Hub, ahora protegidas como información gerencial.</p></div><button className="primary-button" type="button" onClick={onNew}><Plus size={17} /> Nuevo proveedor</button></section>
      <section className="foreign-trade-supplier-grid">
        {suppliers.map((supplier) => (
          <article key={supplier.id}>
            <div><strong>{supplier.name}</strong><div className="foreign-trade-supplier-actions"><span className={supplier.active ? "active" : "inactive"}>{supplier.active ? "Activo" : "Inactivo"}</span><button className="icon-button" type="button" title="Editar proveedor" onClick={() => onEdit(supplier)}><Edit3 size={15} /></button></div></div>
            <p>{supplier.company_name || "Empresa no informada"}</p>
            <dl><div><dt>País</dt><dd>{supplier.country_code}{supplier.factory_city ? ` · ${supplier.factory_city}` : ""}</dd></div><div><dt>Moneda</dt><dd>{supplier.currency}</dd></div><div><dt>Producción</dt><dd>{supplier.default_production_days} días</dd></div><div><dt>Incoterms</dt><dd>{supplier.usual_incoterms.length ? supplier.usual_incoterms.join(", ") : "No configurados"}</dd></div></dl>
            <small>{supplier.contact_name || supplier.email || "Contacto pendiente"}</small>
          </article>
        ))}
        {!suppliers.length ? <div className="panel"><EmptyState icon={<UsersRound size={28} />} title="No hay proveedores registrados" detail="La gestión completa de proveedores se habilitará sobre esta misma entidad." /></div> : null}
      </section>
    </div>
  );
}

function ForeignTradeSettings({ data }: { data: ForeignTradeCenterData }) {
  return (
    <div className="foreign-trade-view-stack foreign-trade-settings-grid">
      <section className="panel">
        <div className="panel-heading"><div><h2>Flujo de operaciones</h2><span>Estados configurables, sin valores rígidos en React</span></div><ClipboardList size={21} /></div>
        <div className="foreign-trade-settings-list">{data.statuses.map((status) => <div key={status.code}><span className={`foreign-trade-status ${status.color}`}>{status.name}</span><p>{status.description}</p><small>{status.final_state ? "Estado final" : `Orden ${status.sort_order}`}</small></div>)}</div>
      </section>
      <section className="panel">
        <div className="panel-heading"><div><h2>Capacidad logística</h2><span>Referencias editables por tipo de transporte</span></div><Container size={21} /></div>
        <div className="foreign-trade-settings-list">{data.containerTypes.map((container) => <div key={container.id}><strong>{container.name}</strong><p>{container.reference_capacity_cbm ? `${formatDecimal(container.reference_capacity_cbm)} m³ referenciales` : "Capacidad definida por operación"}</p><small>{container.transport_type}</small></div>)}</div>
      </section>
      <section className="panel foreign-trade-parameter-panel">
        <div className="panel-heading"><div><h2>Parámetros de costos</h2><span>Tasas legales y costos separados de la interfaz</span></div><Settings2 size={21} /></div>
        {data.costParameters.length ? <div className="foreign-trade-settings-list">{data.costParameters.map((parameter) => <div key={parameter.id}><strong>{parameter.name}</strong><p>{parameter.numeric_value ?? "Sin valor"} {parameter.value_type === "percentage" ? "%" : parameter.currency || ""}</p><small>{parameter.source_label} · vigente desde {formatDate(parameter.valid_from)}</small></div>)}</div> : <EmptyState icon={<Settings2 size={28} />} title="Sin tasas configuradas" detail="La migración no presupone derechos, IVA ni tasas legales. Deben ingresarse y versionarse antes de calcular." />}
      </section>
    </div>
  );
}

function ForeignTradeAudit({ events }: { events: ForeignTradeAuditEvent[] }) {
  return (
    <section className="panel foreign-trade-audit-panel">
      <div className="panel-heading"><div><h2>Auditoría privada</h2><span>Valores anteriores, nuevos y origen del cambio</span></div><History size={21} /></div>
      <div className="foreign-trade-audit-list">
        {events.map((event) => (
          <article key={event.id}>
            <div className={`foreign-trade-audit-icon ${event.action}`}><History size={16} /></div>
            <div><strong>{auditTitle(event)}</strong><span>{event.origin}{event.agent_type ? ` · ${event.agent_type}` : ""}</span><details><summary>Ver cambios</summary><pre>{JSON.stringify({ anterior: event.old_values, nuevo: event.new_values }, null, 2)}</pre></details></div>
            <time>{formatDateTime(event.created_at)}</time>
          </article>
        ))}
        {!events.length ? <EmptyState icon={<History size={28} />} title="Sin cambios auditados" detail="La primera operación aparecerá aquí automáticamente." /> : null}
      </div>
    </section>
  );
}

function NewOperationDialog({
  operationType,
  data,
  onClose,
  onCreated,
}: {
  operationType: ForeignTradeOperationType;
  data: ForeignTradeCenterData;
  onClose: () => void;
  onCreated: (operationId: string) => Promise<void>;
}) {
  const [form, setForm] = useState<CreateForeignTradeOperationInput>({
    title: "",
    operationType,
    status: operationType === "proforma" ? "proforma_received" : "quotation",
    transportType: "sea",
    baseCurrency: "USD",
    exchangeRateSource: "manual",
    destinationPort: "San Antonio, Chile",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (form.title.trim().length < 3) throw new Error("Ingresa un nombre de al menos 3 caracteres.");
      const id = await createForeignTradeOperation(form);
      await onCreated(id);
    } catch (submitError) {
      setError(submitError instanceof Error ? humanizeOperationError(submitError.message) : "No se pudo crear la operación.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="foreign-trade-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <form className="foreign-trade-operation-dialog" role="dialog" aria-modal="true" aria-labelledby="foreign-trade-operation-title" onSubmit={submit}>
        <div className="foreign-trade-dialog-heading"><div><span>Registro privado</span><h2 id="foreign-trade-operation-title">Nueva {operationTypeLabel(operationType).toLocaleLowerCase("es")}</h2></div><button className="icon-button" type="button" title="Cerrar" onClick={onClose}><X size={18} /></button></div>
        <div className="foreign-trade-form-grid">
          <label className="wide-field"><span>Nombre de la operación</span><input autoFocus required maxLength={180} value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} placeholder="Ej. Herramientas HVAC septiembre" /></label>
          <label><span>Tipo</span><select value={form.operationType} onChange={(event) => setForm({ ...form, operationType: event.target.value as ForeignTradeOperationType })}><option value="simulation">Simulación</option><option value="quotation">Cotización</option><option value="proforma">Proforma</option><option value="purchase_order">Orden de compra</option><option value="shipment">Importación</option></select></label>
          <label><span>Referencia</span><input value={form.reference || ""} onChange={(event) => setForm({ ...form, reference: event.target.value })} placeholder="Automática si queda vacía" /></label>
          <label><span>Proveedor</span><select value={form.supplierId || ""} onChange={(event) => setForm({ ...form, supplierId: event.target.value })}><option value="">Sin proveedor todavía</option>{data.suppliers.filter((supplier) => supplier.active).map((supplier) => <option value={supplier.id} key={supplier.id}>{supplier.name}</option>)}</select></label>
          <label><span>Estado</span><select value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value })}>{data.statuses.filter((status) => status.active).map((status) => <option value={status.code} key={status.code}>{status.name}</option>)}</select></label>
          <label><span>Transporte</span><select value={form.transportType} onChange={(event) => setForm({ ...form, transportType: event.target.value as CreateForeignTradeOperationInput["transportType"] })}><option value="sea">Marítimo</option><option value="air">Aéreo</option><option value="land">Terrestre</option><option value="multimodal">Multimodal</option></select></label>
          <label><span>Incoterm</span><input value={form.incoterm || ""} onChange={(event) => setForm({ ...form, incoterm: event.target.value })} placeholder="EXW, FOB, CIF..." /></label>
          <label><span>Moneda</span><input value={form.baseCurrency} onChange={(event) => setForm({ ...form, baseCurrency: event.target.value })} maxLength={3} /></label>
          <label><span>Tipo de cambio CLP</span><input inputMode="decimal" value={form.exchangeRateClp || ""} onChange={(event) => setForm({ ...form, exchangeRateClp: event.target.value })} placeholder="Ej. 980" /></label>
          <label><span>Origen del tipo de cambio</span><select value={form.exchangeRateSource} onChange={(event) => setForm({ ...form, exchangeRateSource: event.target.value as CreateForeignTradeOperationInput["exchangeRateSource"] })}><option value="manual">Manual</option><option value="current">Actual</option><option value="conservative">Conservador</option><option value="custom">Personalizado</option></select></label>
          <label><span>Valor mercadería USD</span><input inputMode="decimal" value={form.valueUsd || ""} onChange={(event) => setForm({ ...form, valueUsd: event.target.value })} placeholder="0" /></label>
          <label><span>Capacidad objetivo m³</span><input inputMode="decimal" value={form.targetContainerCbm || ""} onChange={(event) => setForm({ ...form, targetContainerCbm: event.target.value })} placeholder="Ej. 68" /></label>
          <label><span>Puerto de origen</span><input value={form.originPort || ""} onChange={(event) => setForm({ ...form, originPort: event.target.value })} /></label>
          <label><span>Destino</span><input value={form.destinationPort || ""} onChange={(event) => setForm({ ...form, destinationPort: event.target.value })} /></label>
          <label className="wide-field"><span>Notas y supuestos</span><textarea value={form.notes || ""} onChange={(event) => setForm({ ...form, notes: event.target.value })} placeholder="Registra aquí lo que todavía es estimado o debe confirmarse." /></label>
        </div>
        {error ? <div className="notice-banner error"><AlertTriangle size={17} /> {error}</div> : null}
        <div className="foreign-trade-dialog-actions"><button className="ghost-button" type="button" onClick={onClose}>Cancelar</button><button className="primary-button" type="submit" disabled={busy}><Plus size={17} /> {busy ? "Creando..." : "Crear operación"}</button></div>
      </form>
    </div>
  );
}

function TradeKpi({ icon, label, value, detail, tone = "normal" }: { icon: React.ReactNode; label: string; value: string; detail: string; tone?: "normal" | "warning" }) {
  return <article className={tone}><div>{icon}<span>{label}</span></div><strong>{value}</strong><small>{detail}</small></article>;
}

function OperationRow({ operation, data, onOpen }: { operation: ForeignTradeOperation; data: ForeignTradeCenterData; onOpen: () => void }) {
  const status = data.statuses.find((item) => item.code === operation.status);
  const supplier = data.suppliers.find((item) => item.id === operation.supplier_id);
  return <div><button className="foreign-trade-operation-link" type="button" onClick={onOpen}><strong>{operation.title}</strong><span>{operation.reference} · {supplier?.name || "Sin proveedor"}</span></button><div><span className={`foreign-trade-status ${status?.color || "neutral"}`}>{status?.name || operation.status}</span><small>{formatUsd(operation.value_usd)}</small></div></div>;
}

function SourceLegend({ source, title, detail }: { source: string; title: string; detail: string }) {
  return <div><i className={source} /><div><strong>{title}</strong><span>{detail}</span></div></div>;
}

function EmptyState({ icon, title, detail }: { icon: React.ReactNode; title: string; detail: string }) {
  return <div className="empty-state">{icon}<strong>{title}</strong><span>{detail}</span></div>;
}

function operationTypeLabel(type: ForeignTradeOperationType) {
  return ({ simulation: "Simulación", quotation: "Cotización", proforma: "Proforma", purchase_order: "Orden de compra", shipment: "Importación" })[type];
}

function auditTitle(event: ForeignTradeAuditEvent) {
  const action = ({ insert: "Creación", update: "Actualización", delete: "Eliminación" } as Record<string, string>)[event.action] || event.action;
  return `${action} · ${event.entity_type.replace(/_/g, " ")}`;
}

function humanizeOperationError(message: string) {
  if (message.includes("duplicate key")) return "La referencia ya existe. Usa otra o déjala vacía para generarla automáticamente.";
  if (message.includes("foreign_trade_forbidden")) return "Tu usuario no tiene permiso para administrar Comercio Exterior.";
  if (message.includes("foreign_trade_invalid")) return "Revisa el nombre, estado, moneda y tipo de cambio ingresados.";
  if (message.includes("foreign_trade_operation_confirmation_mismatch")) return "La referencia escrita no coincide con la operación.";
  if (message.includes("delete_foreign_trade_operation") || message.includes("phase11")) return "Falta ejecutar supabase/foreign_trade_center_phase11_intelligent_normalization.sql en Supabase.";
  return message;
}

const usdFormatter = new Intl.NumberFormat("es-CL", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const clpFormatter = new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 });
const countFormatter = new Intl.NumberFormat("es-CL", { maximumFractionDigits: 0 });
const decimalFormatter = new Intl.NumberFormat("es-CL", { maximumFractionDigits: 2 });

function formatUsd(value: number) { return usdFormatter.format(Number(value || 0)); }
function formatClp(value: number) { return clpFormatter.format(Number(value || 0)); }
function formatCount(value: number) { return countFormatter.format(Number(value || 0)); }
function formatDecimal(value: number) { return decimalFormatter.format(Number(value || 0)); }
function formatDate(value: string | null) { return value ? new Intl.DateTimeFormat("es-CL", { dateStyle: "medium" }).format(new Date(value)) : "Sin fecha"; }
function formatDateTime(value: string) { return new Intl.DateTimeFormat("es-CL", { dateStyle: "short", timeStyle: "short" }).format(new Date(value)); }
