import { normalized, numeric, object, type Row, rows } from "./contracts.ts";

const skuKey = (value: unknown) => String(value ?? "").trim().toUpperCase();
const stopWords = new Set(
  "de del la las el los un una unos unas en para con y por que cuanto cuanta cuantos cuantas tenemos hay stock sctoc disponible disponibles disponibilidad existencia existencias producto productos dime"
    .split(" "),
);
const words = (value: unknown) => normalized(value).match(/[a-z0-9]+/g) || [];
const singular = (word: string) =>
  word === "gases"
    ? "gas"
    : word.endsWith("ores")
    ? word.slice(0, -2)
    : word.length > 3 && word.endsWith("s")
    ? word.slice(0, -1)
    : word;

export function catalogUrl(value: unknown): string | null {
  try {
    const url = new URL(String(value));
    if (
      !["http:", "https:"].includes(url.protocol) || url.username ||
      url.password || url.port
    ) return null;
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (host !== "climactiva.cl" || !url.pathname.startsWith("/productos/")) {
      return null;
    }
    return host +
      decodeURIComponent(url.pathname).replace(/\/+$/, "").toLowerCase();
  } catch {
    return null;
  }
}

// Limited typo tolerance applies only to descriptive words, never model numbers or SKUs.
function oneEdit(a: string, b: string): boolean {
  if (
    a.length < 5 || b.length < 5 || /\d/.test(a + b) ||
    Math.abs(a.length - b.length) > 1
  ) return false;
  let i = 0, j = 0, errors = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++errors > 1) return false;
    if (a.length >= b.length) i++;
    if (b.length >= a.length) j++;
  }
  return errors + (i < a.length || j < b.length ? 1 : 0) <= 1;
}

export function findProducts(products: Row[], query: unknown): Row[] {
  const text = String(query ?? "").trim();
  if (!text) return products;
  const urls = text.match(/https?:\/\/[^\s<>]+/gi);
  if (urls?.length) {
    const keys = urls.map(catalogUrl).filter(Boolean);
    return products.filter((p) =>
      rows(p.catalog_links).some((link) => keys.includes(catalogUrl(link.url)))
    );
  }
  const compact = (value: unknown) => skuKey(value).replace(/[^A-Z0-9]/g, "");
  const exact = products.filter((p) =>
    skuKey(p.sku) === skuKey(text) ||
    (/\d/.test(text) && compact(p.sku) === compact(text))
  );
  if (exact.length) return exact;
  if (!words(text).length) return [];
  const tokens = words(text).filter((word) => !stopWords.has(word));
  if (!tokens.length) return products;
  const match = (p: Row, fuzzy: boolean) => {
    const names = [
      p.name,
      ...(Array.isArray(p.aliases) ? p.aliases : []),
      p.sku,
    ];
    const candidates = words(names.join(" ")).map(singular);
    return tokens.every((token) =>
      candidates.some((candidate) => {
        const term = singular(token);
        return candidate === term || (fuzzy && oneEdit(term, candidate));
      })
    );
  };
  const precise = products.filter((p) => match(p, false));
  return precise.length
    ? precise
    : products.filter((p) => match(p, true)).map((p) => ({
      ...p,
      match_type: "approximate_name",
    }));
}

export function locationStock(payload: Row) {
  const inventory = object(payload.inventories);
  const details = rows(inventory.details);
  const warnings: string[] = [];
  const locations: Row[] = [];
  if (!details.length) {
    return { present: false, stock: null, locations, warnings };
  }
  const seen = new Set<string>();
  let total = 0n;
  for (const detail of details) {
    const id = String(detail.product_location_id ?? "").trim();
    const value = String(detail.available_quantity ?? "").trim();
    if (!id || seen.has(id) || !/^-?\d+(?:\.\d{1,6})?$/.test(value)) {
      warnings.push(
        "Detalle de bodegas incompleto o repetido; cantidad pendiente de verificacion.",
      );
      return { present: true, stock: null, locations: [], warnings };
    }
    seen.add(id);
    const [whole, fraction = ""] = value.replace("-", "").split(".");
    total += (BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, "0"))) *
      (value.startsWith("-") ? -1n : 1n);
    locations.push({ location_id: id, available: numeric(value) });
  }
  if (
    total > BigInt(Number.MAX_SAFE_INTEGER) ||
    total < -BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    return {
      present: true,
      stock: null,
      locations: [],
      warnings: ["Cantidad fuera de rango; requiere revision."],
    };
  }
  const stock = Number(total) / 1000000;
  const aggregate = numeric(inventory.total_available);
  if (aggregate !== null && aggregate !== stock) {
    warnings.push(
      "El total agregado de Facto difiere del detalle de bodegas; se informa la suma verificable de available_quantity por bodega.",
    );
  }
  return { present: true, stock, locations, warnings };
}

