import { normalized, object, rows, type Row } from "./contracts.ts";
import { inRange } from "./dates.ts";
import { findProducts } from "./product-resolution.ts";

const key = (value: unknown) => normalized(value).replace(/[^a-z0-9]+/g, " ").trim();
const header = (record: Row) => ({ ...record, ...object(record.header) });
const fixed = (value: unknown): bigint | null => {
  const text = String(value ?? "");
  if (!/^\d{1,15}(?:\.\d{1,6})?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  const result = BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, "0"));
  return result <= BigInt(Number.MAX_SAFE_INTEGER) ? result : null;
};
const amount = (value: bigint) => Number(value) / 1000000;
const signed = (value: unknown): bigint | null => {
  const text = String(value ?? "0"), result = fixed(text.replace(/^-/, ""));
  return result === null ? null : text.startsWith("-") ? -result : result;
};
const sum = (values: bigint[]) => values.reduce((a, b) => a + b, 0n);
const abs = (n: bigint) => n < 0n ? -n : n;

// Largest remainders preserve the invoice total, including CLP rounding and fixed global discounts.
function allocate(total: bigint, weights: bigint[]): bigint[] | null {
  const base = sum(weights);
  if (base === 0n) return total === 0n ? weights.map(() => 0n) : null;
  const shares = weights.map(w => total * w / base);
  const order = weights.map((w, i) => ({ i, remainder: total * w % base })).sort((a, b) => a.remainder === b.remainder ? a.i - b.i : a.remainder > b.remainder ? -1 : 1);
  const remaining = total - sum(shares);
  for (let i = 0; i < Number(remaining); i++) shares[order[i].i]++;
  return shares;
}

