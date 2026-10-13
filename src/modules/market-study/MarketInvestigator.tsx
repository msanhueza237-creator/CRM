import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Check, RefreshCw, Search, Sparkles } from "lucide-react";
import Decimal from 'decimal.js';
import {
  getNativeStudySettings,
  selectNativeStudyModel,
  runNativeStudy,
  searchMarket,
  refreshMarketSources,
  previewMarketResearch,
  importMarketResearch,
  type NativeStudySettings,
} from "../../lib/marketStudyApi";
import {
  MARKET_SITES,
  marketSite,
  publicProductUrl,
  type NativeStudyJob,
} from "../../../supabase/functions/_shared/market-native-contract";
import type {
  MarketObservation,
  StoredMarketObservation,
  MarketReview,
  MarketUnit,
} from "../../../supabase/functions/_shared/market-study-contract";
import type { MarketProduct, MarketEvidenceFreshness } from "./marketMath";
import { MarketComparison } from './MarketComparison';
import { matchesMarketProduct, productNameQuery, publicProductDescription, marketSearchRestriction, normalizedMarketProfile } from '../../../supabase/functions/_shared/market-product-search';
const label = {
  title: "Producto",
  brand: "Marca",
  model: "Modelo",
  price: "Precio",
  currency: "Moneda",
  vat: "IVA",
  unit: "Unidad",
  package_quantity: "Presentacion",
  availability: "Disponibilidad",
};
const stateLabel = {
  running: "Consultando",
  completed: "Lista para revisar",
  failed: "Fuente no disponible",
  unknown: "Sin confirmacion",
};
export function MarketInvestigator({
  products,
  reload,
  savedJobIds,
  observations=[],
  reviews=[],
  evidence={},
  selectedKey,
  onSelect,
}: {
  products: MarketProduct[];
  reload: () => void;
  savedJobIds: string[];
  observations?: StoredMarketObservation[];
  reviews?: MarketReview[];
  evidence?:MarketEvidenceFreshness;
  selectedKey: string;
  onSelect: (key:string)=>void;
}) {
  const [settings, setSettings] = useState<NativeStudySettings | null>(null),
    [query, setQuery] = useState(""),
    [url, setUrl] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [active, setActive] = useState<NativeStudyJob | null>(null),
    [draft,setDraft]=useState<NativeStudyJob|null>(null);
  const [paidConfirmed,setPaidConfirmed]=useState(false);
  const refreshRequest=useRef<{jobId:string;revision:number;requestId:string}|null>(null);
  const refresh = async () => {
    try {
      setSettings(await getNativeStudySettings());
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "No se pudo consultar el historial.",
      );
    }
  };
  useEffect(() => {
    void refresh();
  }, []);
  useEffect(()=>{setDraft(null);setError('');setPaidConfirmed(false);refreshRequest.current=null;},[selectedKey]);
  useEffect(() => {
    if (!settings?.jobs.some((j) => j.state === "running")) return;
    const timer = setInterval(() => void refresh(), 12000);
    return () => clearInterval(timer);
  }, [settings]);
  const filtered = products.filter(
    (p) =>
      p.sku &&
      matchesMarketProduct(p,query),
  );
  const product = products.find((p) => p.key === selectedKey);
  const profile=product?normalizedMarketProfile({sku:product.sku,name:product.name,description:product.description,brand:product.brand,category:product.category,productUrl:product.sourceUrl}):null;
  const choice=settings?.choices.find(c=>c.choice===settings.selection.choice);
  const sourceReserve=choice?(30000*choice.input_usd_per_million+1024*choice.output_usd_per_million)/1000000:null;
  const dailyLimitReached = !!settings && settings.jobs_today >= settings.daily_jobs;
  const availableBudget = new Decimal(settings?.daily_usd || 0).minus(settings?.spent_usd || 0);
  const searchBudgetReached = availableBudget.lt('0.25');
  const searchesRemaining = settings ? Math.max(0, Math.min(settings.daily_jobs-settings.jobs_today, availableBudget.div('0.25').floor().toNumber())) : 0;
  const searchJob=(active?.result.kind==='market_search'&&active.sku===product?.sku?active:null)||settings?.jobs.find(j=>j.sku===product?.sku&&j.result.kind==='market_search')||null;
  const start = async (webSearch=false) => {
    if (!settings || !product || !paidConfirmed) return;
    setError("");
    setBusy(true);
    setActive(null);
    setDraft(null);
    try {
      if(!webSearch)marketSite(url);
      const description=publicProductDescription(product.description),brand=publicProductDescription(product.brand,120);
      const job = webSearch?await searchMarket({id:crypto.randomUUID(),sku:product.sku,title:product.name,revision:settings.selection.revision,...(description?{description}:{}),...(brand?{brand}:{}),...(product.category?{category:product.category}:{})}):await runNativeStudy({
        id: crypto.randomUUID(),
        sku: product.sku,
        url: url.trim(),
        revision: settings.selection.revision,
      });
      setActive(job);setPaidConfirmed(false);
    } catch (e) {
      setError(
        (e instanceof Error ? e.message : "No se recibio confirmacion.") +
          " Consulta el historial antes de iniciar otra consulta.",
      );
    } finally {
      await refresh();
      setBusy(false);
    }
  };
  const changeModel = async (choice: string) => {
    if (!settings) return;
    setBusy(true);
    setError("");
    try {
      setSettings(
        await selectNativeStudyModel({
          choice,
          revision: settings.selection.revision,
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se cambio el modelo.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="market-investigator">
      <div className="market-section-heading">
        <h2>
          <Search size={21} />
          Analizar y actualizar
        </h2>
        <button
          className="secondary"
          title="Actualizar historial"
          aria-label="Actualizar historial"
          onClick={() => void refresh()}
          disabled={busy}
        >
          <RefreshCw size={17} />
        </button>
      </div>
      <div className="market-form-grid">
        <label>
          Buscar producto
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Nombre, descripción, características o SKU"
          />
        </label>
        <label>
          Producto
          <select aria-label="Producto" value={selectedKey} onChange={(e) => onSelect(e.target.value)} disabled={busy}>
            <option value="">Seleccionar producto</option>
            {filtered.map((p) => (
              <option key={p.key} value={p.key}>
                {p.name} · {p.sku}{p.mode==='transit'?' · En importacion':''}
              </option>
            ))}
            {product && !filtered.some((p) => p.key === selectedKey) && (
              <option value={selectedKey}>
                {product.name} · {product.sku}{product.mode==='transit'?' · En importacion':''}
              </option>
            )}
          </select>
        </label>
      </div>
      {product&&profile&&<section className="market-profile" aria-label="Ficha normalizada"><h3>Ficha de investigación · {product.sku}</h3><dl><div><dt>Categoría</dt><dd>{profile.category||'Sin categoría verificada'}</dd></div><div><dt>Uso</dt><dd>{profile.use||'Uso sin confirmar'}</dd></div><div><dt>Marca</dt><dd>{profile.brand||'Marca pendiente'}</dd></div>{profile.attributes.map((attribute,index)=><div key={`${attribute.key}-${index}`}><dt>{attribute.key}</dt><dd>{attribute.value} · fuente: catálogo</dd></div>)}</dl><p>Datos disponibles del catálogo/inventario; origen y faltantes se indican abajo. Los criterios de búsqueda no reemplazan la ficha comercial ni confirman equivalencia.</p>{product.sourceUrl&&<a href={product.sourceUrl} target="_blank" rel="noreferrer">Ficha pública propia</a>}{[...profile.conflicts,...product.notices].map((notice,index)=><p key={index} className="market-warning">{notice}</p>)}{profile.missing.length>0&&<p>Para confirmar comparabilidad falta: {profile.missing.join(', ')}.</p>}</section>}
      {product&&marketSearchRestriction(product.sku)&&<p role="status" className="market-warning">{marketSearchRestriction(product.sku)!.notice}</p>}
      {product?.description&&<details className="market-muted"><summary>Descripción del producto</summary><p>{product.description}</p></details>}
      <details className="market-muted"><summary>Referencias conocidas</summary><div className="market-source-links" aria-label="Buscar en competidores">
        {MARKET_SITES.map((s) => (
          <a
            key={s.host}
            href={`https://www.google.com/search?q=${encodeURIComponent(`site:${s.host} ${product?productNameQuery(product.name,product.sku):query}`)}`}
            target="_blank"
            rel="noreferrer"
          >
            {s.name}
            <ArrowUpRight size={14} />
          </a>
        ))}
      </div></details>
      <div className="market-form-grid">
        <label>
          Modelo de investigacion
          <select
            disabled={busy || !settings}
            value={settings?.selection.choice || ""}
            onChange={(e) => void changeModel(e.target.value)}
          >
            {settings &&
              !settings.choices.some(
                (c) => c.choice === settings.selection.choice,
              ) && (
                <option value={settings.selection.choice}>
                  Modelo no disponible
                </option>
              )}
            {settings?.choices.map((c) => (
              <option key={c.choice} value={c.choice}>
                {c.provider === "deepseek" ? "DeepSeek" : "OpenAI"} · {c.model}
              </option>
            ))}
          </select>
        </label>
      </div>
      {searchJob?.state==='completed'&&<div className="market-actions"><button className="secondary" disabled={busy} onClick={async()=>{setBusy(true);setError('');setDraft(null);try{if(!refreshRequest.current||refreshRequest.current.jobId!==searchJob.id)refreshRequest.current={jobId:searchJob.id,revision:searchJob.result.source_revision||0,requestId:crypto.randomUUID()};const request=refreshRequest.current;setActive(await refreshMarketSources(request.jobId,request.revision,request.requestId));refreshRequest.current=null;await refresh();reload();}catch(e){setError(e instanceof Error?e.message:'No se actualizaron las fuentes.');}finally{setBusy(false);}}}><RefreshCw size={16}/>Analizar y actualizar fuentes</button><span className="market-muted">Solo URLs ya guardadas, sin descubrir tiendas nuevas: 0 llamadas y 0 tokens de IA, sin cargo del proveedor IA. El consumo de hosting/red no se mide aquí. Guarda una nueva lectura y conserva las anteriores; conserva una equivalencia humana previa solo cuando la evidencia técnica y presentación no cambian. No aprueba candidatas nuevas. {searchJob.result.refreshed_at?`Última lectura guardada: ${new Date(searchJob.result.refreshed_at).toLocaleString('es-CL')}. Revisión ${searchJob.result.source_revision||0}.`:''}</span></div>}
      <label className="market-check"><input type="checkbox" checked={paidConfirmed} onChange={e=>setPaidConfirmed(e.target.checked)}/>Autorizo esta consulta IA: búsqueda nueva reserva US$0,25; la extracción IA de un enlace conocido reserva {sourceReserve!==null&&Number.isFinite(sourceReserve)?`US$${sourceReserve.toFixed(4)}`:'un importe pendiente de tarifa'}. El costo final depende del consumo. Actualizar fuentes existentes hace 0 llamadas y consume 0 tokens de IA.</label>
      <div className="market-actions">
        <button
          disabled={
            busy ||
            !product || !paidConfirmed ||
            !settings?.enabled ||
            !settings?.web_search_supported ||
            !settings?.selection.choice.startsWith('deepseek:') ||
            dailyLimitReached || searchBudgetReached ||
            !settings?.choices.some(
              (c) => c.choice === settings.selection.choice,
            ) ||
            settings.jobs.some((j) => j.state === "running")
          }
          onClick={() => void start(true)}
        >
          <Sparkles size={18} />
          {busy ? "Buscando ofertas…" : "Buscar en el mercado"}
        </button>
        {settings && (
          <span className="market-muted">
            US${Number(settings.spent_usd).toFixed(4)} / US$
            {Number(settings.daily_usd).toFixed(2)} de presupuesto ocupado (reservas/estimaciones) hoy · {settings.jobs_today}/
            {settings.daily_jobs} consultas · {searchesRemaining} búsquedas disponibles · día de Chile
          </span>
        )}
      </div>
      {choice&&<p className="market-muted">Reserva conservadora de presupuesto, no cobro ni factura; el consumo web queda pendiente de conciliación. Tarifa: {choice.rate_source||'fuente pendiente'} · verificada {choice.rate_checked_at||'fecha pendiente'}. Guardar una oferta y confirmar equivalencia son pasos humanos separados.</p>}
      {dailyLimitReached&&<p className="market-muted">Limite diario de consultas alcanzado. Se renueva a las 00:00, hora de Chile.</p>}
      {settings&&!dailyLimitReached&&searchBudgetReached&&<p className="market-muted">Presupuesto diario insuficiente: cada busqueda reserva US$0,25. El historial sigue disponible.</p>}
      {settings&&!settings.selection.choice.startsWith('deepseek:')&&<p role="status">Busqueda web disponible con DeepSeek. Este modelo admite la revision de una fuente.</p>}
      {settings&&!settings.web_search_supported&&<p role="status">Busqueda automatica pendiente de habilitacion en el servidor.</p>}
      <details className="market-manual-source"><summary>Consultar un enlace conocido</summary><label>Enlace publico de la ficha del competidor<input type="url" value={url} onChange={e=>setUrl(e.target.value)} placeholder="https://..."/></label><button className="secondary" onClick={()=>void start()} disabled={busy||!paidConfirmed||!product||!url||dailyLimitReached||sourceReserve===null||!Number.isFinite(sourceReserve)||sourceReserve<=0||sourceReserve>0.25||availableBudget.lt(sourceReserve)||!settings?.enabled||settings.jobs.some(j=>j.state==='running')}><Sparkles size={16}/>Investigar fuente con IA</button></details>
      {error && <p role="alert">{error}</p>}
      {!settings && <p role="status">Consultando configuracion…</p>}

      {product&&<MarketComparison key={product.key} product={product} products={products} job={searchJob} observations={observations} reviews={reviews} evidence={evidence} onReview={async index=>{
        if(!searchJob)return;const o=searchJob.result.offers?.[index];if(!o)return;
        const existing=observations.filter(row=>row.payload.provider==='crm-native'&&row.payload.suggested_sku===searchJob.sku&&row.payload.source_url===o.url).sort((a,b)=>b.payload.revision-a.payload.revision)[0];
        const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([searchJob.sku,o.url])));
        const externalId=existing?.payload.external_id||`market-${Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('')}`;
        setDraft({...searchJob,id:externalId,source_url:o.url,result:{source_revision:searchJob.result.source_revision||0,text:o.evidence,observed_at:o.observed_at,attributes:[{field:'title',value:o.title,quote:o.title},...(o.amount!==null?[{field:'price',value:String(o.amount),quote:String(o.amount)}]:[]),...(o.currency?[{field:'currency',value:o.currency,quote:o.currency}]:[])]}});
      }}/>}
      {(draft||active?.state === "completed"&&active.result.kind!=='market_search'&&active.sku===product?.sku) && (
        <StudyDraft
          key={(draft||active)!.id}
          job={(draft||active)!}
          nextRevision={Math.max(0,...observations.filter(row=>row.payload.provider==='crm-native'&&row.payload.external_id===(draft||active)!.id).map(row=>row.payload.revision))+1}
          onSaved={() => {
            setActive(null);
            setDraft(null);
            reload();
          }}
        />
      )}
      {active && active.sku===product?.sku && active.state !== "completed" && (
        <p role="alert">{active.result.error || stateLabel[active.state]}</p>
      )}
      <h3>Consultas recientes</h3>
      {settings?.jobs.length === 0 && (
        <p className="market-muted">Sin consultas guardadas.</p>
      )}
      <div className="market-job-list">
        {settings?.jobs.map((j) => (
          <div className="market-job" key={j.id}>
            <div>
              <strong>{j.sku}</strong>
              <small>
                {new Date(j.created_at).toLocaleString("es-CL", {
                  timeZone: "America/Santiago",
                })}{" "}
                · {j.selection.model}
              </small>
              <a href={j.source_url} target="_blank" rel="noreferrer">
                {j.result.kind==='market_search'?'Busqueda de mercado':new URL(j.source_url).hostname}
              </a>
            </div>
            <div>
              <span>{stateLabel[j.state]}</span>
              <small>
                US${Number(j.estimated_usd ?? j.reserved_usd).toFixed(4)}
                {j.estimated_usd == null ? " reservados, no cobro confirmado" : " estimados según uso, no factura"}
              </small>
            </div>
            <button
              className="secondary"
              disabled={busy || savedJobIds.includes(j.id)}
              onClick={() => {setActive(j);setDraft(null);const p=products.find(p=>p.sku===j.sku);if(p&&p.key!==selectedKey)onSelect(p.key);}}
            >
              {savedJobIds.includes(j.id) ? "Guardado" : j.state === "completed" ? "Revisar" : "Ver detalle"}
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
function StudyDraft({
  job,
  nextRevision,
  onSaved,
}: {
  job: NativeStudyJob;
  nextRevision:number;
  onSaved: () => void;
}) {
  const attrs = job.result.attributes || [],
    value = (field: string) =>
      attrs.find((a) => a.field === field)?.value || "";
  const [title, setTitle] = useState(value("title")),
    [amount, setAmount] = useState(/^\d+(?:\.\d{1,2})?$/.test(value("price")) ? value("price") : ""),
    [currency, setCurrency] = useState(
      /^[A-Z]{3}$/.test(value("currency")) ? value("currency") : "",
    ),
    [vat, setVat] = useState<MarketObservation["vat_basis"]>("unknown"),
    [rate, setRate] = useState(""),
    [unit, setUnit] = useState(""),
    [quantity, setQuantity] = useState(""),
    [presentation, setPresentation] = useState(""),
    [availability, setAvailability] =
      useState<MarketObservation["availability"]>("unknown"),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const observation: MarketObservation = {
        provider: "crm-native",
        external_id: job.id,
        revision: nextRevision,
        product_label: title,
        suggested_sku: job.sku,
        seller: MARKET_SITES.find(s=>s.host.replace(/^www\./,'')===publicProductUrl(job.source_url).hostname.replace(/^www\./,''))?.name||publicProductUrl(job.source_url).hostname.replace(/^www\./,''),
        seller_kind: "competitor",
        amount: amount === "" ? null : Number(amount),
        currency: currency || null,
        vat_basis: vat,
        vat_percent: vat === "exempt" ? 0 : rate === "" ? null : Number(rate),
        unit: unit as MarketUnit,
        package_quantity: quantity === "" ? NaN : Number(quantity),
        presentation,
        availability,
        source_url: job.source_url,
        observed_at: job.result.observed_at || job.created_at,
        confidence: 0.9,
        fx: null,
        notes: `Datos revisados por administrador. Extraccion ${job.selection.provider}/${job.selection.model}. Equivalencia tecnica pendiente.`,
      };
      const body = { schema_version: 1, observations: [observation] },
        preview = await previewMarketResearch(body);
      if (!preview.canImport)
        throw new Error(preview.errors.map((e) => e.message).join(" "));
      await importMarketResearch(body);
      onSaved();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "No se guardo la investigacion.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="market-study-draft">
      <h3>Revision de la fuente · {job.sku}</h3>
      <a href={job.source_url} target="_blank" rel="noreferrer">
        Abrir ficha original <ArrowUpRight size={14} />
      </a>
      <dl className="market-evidence">
        {attrs.map((a) => (
          <div key={a.field}>
            <dt>{label[a.field as keyof typeof label] || a.field}</dt>
            <dd>
              <strong>{a.value}</strong>
              <small>{a.quote}</small>
            </dd>
          </div>
        ))}
      </dl>
      {!attrs.length && (
        <p className="market-warning">
          La fuente no entrego atributos verificables.
        </p>
      )}
      <div className="market-form-grid" onChange={()=>setConfirmed(false)}>
        <label>
          Nombre del producto
          <input value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label>
          Precio observado
          <input
            type="number"
            min="0"
            step="any"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </label>
        <label>
          Moneda
          <select
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
          >
            <option value="">No identificada</option>
            {["CLP", "USD", "EUR"].map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        <label>
          Base del precio
          <select
            value={vat}
            onChange={(e) => setVat(e.target.value as typeof vat)}
          >
            <option value="unknown">IVA por verificar</option>
            <option value="gross">Incluye IVA</option>
            <option value="net">Neto sin IVA</option>
            <option value="exempt">Exento</option>
          </select>
        </label>
        {vat === "gross" && (
          <label>
            IVA (%)
            <input
              type="number"
              min="0"
              max="100"
              value={rate}
              onChange={(e) => setRate(e.target.value)}
            />
          </label>
        )}
        <label>
          Unidad base
          <select aria-label="Unidad base" value={unit} onChange={(e) => setUnit(e.target.value)}>
            <option value="">Por confirmar</option>
            <option value="unit">Unidad</option>
            <option value="m">Metro</option>
            <option value="kg">Kilogramo</option>
            <option value="l">Litro</option>
          </select>
        </label>
        <label>
          Cantidad por presentacion
          <input
            type="number"
            min="0.000001"
            step="any"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
          />
        </label>
        <label>
          Presentacion
          <input
            value={presentation}
            onChange={(e) => setPresentation(e.target.value)}
            placeholder="Unidad, caja, rollo..."
          />
        </label>
        <label>
          Disponibilidad
          <select aria-label="Disponibilidad"
            value={availability}
            onChange={(e) =>
              setAvailability(e.target.value as typeof availability)
            }
          >
            <option value="unknown">Por verificar</option>
            <option value="available">Disponible</option>
            <option value="unavailable">No disponible</option>
          </select>
        </label>
      </div>
      <details>
        <summary>Texto publico consultado</summary>
        <pre className="market-source-text">{job.result.text}</pre>
      </details>
      <label className="market-check">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
        />
        Revise precio, moneda, IVA y presentacion contra la fuente original.
      </label>
      <button
        disabled={
          busy || !confirmed || !title || !unit || !quantity || !presentation
        }
        onClick={() => void save()}
      >
        <Check size={17} />
        {busy ? "Guardando…" : "Guardar para comparar"}
      </button>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