export function resolveProducts(
  snapshots: Row[],
  details: Row[],
  catalog: Row[],
  finance: boolean,
): Row[] {
  const groups = new Map<
    string,
    { snapshots: Row[]; details: Row[]; catalog: Row[] }
  >();
  const add = (kind: "snapshots" | "details" | "catalog", record: Row) => {
    const payload = kind === "catalog" ? record : object(record.payload);
    const sku = skuKey(payload.sku);
    if (!sku) return;
    if (!groups.has(sku)) {
      groups.set(sku, { snapshots: [], details: [], catalog: [] });
    }
    groups.get(sku)![kind].push(record);
  };
  snapshots.forEach((r) => add("snapshots", r));
  details.forEach((r) => add("details", r));
  catalog.forEach((r) => add("catalog", r));
  return [...groups.entries()].map(([sku, group]) => {
    const warnings: string[] = [];
    const sorted = (values: Row[]) =>
      [...values].sort((a, b) =>
        String(b.updated_at).localeCompare(String(a.updated_at))
      );
    const snapshot = sorted(group.snapshots)[0];
    const detail = sorted(group.details)[0];
    const p = object(detail?.payload);
    const duplicate = new Set(group.details.map((r) =>
          String(r.external_id)
        )).size > 1 || group.snapshots.length > 1;
    const badId = Boolean(
      detail && p.product_id != null &&
        String(p.product_id) !== String(detail.external_id),
    );
    const rawSnapshot = object(snapshot?.payload);
    const wrongSnapshot = Boolean(
      detail && rawSnapshot.source_product_id != null &&
        String(rawSnapshot.source_product_id) !== String(detail.external_id),
    );
    const s = wrongSnapshot ? {} : rawSnapshot;
    if (wrongSnapshot) {
      warnings.push(
        "Resumen descartado: su ID Facto no corresponde al detalle del SKU.",
      );
    }
    if (duplicate || badId) {
      warnings.push(
        "Identidad Facto ambigua o inconsistente; no se suman productos con el mismo SKU.",
      );
    }
    const direct = locationStock(p);
    warnings.push(...direct.warnings);
    const snapshotStock = s.stock_known === true
      ? numeric(s.available_units)
      : null;
    const stock = duplicate || badId
      ? null
      : direct.present
      ? direct.stock
      : snapshotStock;
    const stockSource = stock === null
      ? null
      : direct.present
      ? "facto_product_details"
      : "facto_inventory_snapshot";
    const stockAt = stock === null
      ? null
      : direct.present
      ? detail?.updated_at
      : snapshot?.updated_at;
    if (
      direct.stock !== null && snapshotStock !== null &&
      direct.stock !== snapshotStock
    ) {
      warnings.push(
        "Resumen y detalle de inventario difieren; se conserva la cantidad y fecha del detalle de bodegas.",
      );
    }
    const safeSnapshot = duplicate || badId ? {} : s;
    return {
      id: detail?.external_id || snapshot?.external_id || group.catalog[0]?.id,
      sku,
      name: p.name || rawSnapshot.name || group.catalog[0]?.name,
      aliases: group.catalog.map((c) => c.name),
      catalog_links: group.catalog.filter((c) => catalogUrl(c.product_url)).map(
        (c) => ({ url: c.product_url, observed_at: c.last_synced_at }),
      ),
      stock,
      stock_known: stock !== null,
      stock_source: stockSource,
      stock_updated_at: stockAt || null,
      warehouse_stock: stockSource === "facto_product_details"
        ? direct.locations
        : [],
      stock_warnings: warnings,
      price: safeSnapshot.price_known === true
        ? numeric(safeSnapshot.unit_price)
        : null,
      currency: safeSnapshot.price_currency_code || null,
      price_is_net: safeSnapshot.unit_price_is_net ?? null,
      units_sold: safeSnapshot.sales_history_available === true
        ? numeric(safeSnapshot.units_sold_observed)
        : null,
      sales_from: safeSnapshot.sales_history_start || null,
      sales_to: safeSnapshot.sales_history_end || null,
      last_sale_at: safeSnapshot.last_sale_at || null,
      updated_at: stockAt || detail?.updated_at || snapshot?.updated_at ||
        group.catalog[0]?.last_synced_at,
      ...(finance
        ? {
          unit_cost: safeSnapshot.cost_known === true
            ? numeric(safeSnapshot.unit_cost_source)
            : null,
          cost_currency: safeSnapshot.cost_currency_code || null,
          margin_percent: numeric(safeSnapshot.margin_percent),
        }
        : {}),
    };
  });
}
