import { FormEvent, useEffect, useMemo, useState } from "react";
import { AlertTriangle, CalendarClock, CheckCircle2, Facebook, Instagram, RefreshCw, Send, ShieldCheck, Sparkles, XCircle } from "lucide-react";
import {
  approveContentPublication,
  generateSocialContent,
  publishContentPublication,
  rejectContentPublication,
  scheduleContentPublication,
} from "../../lib/contentCenterApi";
import type { ContentChannelCode, ContentPublication } from "../../types/content";
import { useAuth } from "../auth/AuthContext";
import type { ContentCenterData } from "./useContentCenter";

interface Props {
  data: ContentCenterData;
  selectedProductId: string;
  onProductChange: (id: string) => void;
}

export function ContentGenerator({ data, selectedProductId, onProductChange }: Props) {
  const { user } = useAuth();
  const [channels, setChannels] = useState<ContentChannelCode[]>(["instagram", "facebook"]);
  const [templateId, setTemplateId] = useState("");
  const [brandId, setBrandId] = useState("");
  const [publicationType, setPublicationType] = useState("feed");
  const [objective, setObjective] = useState("Presentar el producto y generar interés comercial");
  const [cta, setCta] = useState("Conoce más en climactiva.cl");
  const [context, setContext] = useState("");
  const [variants, setVariants] = useState(1);
  const [useHashtags, setUseHashtags] = useState(true);
  const [operationMode, setOperationMode] = useState<"manual" | "approval">("approval");
  const [generated, setGenerated] = useState<ContentPublication[]>([]);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [scheduleDates, setScheduleDates] = useState<Record<string, string>>({});

  const availableProducts = useMemo(() => data.products.filter((item) => item.source_status === "active" && item.sync_status === "synced" && !item.paused), [data.products]);
  const selectedProduct = data.products.find((item) => item.id === selectedProductId);
  const reviewableGenerated = generated.filter((item) => ["draft", "pending_approval"].includes(item.status));
  const hasCommittedGenerated = generated.some((item) => !["draft", "pending_approval", "cancelled"].includes(item.status));
  const canTryAnotherProduct = availableProducts.length > 1 && reviewableGenerated.length > 0 && !hasCommittedGenerated;
  const alternativeActionPublicationId = reviewableGenerated[0]?.id;

  useEffect(() => {
    if (!selectedProductId && availableProducts[0]) onProductChange(availableProducts[0].id);
  }, [availableProducts, onProductChange, selectedProductId]);
  useEffect(() => {
    if (!templateId && data.bootstrap?.templates[0]) setTemplateId(data.bootstrap.templates[0].id);
    if (!brandId && data.bootstrap?.brands[0]) setBrandId(data.bootstrap.brands[0].id);
  }, [brandId, data.bootstrap, templateId]);

  function toggleChannel(channel: ContentChannelCode) {
    setChannels((current) => current.includes(channel) ? current.filter((item) => item !== channel) : [...current, channel]);
  }

  function generationInput(productId: string) {
    return {
      productId,
      channels,
      templateId,
      brandProfileId: brandId,
      publicationType,
      objective,
      cta,
      context,
      variants,
      useHashtags,
      operationMode,
    };
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!selectedProductId || !channels.length) return;
    setBusy("generate");
    setError("");
    setNotice("");
    try {
      const result = await generateSocialContent(generationInput(selectedProductId));
      setGenerated(result.publications);
      setNotice(`${result.publications.length} borrador(es) creados con verificación de hechos.`);
      await data.refresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "No se pudo generar el contenido.");
    } finally {
      setBusy("");
    }
  }

  async function approve(publication: ContentPublication) {
    await act(`approve-${publication.id}`, async () => {
      const result = await approveContentPublication(publication.id);
      replaceGenerated(result.publication);
      setNotice("Contenido aprobado. Ya puedes programarlo o publicarlo.");
    });
  }

  async function reject(publication: ContentPublication) {
    await act(`reject-${publication.id}`, async () => {
      const result = await rejectContentPublication(publication.id);
      replaceGenerated(result.publication);
      setNotice("Borrador desaprobado. No se programara ni se publicara.");
    });
  }

  async function tryAnotherProduct() {
    if (availableProducts.length < 2) {
      setError("No hay otro producto elegible para probar.");
      return;
    }
    const currentIndex = availableProducts.findIndex((product) => product.id === selectedProductId);
    const nextProduct = availableProducts[(currentIndex + 1 + availableProducts.length) % availableProducts.length];
    if (!nextProduct || nextProduct.id === selectedProductId) {
      setError("No hay otro producto elegible para probar.");
      return;
    }

    await act("alternative", async () => {
      await Promise.all(reviewableGenerated.map((item) => rejectContentPublication(item.id, "Borrador reemplazado para probar otro producto.")));
      const result = await generateSocialContent(generationInput(nextProduct.id));
      onProductChange(nextProduct.id);
      setGenerated(result.publications);
      setNotice(`Se descartaron los borradores anteriores y se genero una alternativa para ${nextProduct.name}.`);
    });
  }

  async function schedule(publication: ContentPublication) {
    const date = scheduleDates[publication.id];
    if (!date) { setError("Elige la fecha y hora de publicación."); return; }
    await act(`schedule-${publication.id}`, async () => {
      const result = await scheduleContentPublication(publication.id, new Date(date).toISOString());
      replaceGenerated(result.publication);
      setNotice("Publicación agregada al calendario editorial.");
    });
  }

  async function publish(publication: ContentPublication) {
    await act(`publish-${publication.id}`, async () => {
      const result = await publishContentPublication(publication.id);
      replaceGenerated(result.publication);
      if (result.publication.status === "published") setNotice("Meta confirmó la publicación.");
      else if (result.publication.error_message) setError(result.publication.error_message);
    });
  }

  async function act(key: string, callback: () => Promise<void>) {
    setBusy(key); setError(""); setNotice("");
    try { await callback(); await data.refresh(); }
    catch (actionError) { setError(actionError instanceof Error ? actionError.message : "No se pudo completar la acción."); }
    finally { setBusy(""); }
  }

  function replaceGenerated(publication: ContentPublication) {
    setGenerated((current) => current.map((item) => item.id === publication.id ? publication : item));
  }

  return (
    <div className="content-generator-layout">
      <form className="panel content-generator-form" onSubmit={submit}>
        <div className="panel-heading"><div><h2>Generador con IA</h2><span>Los hechos provienen exclusivamente de Tiendanube</span></div><ShieldCheck size={22} /></div>
        <div className="form-grid">
          <label className="wide-field"><span>Producto</span><select required value={selectedProductId} onChange={(event) => onProductChange(event.target.value)}><option value="">Selecciona un producto</option>{availableProducts.map((product) => <option value={product.id} key={product.id}>{product.name}{product.sku ? ` · ${product.sku}` : ""}</option>)}</select></label>
          <fieldset className="wide-field content-channel-picker"><legend>Redes sociales</legend><button className={channels.includes("instagram") ? "active" : ""} type="button" onClick={() => toggleChannel("instagram")}><Instagram size={19} /> Instagram</button><button className={channels.includes("facebook") ? "active" : ""} type="button" onClick={() => toggleChannel("facebook")}><Facebook size={19} /> Facebook</button></fieldset>
          <label><span>Tipo</span><select value={publicationType} onChange={(event) => setPublicationType(event.target.value)}><option value="feed">Publicación de feed</option><option value="product">Producto destacado</option><option value="educational">Educativa</option><option value="promotion">Promoción</option></select></label>
          <label><span>Plantilla</span><select value={templateId} onChange={(event) => setTemplateId(event.target.value)}>{data.bootstrap?.templates.filter((item) => item.active).map((template) => <option value={template.id} key={template.id}>{template.name}</option>)}</select></label>
          <label><span>Personalidad</span><select value={brandId} onChange={(event) => setBrandId(event.target.value)}>{data.bootstrap?.brands.map((brand) => <option value={brand.id} key={brand.id}>{brand.name}</option>)}</select></label>
          <label><span>Variantes por red</span><input type="number" min={1} max={3} value={variants} onChange={(event) => setVariants(Number(event.target.value))} /></label>
          <label className="wide-field"><span>Objetivo</span><input value={objective} onChange={(event) => setObjective(event.target.value)} /></label>
          <label className="wide-field"><span>Llamada a la acción</span><input value={cta} onChange={(event) => setCta(event.target.value)} /></label>
          <label className="wide-field"><span>Contexto de campaña, fecha o temporada</span><textarea value={context} onChange={(event) => setContext(event.target.value)} placeholder="Opcional. No agregues datos del producto que no estén verificados en Tiendanube." /></label>
        </div>
        <div className="content-generator-options">
          <label><input type="checkbox" checked={useHashtags} onChange={(event) => setUseHashtags(event.target.checked)} /> Usar hashtags</label>
          <label><input type="radio" checked={operationMode === "manual"} onChange={() => setOperationMode("manual")} /> Manual</label>
          <label><input type="radio" checked={operationMode === "approval"} onChange={() => setOperationMode("approval")} /> Con aprobación</label>
        </div>
        {selectedProduct ? <ProductFacts product={selectedProduct} /> : null}
        {error ? <div className="notice-banner error"><AlertTriangle size={18} /> {error}</div> : null}
        {notice ? <div className="notice-banner success"><CheckCircle2 size={18} /> {notice}</div> : null}
        <div className="form-actions"><button className="primary-button" type="submit" disabled={busy === "generate" || !selectedProductId || !channels.length}><Sparkles size={18} /> {busy === "generate" ? "Generando y verificando..." : "Generar borradores"}</button></div>
      </form>

      <section className="content-generated-column">
        <div className="content-generated-heading"><div><h2>Resultado</h2><span>Versiones específicas por canal</span></div></div>
        {generated.map((publication) => {
          const channel = data.bootstrap?.channels.find((item) => item.id === publication.channel_id);
          const isAdmin = user?.role === "administrador";
          return (
            <article className="content-draft-card" key={publication.id}>
              <div className="content-draft-card-heading"><span>{channel?.code === "instagram" ? <Instagram size={18} /> : <Facebook size={18} />}{channel?.name || "Red social"}</span><span className={`content-state ${publication.status}`}>{statusLabel(publication.status)}</span></div>
              {publication.image_url ? <img src={publication.image_url} alt={selectedProduct?.name || "Producto"} /> : null}
              <p>{publication.body}</p>
              {publication.hashtags.length ? <div className="content-hashtags">{publication.hashtags.map((tag) => <span key={tag}>#{tag}</span>)}</div> : null}
              {publication.cta ? <strong>{publication.cta}</strong> : null}
              <small>Modelo: {publication.model_name || "IA configurada"} · hechos verificados antes de guardar</small>
              {isAdmin && ["draft", "pending_approval"].includes(publication.status) ? <div className="content-review-actions"><button className="ghost-button" type="button" disabled={Boolean(busy)} onClick={() => void approve(publication)}><CheckCircle2 size={17} /> {busy === `approve-${publication.id}` ? "Aprobando..." : "Aprobar"}</button><button className="ghost-button danger" type="button" disabled={Boolean(busy)} onClick={() => void reject(publication)}><XCircle size={17} /> {busy === `reject-${publication.id}` ? "Desaprobando..." : "Desaprobar"}</button>{publication.id === alternativeActionPublicationId && canTryAnotherProduct ? <button className="ghost-button content-alternative-action" type="button" disabled={Boolean(busy)} onClick={() => void tryAnotherProduct()}><RefreshCw size={17} /> {busy === "alternative" ? "Buscando alternativa..." : "Probar otro producto"}</button> : null}</div> : null}
              {publication.status === "approved" ? <div className="content-schedule-action"><input type="datetime-local" value={scheduleDates[publication.id] || ""} onChange={(event) => setScheduleDates((current) => ({ ...current, [publication.id]: event.target.value }))} /><button className="ghost-button" type="button" disabled={Boolean(busy)} onClick={() => void schedule(publication)}><CalendarClock size={17} /> Programar</button>{isAdmin ? <button className="primary-button" type="button" disabled={Boolean(busy)} onClick={() => void publish(publication)}><Send size={17} /> Publicar ahora</button> : null}</div> : null}
              {publication.error_message ? <div className="notice-banner error">{publication.error_message}</div> : null}
            </article>
          );
        })}
        {!generated.length ? <div className="panel empty-state"><Sparkles size={30} /><strong>Los borradores aparecerán aquí</strong><span>Instagram y Facebook recibirán textos diferentes basados en la misma ficha oficial.</span></div> : null}
      </section>
    </div>
  );
}

function ProductFacts({ product }: { product: ContentCenterData["products"][number] }) {
  return <div className="content-fact-source"><ShieldCheck size={18} /><div><strong>Fuente autorizada</strong><span>{product.name} · {product.sku || "sin SKU"} · {formatMoney(product.promotional_price ?? product.price)} · stock {product.stock ?? "no informado"}</span></div></div>;
}

function statusLabel(status: string) {
  return ({ draft: "Borrador", pending_approval: "Pendiente de aprobación", approved: "Aprobado", scheduled: "Programado", publishing: "Publicando", published: "Publicado", failed: "Error", cancelled: "Desaprobado" } as Record<string, string>)[status] || status;
}

function formatMoney(value: number | null) {
  return value === null ? "precio no informado" : new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 }).format(value);
}
