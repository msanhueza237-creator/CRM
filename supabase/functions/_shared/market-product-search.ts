export interface MarketSearchProfile { description?: string; brand?: string }
export const searchText = (value: string) => value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

// Only descriptive catalog text crosses the provider boundary, never raw records.
export function publicProductDescription(value: unknown, limit = 1800): string {
  if (typeof value !== 'string') return '';
  return value.replace(/<[^>]*>/g, ' ').split(/[\n;]|(?<=\.)\s+/)
    .filter(s => !/https?:|www\.|@|\b(?:costo|costos|margen|cliente|contacto|password|secret|token|api.key|factura|telefono|whatsapp|rut|fob|cif|exw)\b|\$|\b(?:CLP|USD|EUR)\b/i.test(s))
    .join(' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}

export function productNameQuery(name: string, sku: string): string {
  const escaped = sku.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const withoutSku = sku ? name.replace(new RegExp(`(^|\\s)${escaped}(?=\\s|$)`, 'ig'), ' ') : name;
  return withoutSku.replace(/\s+/g, ' ').replace(/^[\s\u00b7|-]+|[\s\u00b7|-]+$/g, '').trim() || name;
}

export function matchesMarketProduct(product: { name: string; sku: string; description?: string; brand?: string }, query: string): boolean {
  const terms = searchText(query).match(/[a-z0-9+]+/g) || [];
  const text = searchText([product.name, product.description, product.brand, product.sku].join(' '));
  return terms.every(t => text.includes(t));
}

type Feature = { kind: string; value: number; label: string };
export function productFeatures(text: string): Feature[] {
  const result: Feature[] = [];
  const input = searchText(text).replace(/\b(\d+)\s*\/\s*(\d+)\s*(?:pulgadas?|pulg\.?|inches?|["\u2033])/g, (_m, a, b) => `${Number(a) / Number(b)} pulgadas`);
  const pattern = /\b(\d+(?:[.,]\d+)?)\s*(pulgadas?|pulg\.?|inches?|["\u2033]|mm|cm|m|voltios?|volts?|v|kw|w|hz|btu(?:\/h)?|cfm|l\/min|l\/h|kilogramos?|kilos?|kg|gramos?|g)(?![a-z])/g;
  for (const m of input.matchAll(pattern)) {
    const n = Number(m[1].replace(',', '.')), unit = m[2];
    const length = /^(?:pulg|inch|["\u2033]|mm|cm|m$)/.test(unit);
    const mass = /^(?:kilogramos?|kilos?|kg|gramos?|g)$/.test(unit);
    const kind = mass ? 'masa' : length ? 'medida' : /^(?:v|volt)/.test(unit) ? 'voltaje' : /^(?:k?w)$/.test(unit) ? 'potencia' : unit;
    const value = n * (mass ? /^(?:gramos?|g)$/.test(unit) ? 0.001 : 1 : length ? unit === 'mm' ? 1 : unit === 'cm' ? 10 : unit === 'm' ? 1000 : 25.4 : unit === 'kw' ? 1000 : 1);
    result.push({ kind, value: Math.round(value * 10000) / 10000, label: m[0] });
    if (result.length === 12) break;
  }
  return result;
}

const stop = new Set('de del la las el los un una para con sin y o en por producto productos precio modelo marca chile venta nuevo nueva'.split(' '));
const synonyms: Record<string, string> = { redondo: 'circular', redonda: 'circular', round: 'circular', diffuser: 'difusor', digital: 'digital' };
function nameTerms(name: string, sku: string, brand = '') {
  const ignored = new Set(searchText(sku + ' ' + brand).match(/[a-z0-9]+/g) || []);
  return [...new Set((searchText(productNameQuery(name, sku)).match(/[a-z]+/g) || [])
    .filter(w => w.length > 2 && !stop.has(w) && !ignored.has(w))
    .map(w => w.endsWith('ores') ? w.slice(0, -2) : w.endsWith('s') ? w.slice(0, -1) : w).map(w => synonyms[w] || w))];
}

export function productSimilarity(name: string, sku: string, profile: MarketSearchProfile, candidateTitle: string, candidateDescription: string) {
  const expected = productFeatures(name + ' ' + (profile.description || ''));
  const offered = productFeatures(candidateTitle + ' ' + candidateDescription);
  const conflicts: string[] = [], matched: string[] = [], missing: string[] = [];
  for (const kind of new Set(expected.map(f => f.kind))) {
    const ours = expected.filter(f => f.kind === kind), theirs = offered.filter(f => f.kind === kind);
    if (!theirs.length) missing.push(...ours.map(f => f.label));
    else if (ours.some(a => !theirs.some(b => a.value === b.value))) conflicts.push(`${kind}: ${ours.map(f => f.label).join(', ')} / ${theirs.map(f => f.label).join(', ')}`);
    else matched.push(...ours.map(f => f.label));
  }
  const oursKit = /\b(?:kit|pack|juego|combo|set)\b/i.test(name), theirsKit = /\b(?:kit|pack|juego|combo|set)\b/i.test(candidateTitle);
  if (oursKit !== theirsKit) conflicts.push('Presentacion: conjunto y producto individual.');
  const terms = nameTerms(name, sku, profile.brand), candidates = nameTerms(candidateTitle + ' ' + candidateDescription, '', '');
  const common = terms.filter(t => candidates.includes(t));
  // Similarity is a discovery aid, not technical equivalence or a price approval.
  const similar = (common.length >= 2 || common.length === 1 && matched.length > 0) && common.length / terms.length >= 0.6;
  return { similar, conflicts, matched, missing, common };
}

// User-requested discovery scope, not a catalog attribute or equivalence approval.
// Exact SKU only: capacity restrictions must never leak to other products.
export function marketSearchRestriction(sku:string) {
  return sku==='LX-36575'?{
    query:'balanza digital capacidad 100 kg climatizacion refrigeracion',
    description:'Contexto sectorial: Herramientas para Climatizacion. Criterio de busqueda solicitado: tiendas .cl de climatizacion o refrigeracion y capacidad de pesaje explicita de 100 kg. No confirma uso para refrigerantes, marca, modelo ni equivalencia.',
    notice:'Filtro solicitado para LX-36575: tiendas .cl de climatización/refrigeración y capacidad de pesaje de 100 kg. La descripción histórica del catálogo menciona alimentos, paquetería y equipaje; esos usos no dirigirán esta búsqueda. Es una restricción de búsqueda, no una ficha técnica confirmada. Actualizar fuentes relee las URLs existentes; no descubre tiendas nuevas ni aprueba equivalencias.',
  }:null;
}

// Only product-title or explicitly labelled weighing capacity qualifies. Shipping
// weights, unrelated page copy, alternatives and ranges ending elsewhere do not.
export function scaleCapacity100(title:string,description:string) {
  const t=searchText(title),d=searchText(description);
  const mass=/(\d+(?:[.,]\d+)?)\s*(kilogramos?|kilos?|kg|gramos?|g)(?![a-z])/g;
  const values=(text:string)=>[...text.matchAll(mass)].map(m=>Number(m[1].replace(',','.'))*(/^(?:gramos?|g)$/.test(m[2])?.001:1));
  const ambiguous=/(?:\d+(?:[.,]\d+)?\s*(?:kg|g)?\s*[-/–]\s*\d)|(?:\d+\s*(?:kg|kilogramos?)\s*(?:o|y)\s*\d)/;
  const labelled=[...d.matchAll(/(?:capacidad(?:\s+(?:de\s+(?:pesaje|peso)|maxima|de\s+carga))?|peso\s+maximo|carga\s+maxima|rango\s+de\s+pesaje)\s*[:=]?\s*(?:hasta\s+)?(\d[^.;\n]{0,64})/g)].filter(m=>!/(?:relacionad|otros? productos?|otros? modelos?|tambien disponible|envio|embalaje)/.test(d.slice(Math.max(0,m.index-65),m.index))).map(m=>m[1]);
  if(labelled.length){
    const caps=labelled.flatMap(s=>{const range=s.match(/^0\s*(?:kg\s*)?(?:-|–|a)\s*(100\s*(?:kg|kilogramos?))/);return range?values(range[1]):ambiguous.test(s)?[NaN]:values(s).slice(0,1);});
    if(caps.length)return caps.every(n=>n===100)&&values(t).every(n=>n===100)?labelled.join(' · ').slice(0,180):null;
  }
  const caps=values(t);
  return /\bbalanza\b/.test(t)&&!/(?:envio|embalaje|paquete|peso\s+bruto)/.test(t)&&!ambiguous.test(t)&&caps.length===1&&caps[0]===100?title.slice(0,180):null;
}
