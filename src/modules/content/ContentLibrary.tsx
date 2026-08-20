import { useMemo, useState } from "react";
import { CalendarClock, ImageOff, PackageSearch, Pause, Play, Search, Send, Sparkles, X } from "lucide-react";
import { supabase } from "../../lib/supabase";
import type { ContentProduct, ContentPublication } from "../../types/content";
import type { ContentCenterData } from "./useContentCenter";

interface Props {
  data: ContentCenterData;
  onGenerate: (productId: string) => void;
}

export function ContentLibrary({ data, onGenerate }: Props) {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [status, setStatus] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const selected = data.products.find((item) => item.id === selectedId) || null;

  const filtered = useMemo(() => data.products.filter((product) => {
    const query = search.trim().toLocaleLowerCase("es-CL");
    if (query && !`${product.name} ${product.sku || ""} ${product.brand || ""}`.toLocaleLowerCase("es-CL").includes(query)) return false;
    if (category && product.category !== category) return false;
    if (status && productState(product, data.publications) !== status) return false;
    return true;
  }), [category, data.products, data.publications, search, status]);

  async function togglePause(product: ContentProduct) {
    if (!supabase) return;
    setBusy(true);
    const { error } = await supabase.from("content_products").update({
      paused: !product.paused,
      pause_reason: product.paused ? null : "Pausado manualmente desde la Biblioteca de Contenido",
    }).eq("id", product.id);
    setBusy(false);
    if (!error) await data.refresh();
  }

  return (
    <div className="content-view-stack">
      <section className="content-toolbar panel">
        <label className="search-field"><Search size={18} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar producto, SKU o marca" /></label>
        <label><span>Categoría</span><select value={category} onChange={(event) => setCategory(event.target.value)}><option value="">Todas</option>{data.categories.map((item) => <option key={item}>{item}</option>)}</select></label>
        <label><span>Estado</span><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">Todos</option><option value="never">Nunca publicado</option><option value="available">Disponible</option><option value="scheduled">Programado</option><option value="recent">Publicado recientemente</option><option value="paused">Pausado</option><option value="incomplete">Sin información suficiente</option><option value="error">Error de sincronización</option></select></label>
        <strong>{filtered.length} productos</strong>
      </section>

      <section className={selected ? "content-library-layout has-detail" : "content-library-layout"}>
        <div className="content-product-grid">
          {filtered.map((product) => {
            const state = productState(product, data.publications);
            const uses = data.publications.filter((item) => item.product_id === product.id);
            return (
              <article className="content-product-card" key={product.id}>
                <button className="content-product-image" type="button" onClick={() => setSelectedId(product.id)} aria-label={`Ver ${product.name}`}>
                  {product.primary_image_url ? <img src={product.primary_image_url} alt={product.name} /> : <ImageOff size={30} />}
                </button>
                <div className="content-product-card-body">
                  <div><span className={`content-state ${state}`}>{stateLabel(state)}</span><span>{product.sku || "Sin SKU"}</span></div>
                  <button type="button" onClick={() => setSelectedId(product.id)}><strong>{product.name}</strong></button>
                  <span>{product.category || "Sin categoría"} · {product.brand || "Sin marca"}</span>
                  <div className="content-product-stats"><span><Send size={14} /> {uses.filter((item) => item.status === "published").length}</span><span><CalendarClock size={14} /> {uses.filter((item) => item.status === "scheduled").length}</span></div>
                  <button className="primary-button" type="button" disabled={product.sync_status !== "synced" || product.paused} onClick={() => onGenerate(product.id)}><Sparkles size={16} /> Generar</button>
                </div>
              </article>
            );
          })}
          {!filtered.length ? <div className="panel empty-state"><PackageSearch size={30} /><strong>No hay productos con estos filtros</strong><span>Cambia la búsqueda o sincroniza el catálogo.</span></div> : null}
        </div>

        {selected ? (
          <aside className="content-product-detail panel">
            <div className="panel-heading"><div><span>Ficha inteligente</span><h2>{selected.name}</h2></div><button className="icon-button" type="button" onClick={() => setSelectedId(null)} aria-label="Cerrar detalle"><X size={18} /></button></div>
            <div className="content-detail-image">{selected.primary_image_url ? <img src={selected.primary_image_url} alt={selected.name} /> : <ImageOff size={36} />}</div>
            <dl className="content-facts">
              <div><dt>SKU</dt><dd>{selected.sku || "No informado"}</dd></div>
              <div><dt>Categoría</dt><dd>{selected.category || "No informada"}</dd></div>
              <div><dt>Marca</dt><dd>{selected.brand || "No informada"}</dd></div>
              <div><dt>Precio</dt><dd>{formatMoney(selected.promotional_price ?? selected.price)}</dd></div>
              <div><dt>Stock</dt><dd>{selected.stock ?? "No informado"}</dd></div>
              <div><dt>Sincronización</dt><dd>{formatDateTime(selected.last_synced_at)}</dd></div>
            </dl>
            {selected.missing_fields.length ? <div className="notice-banner warning">Faltan datos: {selected.missing_fields.join(", ")}</div> : null}
            <p className="content-product-description">{selected.description_text || "Tiendanube no contiene una descripción utilizable."}</p>
            <PublicationHistory product={selected} publications={data.publications} channels={data.bootstrap?.channels || []} />
            <div className="form-actions">
              <button className="ghost-button" type="button" disabled={busy} onClick={() => void togglePause(selected)}>{selected.paused ? <Play size={17} /> : <Pause size={17} />}{selected.paused ? "Reactivar" : "Pausar"}</button>
              <button className="primary-button" type="button" disabled={selected.sync_status !== "synced" || selected.paused} onClick={() => onGenerate(selected.id)}><Sparkles size={17} /> Generar contenido</button>
            </div>
          </aside>
        ) : null}
      </section>
    </div>
  );
}

function PublicationHistory({ product, publications, channels }: { product: ContentProduct; publications: ContentPublication[]; channels: Array<{ id: string; name: string }> }) {
  const rows = publications.filter((item) => item.product_id === product.id).slice(0, 5);
  return <div className="content-product-history"><strong>Historial reciente</strong>{rows.map((item) => <div key={item.id}><span>{channels.find((channel) => channel.id === item.channel_id)?.name || "Canal"}</span><span>{stateLabel(item.status === "published" ? "recent" : item.status)}</span><time>{formatDateTime(item.published_at || item.scheduled_at || item.created_at)}</time></div>)}{!rows.length ? <span>Nunca publicado</span> : null}</div>;
}

function productState(product: ContentProduct, publications: ContentPublication[]) {
  if (product.sync_status === "error") return "error";
  if (product.sync_status === "incomplete") return "incomplete";
  if (product.paused) return "paused";
  const rows = publications.filter((item) => item.product_id === product.id);
  if (rows.some((item) => item.status === "scheduled")) return "scheduled";
  if (rows.some((item) => item.status === "published" && item.published_at && Date.now() - new Date(item.published_at).getTime() < 14 * 86400000)) return "recent";
  return rows.length ? "available" : "never";
}

function stateLabel(value: string) {
  return ({ never: "Nunca publicado", available: "Disponible", scheduled: "Programado", recent: "Publicado recientemente", paused: "Pausado", incomplete: "Sin información suficiente", error: "Error de sincronización", approved: "Aprobado", draft: "Borrador", pending_approval: "Pendiente de aprobación", failed: "Error" } as Record<string, string>)[value] || value;
}

function formatMoney(value: number | null) {
  return value === null ? "No informado" : new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 }).format(value);
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("es-CL", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
}
