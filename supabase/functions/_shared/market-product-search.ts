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
  const pattern = /\b(\d+(?:[.,]\d+)?)\s*(pulgadas?|pulg\.?|inches?|["\u2033]|mm|cm|m|voltios?|volts?|v|kw|w|hz|btu(?:\/h)?|cfm|l\/min|l\/h)(?![a-z])/g;
  for (const m of input.matchAll(pattern)) {
    const n = Number(m[1].replace(',', '.')), unit = m[2];
    const length = /^(?:pulg|inch|["\u2033]|mm|cm|m$)/.test(unit);
    const kind = length ? 'medida' : /^(?:v|volt)/.test(unit) ? 'voltaje' : /^(?:k?w)$/.test(unit) ? 'potencia' : unit;
    const value = n * (length ? unit === 'mm' ? 1 : unit === 'cm' ? 10 : unit === 'm' ? 1000 : 25.4 : unit === 'kw' ? 1000 : 1);
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
