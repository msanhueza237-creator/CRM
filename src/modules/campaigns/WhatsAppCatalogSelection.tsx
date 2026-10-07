import { useState } from "react";
import { ExternalLink, Package } from "lucide-react";
import type { WhatsAppCatalogSelection as Selection } from "../../lib/whatsappApi";

const number = (value: number | null) => value === null ? "Por verificar" : value.toLocaleString("es-CL", { maximumFractionDigits: 4 });
const money = (value: number | null, currency: string | null) => value === null ? "Por verificar" : `${currency === "CLP" ? "$" : ""}${number(value)} ${currency || "(moneda por verificar)"}`;
function ProductImage({ url, name }: { url: string | null; name: string }) {
  const [failed, setFailed] = useState(false);
  return <div className="wa-product-image">{url && !failed
    ? <img src={url} alt={name} referrerPolicy="no-referrer" loading="lazy" onError={() => setFailed(true)} />
    : <Package size={28} aria-label="Sin imagen disponible" />}</div>;
}

export function WhatsAppCatalogSelection({ selection }: { selection: Selection }) {
  return <div className="wa-catalog-selection">
    {selection.text && <p>{selection.text}</p>}
    <ul className="wa-catalog-items" aria-label={selection.kind === "order" ? "Productos del pedido" : "Producto consultado"}>
      {selection.items.map((item, index) => <li key={`${item.retailerId}:${index}`}>
        <div className="wa-product-heading">
          <ProductImage key={item.product?.imageUrl} url={item.product?.imageUrl || null} name={item.product?.name || "Producto sin identificar"} />
          <div><strong>{item.product?.name || "Producto sin identificar"}</strong>
            {item.product?.variant && <span>{item.product.variant}</span>}
            {item.product?.sku && <span>Referencia: {item.product.sku}</span>}
            <small>ID recibido: {item.retailerId || "Sin referencia"}</small>
          </div>
        </div>
        {selection.kind === "order" && <dl className="wa-product-amounts">
          <div><dt>Cantidad</dt><dd>{number(item.quantity)}</dd></div>
          <div><dt>Precio recibido / unidad</dt><dd>{money(item.unitPrice, item.currency)}</dd></div>
          <div><dt>Subtotal recibido</dt><dd>{money(item.total, item.currency)}</dd></div>
        </dl>}
        {item.product ? <div className="wa-product-source"><small>Ficha Tiendanube · {item.product.matchedBy === "variant_id" ? "ID de variante" : "SKU exacto"}</small>
          {item.product.url && <a href={item.product.url} target="_blank" rel="noopener noreferrer" title="Abrir ficha del producto en la tienda">Ver producto <ExternalLink size={14} /></a>}
        </div> : <p className="wa-product-unresolved">{item.resolution === "unavailable" ? "No se pudo consultar la ficha del producto." : item.resolution === "ambiguous" ? "La referencia coincide con más de un producto. Identificación pendiente." : "No hay una ficha vinculada a esta referencia."}</p>}
      </li>)}
    </ul>
    {selection.kind === "order" && <p className="wa-order-note">Pedido recibido; no confirma venta ni pago.</p>}
    <small>Catálogo Meta: {selection.catalogId}</small>
  </div>;
}
