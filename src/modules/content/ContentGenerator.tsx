import { FormEvent, useEffect, useMemo, useState } from "react";
import { AlertTriangle, BadgePercent, CalendarClock, CheckCircle2, ClipboardCheck, Facebook, FileText, Hash, ImageIcon, Instagram, LayoutTemplate, RefreshCw, Send, ShieldCheck, Sparkles, Wrench, XCircle } from "lucide-react";
import {
  approveContentPublication,
  attachContentCreatives,
  fetchContentCreativeSource,
  generateSocialContent,
  publishContentPublication,
  rejectContentPublication,
  removeContentCreatives,
  scheduleContentPublication,
  uploadContentCreative,
} from "../../lib/contentCenterApi";
import type { ContentChannelCode, ContentCreativeLayout, ContentProduct, ContentPublication, ContentVisualStyle } from "../../types/content";
import { useAuth } from "../auth/AuthContext";
import { ContentMediaGallery } from "./ContentMediaGallery";
import { defaultCreativeLayout, renderContentCreative } from "./contentCreative";
import { getDesignedMediaCount, getOriginalPublicationMediaUrls, getProductMediaUrls, getPublicationMediaUrls } from "./contentMedia";
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
  const [cta, setCta] = useState("Conoce más en https://climactiva.cl");
  const [context, setContext] = useState("");
  const [variants, setVariants] = useState(1);
  const [useHashtags, setUseHashtags] = useState(true);
  const [operationMode, setOperationMode] = useState<"manual" | "approval">("approval");
  const [visualStyle, setVisualStyle] = useState<ContentVisualStyle>("editorial");
  const [visualHeadline, setVisualHeadline] = useState("");
  const [visualSupportingText, setVisualSupportingText] = useState("");
  const [visualBadge, setVisualBadge] = useState("");
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
  useEffect(() => {
    const defaults = defaultCreativeLayout(selectedProduct, visualStyle);
    setVisualHeadline(defaults.headline);
    setVisualSupportingText(defaults.supporting_text);
    setVisualBadge(defaults.badge);
  }, [selectedProduct, visualStyle]);

  function toggleChannel(channel: ContentChannelCode) {
    setChannels((current) => current.includes(channel) ? current.filter((item) => item !== channel) : [...current, channel]);
  }

  function generationInput(productId: string) {
    const product = data.products.find((item) => item.id === productId);
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
      visualLayout: visualLayoutFor(product),
    };
  }

  function visualLayoutFor(product?: ContentProduct): ContentCreativeLayout {
    if (!product || product.id !== selectedProduct?.id) return defaultCreativeLayout(product, visualStyle);
    return {
      style: visualStyle,
      headline: visualHeadline.trim() || product.name,
      supporting_text: visualSupportingText.trim(),
      badge: visualBadge.trim(),
      website: "climactiva.cl",
    };
  }

  async function applyCreativeLayout(
    publications: ContentPublication[],
    product: ContentProduct,
    layout: ContentCreativeLayout,
  ) {
    if (layout.style === "original" || !publications.length) return publications;
    const sourcePublication = publications[0];
    const sourceUrls = getOriginalPublicationMediaUrls(sourcePublication, product);
    if (!sourceUrls.length) throw new Error("El producto no tiene imágenes para diagramar.");
    const uploadedPaths: string[] = [];
    const designedMediaUrls: string[] = [];
    let attachmentStarted = false;
    try {
      for (let index = 0; index < sourceUrls.length; index += 1) {
        setBusy(`design-${index + 1}-${sourceUrls.length}`);
        const imageBlob = await fetchContentCreativeSource(sourcePublication.id, sourceUrls[index]);
        const creativeBlob = await renderContentCreative({
          imageBlob,
          layout,
          product,
          publication: sourcePublication,
          slideIndex: index,
          slideCount: sourceUrls.length,
        });
        const upload = await uploadContentCreative(sourcePublication.id, creativeBlob, index);
        uploadedPaths.push(upload.path);
        designedMediaUrls.push(upload.publicUrl);
      }
      attachmentStarted = true;
      const attached = await Promise.all(publications.map((publication) =>
        attachContentCreatives(publication.id, designedMediaUrls, layout)
      ));
      return attached.map((result) => result.publication);
    } catch (creativeError) {
      if (!attachmentStarted) await removeContentCreatives(uploadedPaths);
      throw creativeError;
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!selectedProductId || !channels.length) return;
    setBusy("generate");
    setError("");
    setNotice("");
    try {
      const result = await generateSocialContent(generationInput(selectedProductId));
      let publications = result.publications;
      if (visualStyle !== "original" && selectedProduct) {
        try {
          publications = await applyCreativeLayout(publications, selectedProduct, visualLayoutFor(selectedProduct));
        } catch (creativeError) {
          setGenerated(publications);
          setError(`Los textos quedaron guardados, pero no se pudo crear la diagramación: ${creativeError instanceof Error ? creativeError.message : "error inesperado"}`);
          await data.refresh();
          return;
        }
      }
      setGenerated(publications);
      setNotice(`${publications.length} borrador(es) creados${visualStyle === "original" ? "" : " con piezas gráficas de marca"} y verificación de hechos.`);
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
      const publications = await applyCreativeLayout(result.publications, nextProduct, defaultCreativeLayout(nextProduct, visualStyle));
      onProductChange(nextProduct.id);
      setGenerated(publications);
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
        <div className="panel-heading content-generator-heading"><div><h2>Generador con IA</h2><span>Contenido basado en datos verificados de Tiendanube</span></div><ShieldCheck size={22} /></div>

        <section className="content-generator-section">
          <div className="content-generator-section-heading"><strong>Producto y canales</strong><span>{availableProducts.length} productos disponibles</span></div>
          <label className="content-generator-field content-product-selector"><span>Producto</span><select required value={selectedProductId} onChange={(event) => onProductChange(event.target.value)}><option value="">Selecciona un producto</option>{availableProducts.map((product) => <option value={product.id} key={product.id}>{product.name}{product.sku ? ` · ${product.sku}` : ""}</option>)}</select></label>
          <fieldset className="content-channel-picker"><legend>Redes sociales</legend><button className={channels.includes("instagram") ? "active" : ""} type="button" aria-pressed={channels.includes("instagram")} onClick={() => toggleChannel("instagram")}><Instagram size={19} /> Instagram</button><button className={channels.includes("facebook") ? "active" : ""} type="button" aria-pressed={channels.includes("facebook")} onClick={() => toggleChannel("facebook")}><Facebook size={19} /> Facebook</button></fieldset>
        </section>

        <section className="content-generator-section">
          <div className="content-generator-section-heading"><strong>Estilo y formato</strong></div>
          <div className="content-generator-field-grid">
            <label className="content-generator-field"><span>Tipo</span><select value={publicationType} onChange={(event) => setPublicationType(event.target.value)}><option value="feed">Publicación de feed</option><option value="product">Producto destacado</option><option value="educational">Educativa</option><option value="promotion">Promoción</option></select></label>
            <label className="content-generator-field"><span>Plantilla</span><select value={templateId} onChange={(event) => setTemplateId(event.target.value)}>{data.bootstrap?.templates.filter((item) => item.active).map((template) => <option value={template.id} key={template.id}>{template.name}</option>)}</select></label>
            <label className="content-generator-field"><span>Personalidad</span><select value={brandId} onChange={(event) => setBrandId(event.target.value)}>{data.bootstrap?.brands.map((brand) => <option value={brand.id} key={brand.id}>{brand.name}</option>)}</select></label>
            <label className="content-generator-field content-variants-field"><span>Variantes por red</span><input type="number" min={1} max={3} value={variants} onChange={(event) => setVariants(Number(event.target.value))} /></label>
          </div>
          <fieldset className="content-visual-picker">
            <legend>Diagramación de imágenes</legend>
            <button className={visualStyle === "original" ? "active" : ""} type="button" aria-pressed={visualStyle === "original"} onClick={() => setVisualStyle("original")}><ImageIcon size={18} /><span><strong>Original</strong><small>Fotografías sin intervención</small></span></button>
            <button className={visualStyle === "editorial" ? "active" : ""} type="button" aria-pressed={visualStyle === "editorial"} onClick={() => setVisualStyle("editorial")}><LayoutTemplate size={18} /><span><strong>Editorial</strong><small>Título, beneficio y marca</small></span></button>
            <button className={visualStyle === "technical" ? "active" : ""} type="button" aria-pressed={visualStyle === "technical"} onClick={() => setVisualStyle("technical")}><Wrench size={18} /><span><strong>Técnica</strong><small>Presentación profesional</small></span></button>
            <button className={visualStyle === "promotion" ? "active" : ""} type="button" aria-pressed={visualStyle === "promotion"} onClick={() => setVisualStyle("promotion")}><BadgePercent size={18} /><span><strong>Promoción</strong><small>Precio o dato destacado</small></span></button>
          </fieldset>
          {visualStyle !== "original" ? <div className="content-visual-editor">
            <div className="content-visual-editor-heading"><div><strong>Contenido dentro de la pieza</strong><span>Se aplicará únicamente a la imagen principal del producto.</span></div><span className={`content-visual-swatch ${visualStyle}`} aria-hidden="true" /></div>
            <label className="content-generator-field"><span>Titular visual</span><input maxLength={120} value={visualHeadline} onChange={(event) => setVisualHeadline(event.target.value)} /></label>
            <div className="content-generator-field-grid">
              <label className="content-generator-field"><span>Dato destacado</span><input maxLength={80} value={visualBadge} onChange={(event) => setVisualBadge(event.target.value)} placeholder="SKU, medida o precio verificado" /></label>
              <label className="content-generator-field"><span>Sitio web</span><input value="climactiva.cl" readOnly /></label>
            </div>
            <label className="content-generator-field"><span>Beneficio breve verificado</span><textarea maxLength={240} value={visualSupportingText} onChange={(event) => setVisualSupportingText(event.target.value)} /></label>
          </div> : null}
        </section>

        <section className="content-generator-section">
          <div className="content-generator-section-heading"><strong>Mensaje</strong></div>
          <div className="content-generator-copy-grid">
            <label className="content-generator-field"><span>Objetivo</span><input value={objective} onChange={(event) => setObjective(event.target.value)} /></label>
            <label className="content-generator-field"><span>Llamada a la acción</span><input value={cta} onChange={(event) => setCta(event.target.value)} /></label>
          </div>
          <label className="content-generator-field"><span>Contexto de campaña, fecha o temporada</span><textarea value={context} onChange={(event) => setContext(event.target.value)} placeholder="Opcional. No agregues datos del producto que no estén verificados en Tiendanube." /></label>
        </section>

        <div className="content-generator-preferences">
          <label className="content-hashtag-toggle" title="#Climactiva se incluye siempre"><input type="checkbox" checked={useHashtags} onChange={(event) => setUseHashtags(event.target.checked)} /><Hash size={17} /> Agregar hashtags adicionales</label>
          <fieldset className="content-mode-picker"><legend>Flujo de revisión</legend><button className={operationMode === "manual" ? "active" : ""} type="button" aria-pressed={operationMode === "manual"} onClick={() => setOperationMode("manual")}><FileText size={17} /> Manual</button><button className={operationMode === "approval" ? "active" : ""} type="button" aria-pressed={operationMode === "approval"} onClick={() => setOperationMode("approval")}><ClipboardCheck size={17} /> Con aprobación</button></fieldset>
        </div>
        {selectedProduct ? <ProductFacts product={selectedProduct} /> : null}
        {error ? <div className="notice-banner error"><AlertTriangle size={18} /> {error}</div> : null}
        {notice ? <div className="notice-banner success"><CheckCircle2 size={18} /> {notice}</div> : null}
        <div className="content-generator-submit"><span>{channels.length ? `${channels.length} ${channels.length === 1 ? "canal seleccionado" : "canales seleccionados"}` : "Selecciona al menos un canal"}</span><button className="primary-button" type="submit" disabled={Boolean(busy) || !selectedProductId || !channels.length}><Sparkles size={18} /> {busy === "generate" ? "Generando y verificando..." : busy.startsWith("design-") ? `Diagramando ${busy.split("-")[1]} de ${busy.split("-")[2]}...` : "Generar borradores"}</button></div>
      </form>

      <section className="content-generated-column">
        <div className="content-generated-heading"><div><h2>Resultado</h2><span>Versiones específicas por canal</span></div></div>
        {generated.map((publication) => {
          const channel = data.bootstrap?.channels.find((item) => item.id === publication.channel_id);
          const publicationProduct = data.products.find((item) => item.id === publication.product_id);
          const publicationImages = getPublicationMediaUrls(publication, publicationProduct);
          const designedMediaCount = getDesignedMediaCount(publication);
          const isAdmin = user?.role === "administrador";
          return (
            <article className="content-draft-card" key={publication.id}>
              <div className="content-draft-card-heading"><span>{channel?.code === "instagram" ? <Instagram size={18} /> : <Facebook size={18} />}{channel?.name || "Red social"}</span>{designedMediaCount ? <span className="content-creative-status"><LayoutTemplate size={14} /> {designedMediaCount} {designedMediaCount === 1 ? "pieza diseñada" : "piezas diseñadas"}</span> : null}<span className={`content-state ${publication.status}`}>{statusLabel(publication.status)}</span></div>
              <ContentMediaGallery images={publicationImages} alt={publicationProduct?.name || "Producto"} />
              <div className="content-draft-copy"><p>{publication.body}</p>{publication.hashtags.length ? <div className="content-hashtags">{publication.hashtags.map((tag) => <span key={tag}>#{tag}</span>)}</div> : null}{publication.cta ? <strong>{publication.cta}</strong> : null}</div>
              <div className="content-draft-footer"><small>Modelo: {publication.model_name || "IA configurada"} · hechos verificados antes de guardar</small>
              {isAdmin && ["draft", "pending_approval"].includes(publication.status) ? <div className="content-review-actions"><button className="primary-button" type="button" disabled={Boolean(busy)} onClick={() => void approve(publication)}><CheckCircle2 size={17} /> {busy === `approve-${publication.id}` ? "Aprobando..." : "Aprobar"}</button><button className="ghost-button danger" type="button" disabled={Boolean(busy)} onClick={() => void reject(publication)}><XCircle size={17} /> {busy === `reject-${publication.id}` ? "Desaprobando..." : "Desaprobar"}</button>{publication.id === alternativeActionPublicationId && canTryAnotherProduct ? <button className="ghost-button content-alternative-action" type="button" disabled={Boolean(busy)} onClick={() => void tryAnotherProduct()}><RefreshCw size={17} /> {busy === "alternative" ? "Buscando alternativa..." : "Probar otro producto"}</button> : null}</div> : null}
              {publication.status === "approved" ? <div className="content-schedule-action"><label><span>Fecha y hora</span><input type="datetime-local" value={scheduleDates[publication.id] || ""} onChange={(event) => setScheduleDates((current) => ({ ...current, [publication.id]: event.target.value }))} /></label><button className="ghost-button" type="button" disabled={Boolean(busy)} onClick={() => void schedule(publication)}><CalendarClock size={17} /> Programar</button>{isAdmin ? <button className="primary-button" type="button" disabled={Boolean(busy)} onClick={() => void publish(publication)}><Send size={17} /> Publicar ahora</button> : null}</div> : null}</div>
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
  const imageCount = getProductMediaUrls(product).length;
  return <div className="content-fact-source"><ShieldCheck size={18} /><div><strong>Fuente autorizada</strong><span>{product.name} · {product.sku || "sin SKU"} · {formatMoney(product.promotional_price ?? product.price)} · stock {product.stock ?? "no informado"} · {imageCount ? "imagen principal lista para la publicación" : "sin imagen principal"}</span></div></div>;
}

function statusLabel(status: string) {
  return ({ draft: "Borrador", pending_approval: "Pendiente de aprobación", approved: "Aprobado", scheduled: "Programado", publishing: "Publicando", published: "Publicado", failed: "Error", cancelled: "Desaprobado" } as Record<string, string>)[status] || status;
}

function formatMoney(value: number | null) {
  return value === null ? "precio no informado" : new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 }).format(value);
}
