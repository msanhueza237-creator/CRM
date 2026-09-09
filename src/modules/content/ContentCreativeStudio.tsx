import { useEffect, useState } from "react";
import { AlertTriangle, Check, Download, ImageIcon, RefreshCw, Shuffle } from "lucide-react";
import { fetchContentCreativePreview } from "../../lib/contentCenterApi";
import type { ContentCreativeLayout, ContentProduct, ContentVisualStyle } from "../../types/content";
import { creativeStyles, defaultCreativeLayout, renderContentCreative } from "./contentCreative";
import { getProductMediaUrls } from "./contentMedia";
import "./contentCreativeStudio.css";

export function useCreativeStudio(product: ContentProduct | undefined, layout: ContentCreativeLayout) {
  const [source, setSource] = useState<{ productId: string; blob: Blob }>();
  const [sourceError, setSourceError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [rendered, setRendered] = useState<{ product: ContentProduct; source: typeof source; layout: ContentCreativeLayout; preview: string; thumbnails: Record<string, string>; extension: string }>();
  const [renderError, setRenderError] = useState("");
  const productId = product?.id;
  const primaryUrl = getProductMediaUrls(product)[0];
  useEffect(() => {
    const controller = new AbortController();
    setSource(undefined); setSourceError("");
    if (productId && primaryUrl) void fetchContentCreativePreview(productId, controller.signal)
      .then((blob) => { if (!controller.signal.aborted) setSource({ productId, blob }); })
      .catch((error: Error) => { if (!controller.signal.aborted) setSourceError(error.message); });
    return () => controller.abort();
  }, [productId, primaryUrl, attempt]);
  useEffect(() => {
    let cancelled = false; const urls: string[] = [];
    setRenderError("");
    const timer = window.setTimeout(() => {
      if (!product || source?.productId !== product.id) return;
      const current = source;
      void (async () => {
        const thumbnails: Record<string, string> = {};
        const makeUrl = (blob: Blob) => { const url = URL.createObjectURL(blob); urls.push(url); return url; };
        for (const style of creativeStyles) {
          if (cancelled) return;
          const badge = layout.badge === defaultCreativeLayout(product, layout.style).badge
            ? defaultCreativeLayout(product, style.id).badge : layout.badge;
          const blob = await renderContentCreative({ imageBlob: current.blob, product, layout: { ...layout, style: style.id, badge } });
          if (cancelled) return;
          thumbnails[style.id] = makeUrl(blob);
        }
        thumbnails.original = makeUrl(current.blob);
        setRendered({ product, source: current, layout, preview: thumbnails[layout.style], thumbnails,
          extension: layout.style !== "original" ? "jpg" : current.blob.type.includes("png") ? "png" : current.blob.type.includes("webp") ? "webp" : "jpg" });
      })().catch((error: Error) => { if (!cancelled) setRenderError(error.message); });
    }, 180);
    return () => { cancelled = true; clearTimeout(timer); urls.forEach((url) => URL.revokeObjectURL(url)); };
  }, [product, source, layout]);
  const ready = Boolean(rendered && rendered.product === product && rendered.source === source && rendered.layout === layout);
  return { preview: ready ? rendered!.preview : "", thumbnails: ready ? rendered!.thumbnails : {}, extension: rendered?.extension || "jpg",
    loading: Boolean(productId && primaryUrl && !sourceError && !renderError && !ready), error: sourceError || renderError,
    retry: () => setAttempt((value) => value + 1), hasImage: Boolean(primaryUrl) };
}
export type CreativeStudioState = ReturnType<typeof useCreativeStudio>;

export function CreativeStylePicker({ studio, style, onChange, disabled }: {
  studio: CreativeStudioState; style: ContentVisualStyle; onChange: (style: ContentVisualStyle) => void; disabled: boolean;
}) {
  return <fieldset className="content-design-picker" disabled={disabled}>
    <legend>Diseño de la publicación</legend>
    <div className="content-design-options">
      {[...creativeStyles, { id: "original" as const, label: "Original", accent: "#647c80" }].map((item) =>
        <button key={item.id} type="button" className={style === item.id ? "active" : ""}
          aria-pressed={style === item.id} aria-label={`Diseño ${item.label}`} onClick={() => onChange(item.id)}>
          <span className={`content-design-thumb ${item.id}`}>
            {studio.thumbnails[item.id] ? <img src={studio.thumbnails[item.id]} alt="" /> : <ImageIcon size={28} aria-hidden="true" />}
          </span>
          <span className="content-design-label"><i style={{ background: item.accent }} aria-hidden="true" />{item.label}{style === item.id ? <Check size={16} /> : null}</span>
        </button>)}
    </div>
  </fieldset>;
}

export function CreativePreview({ studio, product, style, onAlternate, disabled, children }: {
  studio: CreativeStudioState; product?: ContentProduct; style: ContentVisualStyle; onAlternate: () => void; disabled: boolean; children?: React.ReactNode;
}) {
  function download() {
    if (!studio.preview) return;
    const link = document.createElement("a"); link.href = studio.preview;
    link.download = `CLIMACTIVA-${(product?.sku || "producto").replace(/[^a-z0-9-]/gi, "-")}-${style}.${studio.extension}`;
    link.click();
  }
  return <section className="content-creative-preview" aria-label="Vista previa del diseño">
    <header><div><span className="eyebrow">ESTUDIO VISUAL</span><h2>Vista previa</h2></div><span>{style === "original" ? "Imagen original" : "1080 × 1080"}</span></header>
    <div className="content-preview-surface" aria-busy={studio.loading}>
      {studio.preview ? <img src={studio.preview} alt={`Diseño ${creativeStyles.find((item) => item.id === style)?.label || "Original"}: ${product?.name || "producto"}`} />
        : <div className="content-preview-placeholder">{studio.error ? <AlertTriangle size={30} /> : <ImageIcon size={38} />}<strong>{studio.error || (studio.loading ? "Preparando diseño…" : "Sin imagen principal")}</strong>
          {studio.error ? <button type="button" className="ghost-button" onClick={studio.retry}><RefreshCw size={16} />Reintentar</button> : null}</div>}
    </div>
    <div className="content-preview-toolbar"><span>{creativeStyles.find((item) => item.id === style)?.label || "Original"} · 1 imagen</span>
      <button type="button" className="icon-button" title="Alternar diseño" aria-label="Alternar diseño" disabled={disabled} onClick={onAlternate}><Shuffle size={19} /></button>
      <button type="button" className="icon-button" title="Descargar diseño" aria-label="Descargar diseño" disabled={!studio.preview} onClick={download}><Download size={19} /></button>
    </div>
    {children}
  </section>;
}
