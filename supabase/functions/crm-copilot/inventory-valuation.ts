import { CopilotDataError, normalized, numeric, type Row } from "./contracts.ts";
import { findProducts, resolveProducts } from "./product-resolution.ts";
import { productPrices } from "./product-prices.ts";
import { productProfitability } from "./product-profitability.ts";

const scale = 1000000n;
function fixed(value: unknown): bigint | null {
  const text = String(value ?? "");
  if (!/^-?\d+(?:\.\d{1,6})?$/.test(text)) return null;
  const [whole, fraction = ""] = text.replace("-", "").split(".");
  return (BigInt(whole) * scale + BigInt(fraction.padEnd(6, "0"))) * (text.startsWith("-") ? -1n : 1n);
}
function amount(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new CopilotDataError("La valorizacion excede la precision admitida.");
  }
  return Number(value) / Number(scale);
}
const sum = (values: unknown[]) => amount(values.reduce<bigint>((total, value) => total + (fixed(value) ?? 0n), 0n));
const multiply = (quantity: unknown, unit: unknown) => {
  const q = fixed(quantity), u = fixed(unit);
  return q !== null && q >= 0n && u !== null && u > 0n ? amount(q * u / scale) : null;
};
const validDate = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;

export function inventoryValuation(
  snapshots: Row[], details: Row[], catalog: Row[], args: Row,
  currencies: Record<string, string>, confirmations: Row, finance: boolean,
) {
  if (!snapshots.length && !details.length && !catalog.length) throw new CopilotDataError("No hay inventario disponible para valorizar.");
  if (!finance && args.stock_filter === "without_cost") throw new CopilotDataError("Tu perfil no autoriza consultar costos.", "FORBIDDEN");
  const all = resolveProducts(snapshots, details, catalog, false);
  const prices = productPrices(snapshots, details, catalog, { list_id: args.list_id }, currencies);
  const costs = finance ? productProfitability(details, catalog, { list_id: args.list_id }, currencies, confirmations).records : [];
  const priceGroups = new Map<string, Row[]>();
  for (const row of prices.records) priceGroups.set(String(row.sku), [...(priceGroups.get(String(row.sku)) || []), row]);
  const costGroups = new Map<string, Row[]>();
  for (const row of costs) costGroups.set(String(row.sku), [...(costGroups.get(String(row.sku)) || []), row]);
  const warnings: string[] = [];
  const multipleLists = !args.list_id && prices.availableLists.length > 1;
  if (multipleLists) warnings.push("Hay varias listas de venta. Selecciona una lista para valorizar la venta; no se suman precios de listas distintas.");
  let records: Row[] = findProducts(all, args.query)
    .filter(p => !args.brand || (p.brands as string[]).some(brand => normalized(brand) === normalized(args.brand)))
    .map(p => {
      const pp = priceGroups.get(String(p.sku)) || [];
      const price = !multipleLists && pp.length === 1 ? pp[0] : null;
      const cc = costGroups.get(String(p.sku)) || [];
      // A cost is independent of price-list selection. Conflicting cost identities stay unknown.
      const cost = cc.length && cc.every(c => c.recorded_unit_cost === cc[0].recorded_unit_cost && c.cost_currency === cc[0].cost_currency) ? cc[0] : null;
      const unitCost = numeric(cost?.recorded_unit_cost);
      const costCurrency = cost?.cost_currency || null;
      const conditionalCurrency = !costCurrency && cost?.cost_currency_id == null && unitCost !== null && price?.currency ? price.currency : null;
      const net = numeric(price?.net);
      const stock = numeric(p.stock);
      const saleValue = price?.currency && price.price_updated_at ? multiply(stock, net) : null;
      const costValue = costCurrency && cost?.cost_updated_at ? multiply(stock, unitCost) : null;
      const conditionalValue = conditionalCurrency && cost?.cost_updated_at ? multiply(stock, unitCost) : null;
      return {
        sku: p.sku, name: p.name, brand: (p.brands as string[]).join(", "), stock,
        stock_source: p.stock_source, stock_updated_at: p.stock_updated_at, stock_warnings: p.stock_warnings,
        net_price: net !== null && net > 0 ? net : null, price_currency: price?.currency || null,
        net_sale_value: saleValue, price_updated_at: price?.price_updated_at || null,
        units_sold: p.units_sold, sales_from: p.sales_from, sales_to: p.sales_to, last_sale_at: p.last_sale_at,
        match_type: p.match_type || "exact_terms", updated_at: p.stock_updated_at,
        ...(finance ? { unit_cost: unitCost, cost_currency: costCurrency, cost_value: costValue,
          assumed_cost_currency: conditionalCurrency, conditional_cost_value: conditionalValue,
          cost_reference_value: costValue ?? conditionalValue, cost_updated_at: cost?.cost_updated_at || null,
          cost_status: costCurrency && unitCost !== null ? "confirmed_currency" : conditionalCurrency ? "conditional_currency" : "unavailable" } : {}),
      };
    });
  records = records.filter(p => {
    const stock = numeric(p.stock);
    switch (args.stock_filter) {
      case "available": return stock !== null && stock > 0;
      case "zero": return stock === 0;
      case "unknown": return stock === null;
      case "low": return stock !== null && stock >= 0 && stock < Number(args.threshold ?? 10);
      case "without_movement": return stock !== null && stock > 0 && p.units_sold === 0;
      case "without_cost": return stock !== null && stock > 0 && p.cost_value === null;
      default: return true;
    }
  }).sort((a, b) => args.sort === "units" ? Number(b.stock ?? -Infinity) - Number(a.stock ?? -Infinity) || String(a.sku).localeCompare(String(b.sku)) : String(a.name).localeCompare(String(b.name), "es") || String(a.sku).localeCompare(String(b.sku)));
  const positive = records.filter(p => typeof p.stock === "number" && p.stock > 0);
  const known = records.filter(p => p.stock !== null);
  const currencyCodes = new Set<string>();
  for (const p of positive) {
    if (p.price_currency) currencyCodes.add(String(p.price_currency));
    if (finance && (p.cost_currency || p.assumed_cost_currency)) currencyCodes.add(String(p.cost_currency || p.assumed_cost_currency));
  }
  const byCurrency = [...currencyCodes].sort().map(currency => {
    const sale = positive.filter(p => p.price_currency === currency && p.net_sale_value !== null);
    const verified = positive.filter(p => p.cost_currency === currency && p.cost_value != null);
    const conditional = positive.filter(p => p.assumed_cost_currency === currency && p.conditional_cost_value != null);
    return { currency, net_sale_value: sale.length ? sum(sale.map(p => p.net_sale_value)) : null, sale_products: sale.length,
      ...(finance ? { cost_verified: verified.length ? sum(verified.map(p => p.cost_value)) : null,
        cost_conditional: conditional.length ? sum(conditional.map(p => p.conditional_cost_value)) : null,
        cost_reference: verified.length + conditional.length ? sum([...verified, ...conditional].map(p => p.cost_reference_value)) : null,
        cost_products: verified.length, conditional_cost_products: conditional.length } : {}),
    };
  });
  const missingStock = records.length - known.length;
  const missingPrices = positive.filter(p => p.net_sale_value === null).length;
  const missingCosts = positive.filter(p => p.cost_value == null).length;
  const conditionalCosts = positive.filter(p => p.conditional_cost_value != null).length;
  const missingCostValues = positive.filter(p => p.cost_reference_value == null).length;
  const negativeStock = known.filter(p => Number(p.stock) < 0).length;
  const dates = records.flatMap(p => [p.stock_updated_at, p.price_updated_at, ...(finance ? [p.cost_updated_at] : [])]).map(validDate).filter((d): d is string => !!d).sort();
  if (missingStock) warnings.push(`${missingStock} SKU tienen stock desconocido; no se consideran agotados ni se valorizan.`);
  if (missingPrices) warnings.push(`${missingPrices} SKU con stock no tienen precio neto verificable en la lista seleccionada.`);
  if (finance && conditionalCosts) warnings.push(`${conditionalCosts} SKU tienen moneda del costo sin confirmar. El costo referencial supone la misma moneda del precio de venta; no es una valorizacion confirmada.`);
  if (finance && missingCostValues) warnings.push(`${missingCostValues} SKU con stock no tienen costo valorizable; no se consideran de costo cero.`);
  if (negativeStock) warnings.push(`${negativeStock} SKU tienen stock negativo; se excluyen de las unidades disponibles y la valorizacion.`);
  if (records.some(p => p.match_type === "approximate_name")) warnings.push("Coincidencias aproximadas por nombre: confirmar el filtro antes de usar estos totales.");
  const unidentified = catalog.filter(p => !String(p.sku || "").trim() && !(Array.isArray(p.variants) && p.variants.some(v => v && typeof v === "object" && String(v.sku || "").trim()))).length;
  if (unidentified) warnings.push(`${unidentified} productos de catalogo sin SKU no se suman a identidades verificadas.`);
  return {
    records, totals: { matched_products: records.length, available_products: positive.length,
      available_units: !records.length || known.length ? sum(positive.map(p => p.stock)) : null, unidentified_catalog_products: unidentified,
      zero_stock_products: known.filter(p => p.stock === 0).length, unknown_stock_products: missingStock,
      negative_stock_products: negativeStock, missing_price_products: missingPrices,
      ...(finance ? { missing_confirmed_cost_products: missingCosts, conditional_cost_products: conditionalCosts,
        missing_cost_products: missingCostValues } : {}), by_currency: byCurrency },
    filters: { query: args.query || null, brand: args.brand || null, stock_filter: args.stock_filter || "all", list_id: args.list_id || null, threshold: args.threshold ?? 10 },
    available_lists: prices.availableLists,
    available_brands: [...new Set(all.flatMap(p => p.brands as string[]))].sort(),
    source_dates: { oldest: dates[0] || null, newest: dates.at(-1) || null },
    complete: !missingStock && !missingPrices && !negativeStock && !unidentified && (!finance || !missingCosts), warnings,
  };
}

