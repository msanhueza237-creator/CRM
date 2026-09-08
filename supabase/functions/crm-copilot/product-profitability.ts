import { CopilotDataError, object, type Row } from "./contracts.ts";
import { productPrices } from "./product-prices.ts";

const scale = 1000000n;
const fixed = (value: unknown): bigint | null => {
  const text = String(value ?? "");
  if (!/^\d+(?:\.\d{1,6})?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  const result = BigInt(whole) * scale + BigInt(fraction.padEnd(6, "0"));
  return result <= BigInt(Number.MAX_SAFE_INTEGER) ? result : null;
};
const money = (value: bigint) => {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < -BigInt(Number.MAX_SAFE_INTEGER)) throw new CopilotDataError("El escenario excede la precision monetaria admitida.", "INVALID_ARGUMENTS");
  return Number(value) / Number(scale);
};
const percent = (numerator: bigint, denominator: bigint) => denominator > 0n ? Number(numerator * 100000000n / denominator) / 1000000 : null;
const ceilTo = (value: bigint, quantum: bigint) => ((value + quantum - 1n) / quantum) * quantum;

export function productProfitability(details: Row[], catalog: Row[], args: Row, currencies: Record<string, string>, confirmations: Row = {}) {
  for (const key of ["discount_percent", "minimum_margin_percent"]) {
    if (args[key] != null && (fixed(args[key]) === null || Number(args[key]) < 0 || Number(args[key]) > (key === "discount_percent" ? 100 : 99.999999))) throw new CopilotDataError("Porcentaje invalido; admite hasta seis decimales.", "INVALID_ARGUMENTS");
  }
  const prices = productPrices([], details, catalog, args, currencies);
  const records = prices.records.map((price) => {
    const matches = details.filter((r) => String(object(r.payload).sku ?? "").trim().toUpperCase() === price.sku);
    const source = matches.length === 1 ? matches[0] : null;
    const raw = object(source?.payload);
    const identityValid = source && (raw.product_id == null || String(raw.product_id) === String(source.external_id));
    const cost = identityValid ? object(raw.cost) : {};
    const c = fixed(cost.value), p = fixed(price.net);
    const confirmed = object(confirmations[String(price.sku)]);
    const confirmationValid = cost.currency_id == null && identityValid && String(confirmed.source_product_id) === String(source?.external_id) && fixed(confirmed.recorded_unit_cost) === c && /^[A-Z]{3}$/.test(String(confirmed.currency)) && !!confirmed.confirmed_at;
    const costCurrency = currencies[String(cost.currency_id ?? "")] || (confirmationValid ? String(confirmed.currency) : null);
    // Missing currency is only a conditional simulation, never a verified conversion or authorized floor.
    const conditional = !costCurrency && cost.currency_id == null && !!price.currency;
    const compatible = costCurrency === price.currency || conditional;
    const available = p !== null && p > 0n && c !== null && c > 0n && compatible && !!price.currency && price.match_type !== "approximate_name";
    const quantum = price.currency === "CLP" ? scale : 10000n;
    const minMargin = args.minimum_margin_percent == null ? null : fixed(args.minimum_margin_percent);
    const targetPrice = available && minMargin !== null ? ceilTo((c! * 100n * scale + (100n * scale - minMargin) - 1n) / (100n * scale - minMargin), quantum) : null;
    const discounts = args.discount_percent == null ? [0, 5, 10, 15, 20] : [Number(args.discount_percent)];
    const scenarios = available ? discounts.map((discount) => {
      const rate = fixed(discount)!;
      const sale = p! * (100n * scale - rate) / (100n * scale);
      return { discount_percent: discount, net_price: money(sale), unit_gross_profit: money(sale - c!), gross_margin_percent: percent(sale - c!, sale), below_recorded_cost: sale < c!, meets_requested_margin: minMargin === null ? null : sale * (100n * scale - minMargin) >= c! * 100n * scale };
    }) : [];
    return {
      sku: price.sku, name: price.name, net_price: price.net, price_with_tax: price.total, currency: price.currency, list_id: price.list_id,
      stock: price.stock, stock_updated_at: price.stock_updated_at, price_updated_at: price.price_updated_at,
      recorded_unit_cost: c !== null && c > 0n ? money(c) : null, cost_currency: costCurrency, cost_currency_id: cost.currency_id ?? null,
      cost_source: identityValid ? "facto_product_details.cost.value" : null, cost_updated_at: source?.updated_at || null,
      calculation_status: !available ? "unavailable" : conditional ? "conditional_currency" : confirmationValid ? "user_confirmed_currency" : "source_currency_verified",
      currency_confirmed_at: confirmationValid ? confirmed.confirmed_at : null,
      assumed_cost_currency: available && conditional ? price.currency : null,
      unit_gross_profit: available ? money(p! - c!) : null,
      gross_margin_percent: available ? percent(p! - c!, p!) : null,
      markup_percent: available ? percent(p! - c!, c!) : null,
      recorded_cost_floor: available ? money(ceilTo(c!, quantum)) : null,
      theoretical_discount_to_cost_percent: available && p! >= c! ? percent(p! - c!, p!) : null,
      requested_minimum_margin_percent: args.minimum_margin_percent ?? null,
      net_price_for_requested_margin: targetPrice !== null ? money(targetPrice) : null,
      max_discount_for_requested_margin_percent: targetPrice !== null && targetPrice <= p! ? percent(p! - targetPrice, p!) : null,
      authorized_discount_limit: null,
      scenarios,
      updated_at: price.updated_at,
    };
  });
  return { records, availableLists: prices.availableLists };
}