function invoiceLineNets(lines: Row[], detail: Row, h: Row, currency: string | null): bigint[] | null {
  if (!currency || detail.sale_xml_status === "invalid") return null;
  const quantum = currency === "CLP" ? 1000000n : 10000n;
  const expected = fixed(h.net_amount ?? object(detail.totals).net_amount);
  const detailNet = fixed(object(detail.totals).net_amount);
  if (expected === null || expected % quantum !== 0n || (detailNet !== null && abs(expected - detailNet) > quantum)) return null;
  const nets: bigint[] = [];
  for (const line of lines) {
    const quantity = fixed(line.quantity), price = fixed(line.unit_price);
    const adjustment = signed(line.modifier_amount), percentage = signed(line.modifier_percentage);
    if (quantity === null || quantity <= 0n || price === null || adjustment === null || percentage === null || (adjustment !== 0n && percentage !== 0n)) return null;
    const base = (quantity * price + 500000n) / 1000000n;
    const computed = base + (percentage !== 0n ? base * percentage / 100000000n : adjustment);
    const xmlNet = detail.sale_xml_status === "verified" ? fixed(line.validated_xml_line_net) : null;
    if (xmlNet !== null && abs(xmlNet - computed) > quantum) return null;
    const net = xmlNet ?? computed;
    if (net < 0n || net > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    nets.push(net);
  }
  const raw = detail.global_modifiers;
  const modifiers = raw == null ? [] : Array.isArray(raw) ? raw : [raw];
  for (const value of modifiers) {
    const modifier = object(value), adjustment = fixed(modifier.value);
    // Facto DA/RA apply to taxable lines only. Unknown or exempt scopes remain unverified.
    if (!["DA", "RA"].includes(String(modifier.modifier_type)) || !["%", "$"].includes(String(modifier.value_type)) || adjustment === null || lines.some(l => !["0", "1"].includes(String(l.vat_status)))) return null;
    const indexes = lines.flatMap((l, i) => String(l.vat_status) === "1" ? [i] : []);
    const weights = indexes.map(i => nets[i]), base = sum(weights);
    if (!indexes.length || base === 0n) return null;
    const discount = modifier.modifier_type === "DA";
    if (discount && modifier.value_type === "%" && adjustment > 100000000n) return null;
    const delta = modifier.value_type === "%" ? (base * adjustment + 50000000n) / 100000000n : adjustment;
    const target = base + (discount ? -delta : delta);
    if (target < 0n) return null;
    const adjusted = allocate(target, weights);
    if (!adjusted) return null;
    indexes.forEach((index, i) => { nets[index] = adjusted[i]; });
  }
  // Never fill missing sales with catalog prices/costs or force a material discrepancy to reconcile.
  if (abs(sum(nets) - expected) > quantum) return null;
  const allocated = allocate(expected / quantum, nets);
  return allocated?.map(n => n * quantum) ?? null;
}

// Invoice lines are evidence of sales, not stock changes or cash receipts.
export function productSales(documents: Row[], details: Row[], products: Row[], query: unknown, range: { from: string; to: string }, currencies: Record<string, string>, grouping: unknown = "product") {
  const catalogMatches = new Set(findProducts(products, query).map((p) => p.sku));
  const exactIdentity = !!query && (/https?:\/\//i.test(String(query)) || products.some((p) => key(p.sku) === key(query) || (/\d/.test(String(query)) && key(p.sku).replace(/ /g, "") === key(query).replace(/ /g, ""))));
  const groups = new Map<string, { row: Row; units: bigint; net: bigint; documents: Set<string>; revenueKnown: boolean }>();
  const problems: Row[] = [];
  const eligible = documents.filter((r) => {
    const h = header(r);
    return String(h.received_issued_flag) === "1" && ["33", "34", "39", "41", "56", "61"].includes(String(h.document_type_taxbureau)) && inRange(h.issue_date, range);
  });
  const seen = new Set<string>();
  let processed = 0;
  for (const document of eligible) {
    const h = header(document);
    const id = String(document.external_id);
    if (seen.has(id)) continue;
    seen.add(id);
    const candidates = details.filter((d) => String(d.external_id) === id);
    const detail = candidates[0];
    const lines = rows(detail?.details);
    const ref = { external_id: id, folio: h.document_number, date: h.issue_date, type: h.document_type_taxbureau };
    if (String(h.document_status) !== "1" || candidates.length !== 1 || !lines.length) {
      problems.push({ ...ref, problem: "Documento sin detalle unico o estado valido" }); continue;
    }
    const dh = header(detail);
    if ((dh.document_id != null && String(dh.document_id) !== id) || (dh.received_issued_flag != null && String(dh.received_issued_flag) !== "1") || (dh.document_type_taxbureau != null && String(dh.document_type_taxbureau) !== String(h.document_type_taxbureau))) {
      problems.push({ ...ref, problem: "Detalle con identidad o direccion inconsistente" }); continue;
    }
    const rutKey = (value: unknown) => normalized(value).replace(/[^a-z0-9]/g, "");
    if ((dh.document_number != null && h.document_number != null && String(dh.document_number) !== String(h.document_number)) || (dh.receiver_tax_id_code && h.receiver_tax_id_code && rutKey(dh.receiver_tax_id_code) !== rutKey(h.receiver_tax_id_code))) {
      problems.push({ ...ref, problem: "Folio o receptor inconsistente entre documento y detalle" }); continue;
    }
    if (dh.issuer_tax_id_code && h.issuer_tax_id_code && rutKey(dh.issuer_tax_id_code) !== rutKey(h.issuer_tax_id_code)) {
      problems.push({ ...ref, problem: "Emisor inconsistente entre documento y detalle" }); continue;
    }
    const buyer = { customer: h.receiver_legal_name || dh.receiver_legal_name || null, tax_id: h.receiver_tax_id_code || dh.receiver_tax_id_code || null };
    // Credit/debit notes can correct text, amounts or annul a document. Never assume a quantity reversal.
    if (["56", "61"].includes(String(h.document_type_taxbureau))) {
      problems.push({ ...ref, problem: "Nota de credito/debito pendiente de asignacion por producto" }); continue;
    }
    processed++;
    const currency = currencies[String(h.currency_id)] || null;
    const units = lines.map((l) => fixed(l.quantity));
    const lineNets = dh.currency_id != null && String(dh.currency_id) !== String(h.currency_id) ? null : invoiceLineNets(lines, detail, h, currency);
    const revenueKnown = lineNets !== null;
    if (!revenueKnown) problems.push({ ...ref, problem: "Importes o descuentos de lineas no conciliados con el neto documental" });
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const description = String(line.line_description || "");
      const text = key(description);
      const xmlSku = detail.sale_xml_status === "verified" ? String(line.validated_xml_sku || "").trim().toUpperCase() : "";
      const linked = products.filter((p) => xmlSku ? String(p.sku).trim().toUpperCase() === xmlSku : key(p.name) === text || (Array.isArray(p.aliases) && p.aliases.some((a) => key(a) === text)));
      const product = linked.length === 1 ? linked[0] : xmlSku ? { sku: xmlSku, name: description } : null;
      if (query && (product ? !catalogMatches.has(product.sku) : exactIdentity || !findProducts([{ name: description + " " + String(line.long_description || "") }], query).length)) continue;
      if (!description || units[i] === null || units[i]! <= 0n) { problems.push({ ...ref, line: i + 1, problem: "Cantidad o descripcion no verificable" }); continue; }
      const period = grouping === "month" ? String(h.issue_date).slice(0, 7) : grouping === "year" ? String(h.issue_date).slice(0, 4) : `${range.from} / ${range.to}`;
      const groupKey = `${product?.sku || "description:" + text}|${currency || "unknown"}|${period}`;
      if (!groups.has(groupKey)) groups.set(groupKey, { row: { period, sku: product?.sku || null, name: product?.name || description, currency, identity: xmlSku ? "SKU del XML de Facto" : product ? "SKU por nombre exacto" : "Descripcion documental, SKU no confirmado", evidence: [], updated_at: detail.updated_at }, units: 0n, net: 0n, documents: new Set(), revenueKnown: true });
      const group = groups.get(groupKey)!;
      group.units += units[i]!;
      group.documents.add(id);
      group.revenueKnown &&= revenueKnown;
      group.net += lineNets?.[i] ?? 0n;
      (group.row.evidence as Row[]).push({ ...ref, ...buyer, line: i + 1, quantity: amount(units[i]!), unit_sale_price: line.unit_price,
        line_modifier_amount: line.modifier_amount ?? null, global_modifiers: detail.global_modifiers ?? null, xml_validation: detail.sale_xml_status ?? null,
        net: lineNets ? amount(lineNets[i]) : null, net_validation: revenueKnown ? "Precio de venta por unidades con ajustes; descuentos globales prorrateados y neto documental conciliado" : !currency ? "Moneda desconocida" : "Importe o descuento no conciliado con documento" });
    }
  }
  return {
    records: [...groups.values()].map<Row>((g) => ({ ...g.row, units_sold: amount(g.units), net_sales: g.revenueKnown ? amount(g.net) : null,
      average_net_unit_price: g.revenueKnown && g.units > 0n ? amount(g.net * 1000000n / g.units) : null, document_count: g.documents.size })),
    coverage: { documents_found: seen.size, documents_processed: processed, problems },
  };
}