export function inventorySummaryText(data: Row): string {
  const totals = data.totals as Row;
  const num = (v: unknown) => v == null ? "no disponible" : Number(v).toLocaleString("es-CL", { maximumFractionDigits: 2 });
  const lines = [`Inventario filtrado: ${totals.matched_products} SKU; ${num(totals.available_units)} unidades disponibles registradas. Totales sobre todas las coincidencias, no solo esta pagina.`];
  for (const c of totals.by_currency as Row[]) {
    if (c.cost_reference != null) lines.push(`Costo ${c.currency}: ${num(c.cost_reference)}${Number(c.conditional_cost_products) > 0 ? ` referencial, incluye ${num(c.cost_conditional)} con moneda pendiente (supone ${c.currency}). Parte con moneda confirmada: ${num(c.cost_verified)}` : " registrado"}.`);
    if (c.net_sale_value != null) lines.push(`Venta potencial neta ${c.currency}: ${num(c.net_sale_value)}. No son ventas realizadas ni caja.`);
  }
  const dates = data.source_dates as Row;
  lines.push(`Fuentes guardadas en el CRM: ${dates.oldest || "sin fecha"} a ${dates.newest || "sin fecha"}. No es stock en vivo ni el saldo contable de existencias.`);
  return lines.join("\n\n");
}
