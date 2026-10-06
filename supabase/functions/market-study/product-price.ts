type Row = Record<string, unknown>;
const row = (v: unknown): Row => v && typeof v === 'object' && !Array.isArray(v) ? v as Row : {};
export const schemaPrice = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+(?:\.\d{1,2})?$/.test(v) ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 && n <= 1e12 ? n : null;
};
const pesoPrice = (v: string): number | null => {
  const text = v.replace(/^\$\s*/, '').trim();
  return /^(?:\d{1,3}(?:\.\d{3})+|\d+)$/.test(text) ? schemaPrice(text.replace(/\./g, '')) : null;
};

export function singleOffer(product: Row): Row | null {
  const offers = [product.offers].flat().filter(v => v && typeof v === 'object').map(row);
  if (offers.length !== 1) return null;
  const offer = offers[0];
  if (offer['@type'] !== 'AggregateOffer') return offer;
  const children = Array.isArray(offer.offers) ? offer.offers.map(row) : [];
  const child = children[0], price = schemaPrice(child?.price);
  // An aggregate is usable only when it proves one offer, not a price range.
  if (Number(offer.offerCount) !== 1 || children.length !== 1 || child['@type'] !== 'Offer' || price === null ||
    schemaPrice(offer.lowPrice) !== price || schemaPrice(offer.highPrice) !== price ||
    offer.priceCurrency !== child.priceCurrency || (child.sku && child.sku !== product.sku)) return null;
  return child;
}

export function isMarketplaceSource(sourceUrl?: string): boolean {
  if (!sourceUrl) return false;
  const url = new URL(sourceUrl), host = url.hostname.replace(/^www\./, '');
  return host === 'sodimac.cl' && url.pathname.startsWith('/sodimac-cl/articulo/') ||
    host === 'falabella.com' && url.pathname.startsWith('/falabella-cl/product/');
}
export function marketplaceOffer(document: Document, product: Row, sourceUrl?: string): Row | null {
  if (!sourceUrl || !isMarketplaceSource(sourceUrl)) return null;
  const url = new URL(sourceUrl);
  let data: Row;
  try { data = row(row(row(JSON.parse(document.querySelector('script#__NEXT_DATA__')?.textContent || '')).props).pageProps); }
  catch { return null; }
  const p = row(data.productData), sku = String(product.sku || '');
  if (!sku || url.pathname.split('/').filter(Boolean).at(-1) !== sku || String(p.primaryVariantId) !== sku ||
    p.isPublished !== true || !Array.isArray(p.variants)) return null;
  const variants = p.variants.map(row).filter(v => String(v.id) === sku);
  if (variants.length !== 1) return null;
  const variant = variants[0];
  if (!Array.isArray(variant.prices)) return null;
  // Do not choose the cheapest offer: discard crossed-out and card-only prices.
  const prices = variant.prices.map(row).filter(v => v.crossed === false &&
    ['eventPrice', 'internetPrice', 'normalPrice'].includes(String(v.type)) && !v.label && !v.icons);
  if (prices.length !== 1 || !Array.isArray(prices[0].price) || prices[0].price.length !== 1) return null;
  const amount = pesoPrice(String(prices[0].price[0]));
  const offers = [product.offers].flat().map(row).filter(v => v['@type'] === 'Offer' && String(v.sku) === sku &&
    v.priceCurrency === 'CLP' && schemaPrice(v.price) === amount);
  if (amount === null || offers.length !== 1) return null;
  return {...offers[0], priceEvidence: `${prices[0].type}: ${prices[0].price[0]} CLP; SKU ${sku}; no tachado, sin condicion de tarjeta.`};
}

export function commerceProduct(document: Document, sourceUrl?: string): Row | null {
  if (!sourceUrl || !new URL(sourceUrl).hostname.endsWith('.cl') || !document.body.classList.contains('single-product')) return null;
  const heading = document.querySelector('h1.product_title'), container = heading?.closest('.product.type-product');
  if (!container || !container.classList.contains('product-type-simple')) return null;
  const prices = [...container.querySelectorAll('.summary .price, .elementor-widget-woocommerce-product-price .price')]
    .filter(n => n.closest('.product.type-product') === container && !n.closest('.related,.upsells,.cross-sells'));
  if (prices.length !== 1 || /USD|US\$|EUR|cuotas|tarjeta|transferencia|desde|hasta/i.test(prices[0].textContent || '')) return null;
  const nodes = [...prices[0].querySelectorAll('.woocommerce-Price-amount')].filter(n => !n.closest('del,s'));
  if (nodes.length !== 1 || nodes[0].querySelector('.woocommerce-Price-currencySymbol')?.textContent?.trim() !== '$') return null;
  const price = pesoPrice(nodes[0].textContent || '');
  if (price === null) return null;
  const currency = document.querySelector('meta[property="product:price:currency"],meta[property="og:price:currency"]')?.getAttribute('content');
  if (currency && currency !== 'CLP') return null;
  const scoped = (selector: string) => [...container.querySelectorAll(selector)].find(n => n.closest('.product.type-product') === container);
  const stock = scoped('.stock'), description = scoped('.woocommerce-product-details__short-description');
  return {title: heading?.textContent?.trim(), sku: scoped('.sku')?.textContent?.trim(), description: description?.textContent?.trim().slice(0,3000),
    price, currency: 'CLP', currencyAssumed: !currency, singleProduct: true, priceEvidence: nodes[0].textContent?.trim(),
    availability: stock?.classList.contains('out-of-stock') ? 'https://schema.org/OutOfStock' : stock?.classList.contains('in-stock') ? 'https://schema.org/InStock' : null};
}
