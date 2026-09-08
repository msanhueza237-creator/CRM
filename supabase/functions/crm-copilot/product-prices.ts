import { numeric, object, rows, type Row } from "./contracts.ts";
import { findProducts, resolveProducts } from "./product-resolution.ts";

// Same official IDs as the existing Facto connector; deployment overrides remain configurable.
export function factoCurrencies(override?: string): Record<string, string> {
  const result: Record<string, string> = { "5": "USD", "38": "EUR", "39": "CLP" };
  if (!override) return result;
  const custom = object(JSON.parse(override));
  for (const [id, code] of Object.entries(custom)) {
    if (!/^\d+$/.test(id) || typeof code !== "string" || !/^[A-Z]{3}$/.test(code)) throw new Error("Mapeo de moneda Facto invalido.");
    result[id] = code;
  }
  return result;
}

export function productPrices(snapshots: Row[], details: Row[], catalog: Row[], args: Row, currencies: Record<string, string>) {
  const products = findProducts(resolveProducts(snapshots, details, catalog, false), args.scope === "catalog" ? null : args.query);
  const result: Row[] = [];
  const availableLists = new Set<string>();
  for (const product of products) {
    const source = details.filter((r) => String(r.external_id) === String(product.id));
    const raw = object(source[0]?.payload);
    const ambiguous = details.filter((r) => String(object(r.payload).sku ?? "").trim().toUpperCase() === product.sku).length !== 1;
    const idMismatch = raw.product_id != null && String(raw.product_id) !== String(product.id);
    const prices = ambiguous || idMismatch ? [] : rows(raw.price);
    const filtered = prices.filter((price) => !args.list_id || String(price.product_price_list_id) === String(args.list_id));
    const values = filtered.length ? filtered : [{}];
    for (const price of values) {
      const listId = price.product_price_list_id == null ? null : String(price.product_price_list_id);
      if (listId) availableLists.add(listId);
      const currencyId = String(price.currency_id ?? "");
      const duplicate = listId && filtered.filter((p) => String(p.product_price_list_id) === listId && String(p.currency_id) === currencyId).length > 1;
      const net = duplicate ? null : numeric(price.unit_net);
      const currency = currencies[currencyId] || null;
      result.push({
        sku: product.sku, name: product.name, stock: product.stock, stock_known: product.stock_known,
        stock_source: product.stock_source, stock_updated_at: product.stock_updated_at,
        net: net !== null && net >= 0 ? net : null,
        tax: numeric(price.unit_tax), total: numeric(price.unit_total),
        list_id: listId, currency_id: price.currency_id ?? null, currency,
        price_source: net !== null ? "facto_product_details" : null,
        price_updated_at: source[0]?.updated_at || null,
        updated_at: source[0]?.updated_at || product.updated_at,
        match_type: product.match_type || "exact_terms",
      });
    }
  }
  return { products, records: result.sort((a, b) => String(a.name).localeCompare(String(b.name), "es")), availableLists: [...availableLists].sort() };
}

export function clientPriceRows(records: Row[], includePending = false): Row[] {
  if (includePending) return records.filter((p) => typeof p.stock === "number" && p.stock > 0 && p.stock_updated_at && p.match_type !== "approximate_name")
    .map((p) => ({ sku: p.sku, name: p.name, net: typeof p.net === "number" && p.net > 0 && p.currency && p.list_id && p.price_updated_at ? p.net : null, stock: p.stock, currency: p.currency || null, list_id: p.list_id, stock_updated_at: p.stock_updated_at, price_updated_at: p.price_updated_at }));
  return records.filter((p) => typeof p.stock === "number" && p.stock > 0 && typeof p.net === "number" && p.net > 0 && p.currency && p.list_id && p.stock_updated_at && p.price_updated_at && p.match_type !== "approximate_name")
    .map((p) => ({ sku: p.sku, name: p.name, net: p.net, stock: p.stock, currency: p.currency, list_id: p.list_id, stock_updated_at: p.stock_updated_at, price_updated_at: p.price_updated_at }));
}
